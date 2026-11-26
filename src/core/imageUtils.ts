import type { Raster } from './types';

export function createRaster(width: number, height: number): Raster & { data: Uint8ClampedArray } {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

export function idx(x: number, y: number, width: number): number {
  return (y * width + x) * 4;
}

/** RGB565 打包:每像素每样本 2 字节,误差 R/B ±4、G ±2 */
export function pack565(r: number, g: number, b: number): number {
  return ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
}

export function unpack565(v: number, out: [number, number, number]): void {
  out[0] = ((v >> 11) & 31) << 3;
  out[1] = ((v >> 5) & 63) << 2;
  out[2] = (v & 31) << 3;
}

/** RGB332:256 桶,用于众数直方图 */
export function toBin332(r: number, g: number, b: number): number {
  return ((r >> 5) << 5) | ((g >> 5) << 2) | (b >> 6);
}

export function pack565ToBin332(v: number): number {
  const r = (v >> 11) & 31;
  const g = (v >> 5) & 63;
  const b = v & 31;
  return (r >> 2 << 5) | (g >> 3 << 2) | (b >> 3);
}

/** 加权欧氏色差(平方),阈值比较用平方即可,避免 sqrt */
export function colorDistSq(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return 0.3 * dr * dr + 0.59 * dg * dg + 0.11 * db * db;
}

/** 最近邻降采样,输出等比例缩小的光栅 */
export function downsample(src: Raster, dstWidth: number, dstHeight: number): Raster & { data: Uint8ClampedArray } {
  const dst = createRaster(dstWidth, dstHeight);
  const sx = src.width / dstWidth;
  const sy = src.height / dstHeight;
  for (let y = 0; y < dstHeight; y++) {
    const srcRow = Math.min(src.height - 1, Math.floor(y * sy));
    for (let x = 0; x < dstWidth; x++) {
      const srcX = Math.min(src.width - 1, Math.floor(x * sx));
      const si = (srcRow * src.width + srcX) * 4;
      const di = (y * dstWidth + x) * 4;
      dst.data[di] = src.data[si];
      dst.data[di + 1] = src.data[si + 1];
      dst.data[di + 2] = src.data[si + 2];
      dst.data[di + 3] = 255;
    }
  }
  return dst;
}

/** Float alpha 平面的盒式模糊(羽化用),两遍分离 */
export function boxBlurAlpha(alpha: Float32Array, w: number, h: number, radius: number): Float32Array {
  if (radius <= 0) return alpha;
  const r = Math.round(radius);
  const tmp = new Float32Array(alpha.length);
  const out = new Float32Array(alpha.length);
  // 水平
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let x = -r; x <= r; x++) sum += alpha[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum / (2 * r + 1);
      const xAdd = Math.min(w - 1, x + r + 1);
      const xSub = Math.max(0, x - r);
      sum += alpha[row + xAdd] - alpha[row + xSub];
    }
  }
  // 垂直
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / (2 * r + 1);
      const yAdd = Math.min(h - 1, y + r + 1) * w + x;
      const ySub = Math.max(0, y - r) * w + x;
      sum += tmp[yAdd] - tmp[ySub];
    }
  }
  return out;
}

/** 二值支持域膨胀(半径 1,棋盘格 8 邻域) */
export function dilateBinary(mask: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  if (radius <= 0) return mask;
  const out = new Uint8Array(mask.length);
  const r = Math.round(radius);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!mask[i]) continue;
      for (let dy = -r; dy <= r; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -r; dx <= r; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          out[ny * w + nx] = 1;
        }
      }
    }
  }
  return out;
}

export interface ComponentInfo {
  labels: Int32Array;
  count: number;
  sizes: number[];
  /** 每组件包围盒 [minX, minY, maxX, maxY] */
  boxes: Int32Array[];
}

/** 4 邻域连通域标记(1 标号起步,0 为背景) */
export function labelComponents(mask: Uint8Array, w: number, h: number): ComponentInfo {
  const labels = new Int32Array(w * h);
  const sizes: number[] = [0];
  const boxes: Int32Array[] = [new Int32Array(4)];
  const stack: number[] = [];
  let label = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!mask[i] || labels[i]) continue;
      label++;
      const box = new Int32Array([x, y, x, y]);
      let size = 0;
      stack.length = 0;
      stack.push(i);
      labels[i] = label;
      while (stack.length) {
        const p = stack.pop()!;
        size++;
        const px = p % w;
        const py = (p / w) | 0;
        if (px < box[0]) box[0] = px;
        if (px > box[2]) box[2] = px;
        if (py < box[1]) box[1] = py;
        if (py > box[3]) box[3] = py;
        if (px > 0) {
          const q = p - 1;
          if (mask[q] && !labels[q]) {
            labels[q] = label;
            stack.push(q);
          }
        }
        if (px < w - 1) {
          const q = p + 1;
          if (mask[q] && !labels[q]) {
            labels[q] = label;
            stack.push(q);
          }
        }
        if (py > 0) {
          const q = p - w;
          if (mask[q] && !labels[q]) {
            labels[q] = label;
            stack.push(q);
          }
        }
        if (py < h - 1) {
          const q = p + w;
          if (mask[q] && !labels[q]) {
            labels[q] = label;
            stack.push(q);
          }
        }
      }
      sizes[label] = size;
      boxes[label] = box;
    }
  }
  return { labels, count: label, sizes, boxes };
}

/** 简单确定性 PRNG(渲染器用,保证测试可复现) */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 二值蒙版游程解码(与 DatasetStudio 的 encodeMaskRLE 对应,首段从 0 开始) */
export function decodeMaskRLE(runs: number[], length: number): Uint8Array {
  const out = new Uint8Array(length);
  let pos = 0;
  for (let i = 0; i < runs.length; i++) {
    const value = i % 2 === 0 ? 0 : 1;
    const end = Math.min(length, pos + runs[i]);
    if (value) for (let j = pos; j < end; j++) out[j] = 1;
    pos = end;
    if (pos >= length) break;
  }
  return out;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
