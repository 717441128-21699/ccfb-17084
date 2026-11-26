import type { Raster } from './types';
import {
  boxBlurAlpha,
  clamp,
  colorDistSq,
  dilateBinary,
  idx,
  labelComponents,
  toBin332,
} from './imageUtils';

export interface BackgroundOptions {
  /** 颜色精修阈值(加权色差平方),低于该值的像素参与均值 */
  refineTolSq?: number;
  /** 采样步长,>1 时只取部分帧加速 */
  stride?: number;
  onProgress?: (done: number, total: number) => void;
}

/**
 * 时序众数背景:
 * 每个像素在所有采样帧里统计粗量化颜色直方图,取出现次数最多的颜色,
 * 再对接近众数的原始颜色做均值精修。
 * 持续运动的选手/行人在任一像素都不占多数;晃动树叶围绕真实叶色抖动,
 * 众数仍落在叶色上,精修均值还能压掉抖动。
 */
export function estimateTemporalModeBackground(
  frames: Raster[],
  width: number,
  height: number,
  opts: BackgroundOptions = {},
): Raster & { data: Uint8ClampedArray } {
  const stride = Math.max(1, opts.stride ?? 1);
  const sampled: Raster[] = [];
  for (let i = 0; i < frames.length; i += stride) sampled.push(frames[i]);
  const n = sampled.length;
  if (n === 0) throw new Error('没有可用于背景估计的帧');

  const npx = width * height;
  const BINS = 256; // RGB332
  // 扁平定长直方图:每像素 256 个计数,无 Map/对象分配
  const hist = new Uint16Array(npx * BINS);
  const total = npx * n;
  let processed = 0;
  const progressEvery = Math.max(1, Math.floor(total / 40));

  for (let f = 0; f < n; f++) {
    const d = sampled[f].data;
    for (let p = 0; p < npx; p++) {
      const o = p * 4;
      const bin = toBin332(d[o], d[o + 1], d[o + 2]);
      const c = hist[p * BINS + bin] + 1;
      hist[p * BINS + bin] = c >= 65535 ? 65535 : c;
      if (++processed % progressEvery === 0) opts.onProgress?.(Math.min(processed, total), total);
    }
  }

  // 众数桶 -> 代表颜色(取 RGB332 桶中心)
  const modeBin = new Uint8Array(npx);
  const modeColor = new Uint8Array(npx * 3);
  for (let p = 0; p < npx; p++) {
    const base = p * BINS;
    let bestBin = 0;
    let bestCount = -1;
    for (let b = 0; b < BINS; b++) {
      const c = hist[base + b];
      if (c > bestCount) {
        bestCount = c;
        bestBin = b;
      }
    }
    modeBin[p] = bestBin;
    modeColor[p * 3] = (bestBin >> 5) * 32 + 16;
    modeColor[p * 3 + 1] = ((bestBin >> 2) & 7) * 32 + 16;
    modeColor[p * 3 + 2] = (bestBin & 3) * 64 + 32;
  }

  // 精修:对与众数同 RGB332 桶(或色差足够近)的原始颜色求均值
  const tolSq = opts.refineTolSq ?? 18 * 18;
  const bg = new Uint8ClampedArray(npx * 4);
  const accR = new Float64Array(npx);
  const accG = new Float64Array(npx);
  const accB = new Float64Array(npx);
  const accN = new Uint32Array(npx);
  for (let f = 0; f < n; f++) {
    const d = sampled[f].data;
    for (let p = 0; p < npx; p++) {
      const o = p * 4;
      const r = d[o];
      const g = d[o + 1];
      const b = d[o + 2];
      if (toBin332(r, g, b) !== modeBin[p] && colorDistSq(r, g, b, modeColor[p * 3], modeColor[p * 3 + 1], modeColor[p * 3 + 2]) > tolSq) {
        continue;
      }
      accR[p] += r;
      accG[p] += g;
      accB[p] += b;
      accN[p]++;
    }
  }
  for (let p = 0; p < npx; p++) {
    const o = p * 4;
    if (accN[p] > 0) {
      bg[o] = Math.round(accR[p] / accN[p]);
      bg[o + 1] = Math.round(accG[p] / accN[p]);
      bg[o + 2] = Math.round(accB[p] / accN[p]);
    } else {
      bg[o] = modeColor[p * 3];
      bg[o + 1] = modeColor[p * 3 + 1];
      bg[o + 2] = modeColor[p * 3 + 2];
    }
    bg[o + 3] = 255;
  }

  // 时域后处理:众数支持率不足(树叶抖动/半透明叠加)的像素,用 3×3 空间中值替换
  spatialMedianRepair(bg, modeBin, hist, BINS, n, width, height);
  opts.onProgress?.(total, total);
  return { width, height, data: bg };
}

