import type { GradeParams, Raster } from '../core/types';
import { clamp } from '../core/imageUtils';

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = vec2(aPos.x * 0.5 + 0.5, aPos.y * 0.5 + 0.5);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform sampler2D uLut;
uniform float uOpacity;
uniform float uSaturation;
uniform float uApplyGrade;
out vec4 outColor;
void main() {
  vec4 src = texture(uTex, vUv);
  if (uApplyGrade > 0.5) {
    float r = texture(uLut, vec2(src.r, 0.5)).r;
    float g = texture(uLut, vec2(src.g, 0.5)).g;
    float b = texture(uLut, vec2(src.b, 0.5)).b;
    float gray = 0.299 * r + 0.587 * g + 0.114 * b;
    src.rgb = clamp(gray + (vec3(r, g, b) - gray) * (1.0 + uSaturation), 0.0, 1.0);
  }
  outColor = vec4(src.rgb, src.a * uOpacity);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error('着色器编译失败: ' + gl.getShaderInfoLog(sh));
  }
  return sh;
}

export interface GLLayer {
  raster: Raster;
  /** 时间序淡化系数 0..1(越早越小) */
  fade: number;
}

/**
 * WebGL2 多层合成:
 * 按图层数组顺序(已按时间升序)依次 over 混合,天然保证遮挡顺序;
 * 每层乘 fade 统一量;调色 LUT + 饱和度在同一 shader 完成。
 */
export class GLCompositor {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private textures: WebGLTexture[] = [];
  private lutTex: WebGLTexture;
  private uTex: WebGLUniformLocation;
  private uLut: WebGLUniformLocation;
  private uOpacity: WebGLUniformLocation;
  private uSat: WebGLUniformLocation;
  private uGrade: WebGLUniformLocation;
  private canvas: HTMLCanvasElement;
  private width = 0;
  private height = 0;

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: false, alpha: false });
    if (!gl) throw new Error('当前浏览器不支持 WebGL2');
    this.gl = gl;
    this.canvas = canvas;
    const vs = compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('着色器链接失败: ' + gl.getProgramInfoLog(prog));
    }
    this.program = prog;
    gl.useProgram(prog);
    this.uTex = gl.getUniformLocation(prog, 'uTex')!;
    this.uLut = gl.getUniformLocation(prog, 'uLut')!;
    this.uOpacity = gl.getUniformLocation(prog, 'uOpacity')!;
    this.uSat = gl.getUniformLocation(prog, 'uSaturation')!;
    this.uGrade = gl.getUniformLocation(prog, 'uApplyGrade')!;

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    this.lutTex = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.uniform1i(this.uLut, 1);
    gl.uniform1i(this.uTex, 0);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  private uploadTexture(raster: Raster): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      raster.width,
      raster.height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      raster.data as Uint8Array,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  setGradeLUT(grade: GradeParams): void {
    const gl = this.gl;
    const lut = new Uint8Array(256 * 3);
    const brightness = grade.brightness * 64;
    const slope = 1 + grade.contrast;
    const intercept = 128 * (1 - slope);
    const gamma = Math.max(0.01, grade.gamma);
    for (let i = 0; i < 256; i++) {
      const v = clamp(Math.pow(clamp((i * slope + intercept + brightness) / 255, 0, 1), gamma) * 255, 0, 255);
      lut[i * 3] = v;
      lut[i * 3 + 1] = v;
      lut[i * 3 + 2] = v;
    }
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB8, 256, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, lut);
    gl.uniform1f(this.uSat, clamp(grade.saturation, -1, 1));
  }

  private drawTex(tex: WebGLTexture, opacity: number, graded: boolean): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1f(this.uOpacity, opacity);
    gl.uniform1f(this.uGrade, graded ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** 背景 + 图层(按时间升序)一次性合成到 canvas */
  render(background: Raster, layers: GLLayer[], grade: GradeParams): void {
    const gl = this.gl;
    if (this.canvas.width !== background.width || this.canvas.height !== background.height) {
      this.canvas.width = background.width;
      this.canvas.height = background.height;
      this.width = background.width;
      this.height = background.height;
    }
    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.setGradeLUT(grade);
    this.textures.forEach((t) => gl.deleteTexture(t));
    this.textures = [];

    const bgTex = this.uploadTexture(background);
    this.drawTex(bgTex, 1, false);
    gl.deleteTexture(bgTex);

    for (const layer of layers) {
      const tex = this.uploadTexture(layer.raster);
      this.textures.push(tex);
      this.drawTex(tex, clamp(layer.fade, 0, 1), true);
    }
  }

  readPixels(): ImageData {
    const gl = this.gl;
    const px = new Uint8Array(this.width * this.height * 4);
    gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
    // GL 原点在左下,翻转回上左
    const flipped = new Uint8ClampedArray(px.length);
    const row = this.width * 4;
    for (let y = 0; y < this.height; y++) {
      flipped.set(px.subarray((this.height - 1 - y) * row, (this.height - y) * row), y * row);
    }
    return new ImageData(flipped, this.width, this.height);
  }

  dispose(): void {
    const gl = this.gl;
    this.textures.forEach((t) => gl.deleteTexture(t));
    gl.deleteTexture(this.lutTex);
    gl.deleteProgram(this.program);
    gl.deleteVertexArray(this.vao);
  }
}
