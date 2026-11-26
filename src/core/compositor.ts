import type { GradeParams, Raster } from './types';
import { clamp, createRaster } from './imageUtils';

export interface CompositeLayer extends Raster {
  frameIndex: number;
  timestamp: number;
}

export interface CompositeOptions {
  /** 最早一层的不透明度(0..1),最晚一层恒为 1,中间线性插值 */
  earliestOpacity?: number;
  grade?: GradeParams;
}

/** 颜色分级 LUT:亮度/对比度/gamma 的明度映射(饱和度在合成时按灰度差处理) */
export function buildGradeLUT(g: GradeParams): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256 * 3);
  const brightness = g.brightness * 64;
  const c = g.contrast;
  const slope = 1 + c;
  const intercept = 128 * (1 - slope);
  const invGamma = Math.max(0.01, g.gamma); // gamma<1 提亮,直接作指数
  for (let v = 0; v < 256; v++) {
    const t = Math.pow(clamp((v * slope + intercept + brightness) / 255, 0, 1), invGamma) * 255;
    lut[v * 3] = clamp(t, 0, 255);
    lut[v * 3 + 1] = clamp(t, 0, 255);
    lut[v * 3 + 2] = clamp(t, 0, 255);
  }
  return lut;
}

function applyGrade(r: number, g: number, b: number, lut: Uint8ClampedArray, sat: number): [number, number, number] {
  const r2 = lut[r * 3];
  const g2 = lut[g * 3 + 1];
  const b2 = lut[b * 3 + 2];
  const gray2 = 0.299 * r2 + 0.587 * g2 + 0.114 * b2;
  const s = 1 + sat;
  return [
    clamp(gray2 + (r2 - gray2) * s, 0, 255),
    clamp(gray2 + (g2 - gray2) * s, 0, 255),
    clamp(gray2 + (b2 - gray2) * s, 0, 255),
  ];
}

/**
 * 参考 CPU 合成:
 * 1. 图层按 frameIndex 升序,越早越先绘制(被后者压住),遮挡顺序确定;
 * 2. 第 i 层整体不透明度 = lerp(earliestOpacity, 1, i/(n-1)),实现"越早越淡";
 * 3. 统一调色 LUT,保证各层亮度/对比度一致。
 */
export function compositeLayers(
  background: Raster,
  layers: CompositeLayer[],
  opts: CompositeOptions = {},
): Raster & { data: Uint8ClampedArray } {
  const w = background.width;
  const h = background.height;
  const out = createRaster(w, h);
  const bd = background.data;
  const od = out.data;
  od.set(bd);

  const sorted = [...layers].sort((a, b) => a.frameIndex - b.frameIndex);
  const n = sorted.length;
  const earliest = opts.earliestOpacity ?? 0.45;
  const grade = opts.grade ?? { brightness: 0, contrast: 0, saturation: 0, gamma: 1 };
  const lut = buildGradeLUT(grade);
  const npx = w * h;

  for (let li = 0; li < n; li++) {
    const layer = sorted[li];
    const layerScale = n <= 1 ? 1 : earliest + (1 - earliest) * (li / (n - 1));
    const ld = layer.data;
    for (let p = 0; p < npx; p++) {
      const o = p * 4;
      const a = (ld[o + 3] / 255) * layerScale;
      if (a <= 0) continue;
      const [fr, fg, fb] = applyGrade(ld[o], ld[o + 1], ld[o + 2], lut, grade.saturation);
      const ia = 1 - a;
      od[o] = Math.round(fr * a + od[o] * ia);
      od[o + 1] = Math.round(fg * a + od[o + 1] * ia);
      od[o + 2] = Math.round(fb * a + od[o + 2] * ia);
    }
  }
  return out;
}

/** 仅调色(背景一致性预览用) */
export function gradeRaster(src: Raster, grade: GradeParams): Raster & { data: Uint8ClampedArray } {
  const lut = buildGradeLUT(grade);
  const out = createRaster(src.width, src.height);
  const npx = src.width * src.height;
  for (let p = 0; p < npx; p++) {
    const o = p * 4;
    const [r, g, b] = applyGrade(src.data[o], src.data[o + 1], src.data[o + 2], lut, grade.saturation);
    out.data[o] = r;
    out.data[o + 1] = g;
    out.data[o + 2] = b;
    out.data[o + 3] = src.data[o + 3];
  }
  return out;
}