/** 众数支持率低于 1/3 的像素,取邻域中出现频次最高的稳定颜色做空间中值修复 */
function spatialMedianRepair(
  bg: Uint8ClampedArray,
  modeBin: Uint8Array,
  hist: Uint16Array,
  bins: number,
  frameCount: number,
  w: number,
  h: number,
): void {
  const unstable = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) {
    const support = hist[p * bins + modeBin[p]];
    if (support < frameCount / 3) unstable[p] = 1;
  }
  const votes = new Map<number, { r: number; g: number; b: number; n: number }>();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (!unstable[p]) continue;
      votes.clear();
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const q = ny * w + nx;
          if (unstable[q]) continue; // 只用稳定邻居投票
          const key = modeBin[q];
          const o = q * 4;
          const cur = votes.get(key);
          if (cur) {
            cur.r += bg[o];
            cur.g += bg[o + 1];
            cur.b += bg[o + 2];
            cur.n++;
          } else {
            votes.set(key, { r: bg[o], g: bg[o + 1], b: bg[o + 2], n: 1 });
          }
        }
      }
      let best: { r: number; g: number; b: number; n: number } | null = null;
      for (const v of votes.values()) {
        if (!best || v.n > best.n) best = v;
      }
      if (best) {
        const o = p * 4;
        bg[o] = Math.round(best.r / best.n);
        bg[o + 1] = Math.round(best.g / best.n);
        bg[o + 2] = Math.round(best.b / best.n);
      }
    }
  }
}

export interface MattingOptions {
  /** 前景判定硬阈值(加权色差平方) */
  hardTolSq?: number;
  /** 软边带宽(色差平方),alpha 在此区间线性过渡 */
  softBandSq?: number;
  /** 高置信种子阈值(色差平方):只有与种子连通的软前景才保留,压制孤立噪声 */
  seedTolSq?: number;
  /** 最小连通域面积(占全图比例),低于则视为噪声丢弃 */
  minComponentRatio?: number;
  /** 膨胀半径,保证细线被支持域覆盖 */
  dilateRadius?: number;
  /** 边缘羽化半径(像素) */
  featherRadius?: number;
  /** 邻近帧(±N 帧)的高置信前景并集,用于找回低对比的身体边缘/细线 */
  temporalHint?: Raster[];
}

/**
 * 背景差分软抠图:
 * 色差 < soft 起点 -> 透明;hard 以上 -> 不透明;中间线性过渡,
 * 保留空竹运动模糊的半透明边缘与细淡的线。
 * 关键去噪:以高色差像素为"种子",软前景只有与种子连通才保留 ——
 * 树叶晃动等孤立假前景没有种子,被整体排除;人物/空竹自身就是种子。
 * 时序提示:邻近帧的高置信前景并集,把低对比但持续运动的边缘按低 alpha 找回。
 */
export function matteFrame(
  frame: Raster,
  background: Raster,
  opts: MattingOptions = {},
): Raster & { data: Uint8ClampedArray } {
  const { width: w, height: h } = frame;
  const npx = w * h;
  const hardSq = opts.hardTolSq ?? 42 * 42;
  const softSq = opts.softBandSq ?? 22 * 22;
  const seedSq = opts.seedTolSq ?? 55 * 55;
  const fd = frame.data;
  const bd = background.data;
  const alphaF = new Float32Array(npx);
  const support = new Uint8Array(npx);
  const seeds = new Uint8Array(npx);

  for (let p = 0; p < npx; p++) {
    const o = p * 4;
    const dsq = colorDistSq(fd[o], fd[o + 1], fd[o + 2], bd[o], bd[o + 1], bd[o + 2]);
    if (dsq <= softSq) continue;
    if (dsq >= hardSq) {
      alphaF[p] = 1;
      support[p] = 1;
    } else {
      alphaF[p] = (dsq - softSq) / (hardSq - softSq);
      support[p] = 1;
    }
    if (dsq >= seedSq) seeds[p] = 1;
  }

  // 时序提示:邻近帧高置信前景(色差 > seed)的并集,作为弱种子
  if (opts.temporalHint && opts.temporalHint.length > 0) {
    for (const hf of opts.temporalHint) {
      const hd = hf.data;
      for (let p = 0; p < npx; p++) {
        const o = p * 4;
        if (colorDistSq(hd[o], hd[o + 1], hd[o + 2], bd[o], bd[o + 1], bd[o + 2]) >= seedSq) {
          if (!support[p]) {
            support[p] = 1;
            alphaF[p] = Math.max(alphaF[p], 0.35);
          }
        }
      }
    }
  }

  // 膨胀支持域保护细线;同时让种子一起膨胀,使细/淡部件通过膨胀桥接到身体种子
  const dilR = opts.dilateRadius ?? 2;
  const dilated = dilateBinary(support, w, h, dilR);
  const dilatedSeeds = dilateBinary(seeds, w, h, dilR);
  const kept = removeSmallComponents(dilated, w, h, opts.minComponentRatio ?? 0.01);
  // 种子连通:从所有(膨胀后的)高置信种子 flood fill(沿 kept 支持域),排除无种子孤立块。
  // 若整帧没有高色差种子(孤立细线场景),退回连通域过滤结果,避免把细线全删掉。
  const hasAnySeed = dilatedSeeds.some((v) => v === 1);
  const connected = hasAnySeed ? floodFromSeeds(kept, dilatedSeeds, w, h) : kept;
  // 空洞修补:支持域内部的小洞补回
  const filled = fillHoles(connected, w, h);

  for (let p = 0; p < npx; p++) {
    if (!filled[p]) alphaF[p] = 0;
    else alphaF[p] = clamp(alphaF[p], 0, 1);
  }

  const feathered = boxBlurAlpha(alphaF, w, h, opts.featherRadius ?? 1);
  const out = new Uint8ClampedArray(npx * 4);
  for (let p = 0; p < npx; p++) {
    const o = p * 4;
    out[o] = fd[o];
    out[o + 1] = fd[o + 1];
    out[o + 2] = fd[o + 2];
    out[o + 3] = Math.round(clamp(feathered[p], 0, 1) * 255);
  }
  return { width: w, height: h, data: out };
}

/** 从种子出发,在支持域内 4 邻域 flood fill,输出与任一种子连通的支持域 */
function floodFromSeeds(support: Uint8Array, seeds: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  const stack: number[] = [];
  for (let p = 0; p < w * h; p++) {
    if (support[p] && seeds[p]) {
      out[p] = 1;
      stack.push(p);
    }
  }
  while (stack.length) {
    const p = stack.pop()!;
    const px = p % w;
    const py = (p / w) | 0;
    const tryPush = (q: number) => {
      if (support[q] && !out[q]) {
        out[q] = 1;
        stack.push(q);
      }
    };
    if (px > 0) tryPush(p - 1);
    if (px < w - 1) tryPush(p + 1);
    if (py > 0) tryPush(p - w);
    if (py < h - 1) tryPush(p + w);
  }
  return out;
}

/** 4 邻域连通域,丢弃面积小于阈值的块(在膨胀后的支持域上运行) */
function removeSmallComponents(mask: Uint8Array, w: number, h: number, minRatio: number): Uint8Array {
  const minSize = Math.max(24, Math.floor(w * h * minRatio));
  const { labels, count, sizes } = labelComponents(mask, w, h);
  const keep = new Uint8Array(count + 1);
  for (let l = 1; l <= count; l++) keep[l] = sizes[l] >= minSize ? 1 : 0;
  const out = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) {
    const l = labels[p];
    if (l && keep[l]) out[p] = 1;
  }
  return out;
}

/** 空洞填充:从四边 flood fill 背景,未被访问到的背景像素即为空洞 */
function fillHoles(mask: Uint8Array, w: number, h: number): Uint8Array {
  const outside = new Uint8Array(w * h);
  const stack: number[] = [];
  for (let x = 0; x < w; x++) {
    pushIfBg(0 * w + x);
    pushIfBg((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    pushIfBg(y * w);
    pushIfBg(y * w + w - 1);
  }
  function pushIfBg(p: number) {
    if (!mask[p] && !outside[p]) {
      outside[p] = 1;
      stack.push(p);
    }
  }
  while (stack.length) {
    const p = stack.pop()!;
    const px = p % w;
    const py = (p / w) | 0;
    if (px > 0) pushIfBg(p - 1);
    if (px < w - 1) pushIfBg(p + 1);
    if (py > 0) pushIfBg(p - w);
    if (py < h - 1) pushIfBg(p + w);
  }
  const out = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) {
    out[p] = mask[p] || (!outside[p] ? 1 : 0);
  }
  return out;
}

/** 手动修边:在蒙版上涂抹(brush>0 加,brush<0 减),半径内按强度修改 alpha */
export function paintMatte(
  matte: Raster,
  x: number,
  y: number,
  radius: number,
  strength: number,
  mode: 'add' | 'erase',
): void {
  const { width: w, height: h, data } = matte;
  const r2 = radius * radius;
  const x0 = Math.max(0, Math.floor(x - radius));
  const x1 = Math.min(w - 1, Math.ceil(x + radius));
  const y0 = Math.max(0, Math.floor(y - radius));
  const y1 = Math.min(h - 1, Math.ceil(y + radius));
  for (let yy = y0; yy <= y1; yy++) {
    for (let xx = x0; xx <= x1; xx++) {
      const dx = xx - x;
      const dy = yy - y;
      if (dx * dx + dy * dy > r2) continue;
      const o = idx(xx, yy, w);
      const cur = data[o + 3] / 255;
      const next = mode === 'add' ? Math.max(cur, strength) : Math.min(cur, 1 - strength);
      data[o + 3] = Math.round(clamp(next, 0, 1) * 255);
    }
  }
}
