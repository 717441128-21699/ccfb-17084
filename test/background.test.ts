import { describe, it, expect } from 'vitest';
import { estimateTemporalModeBackground, matteFrame } from '../src/core/background';
import { createRaster, colorDistSq } from '../src/core/imageUtils';
import type { Raster } from '../src/core/types';

function makeFrame(w: number, h: number, fill: [number, number, number], noise = 0): Raster {
  const r = createRaster(w, h);
  for (let p = 0; p < w * h; p++) {
    const o = p * 4;
    const n = noise ? (Math.random() - 0.5) * noise : 0;
    r.data[o] = Math.max(0, Math.min(255, fill[0] + n));
    r.data[o + 1] = Math.max(0, Math.min(255, fill[1] + n));
    r.data[o + 2] = Math.max(0, Math.min(255, fill[2] + n));
    r.data[o + 3] = 255;
  }
  return r;
}

describe('时序众数背景估计', () => {
  it('静止场景直接还原', () => {
    const frames = Array.from({ length: 12 }, () => makeFrame(24, 18, [40, 120, 70], 4));
    const bg = estimateTemporalModeBackground(frames, 24, 18);
    let err = 0;
    for (let p = 0; p < 24 * 18; p++) {
      const o = p * 4;
      err += colorDistSq(bg.data[o], bg.data[o + 1], bg.data[o + 2], 40, 120, 70);
    }
    expect(err / (24 * 18)).toBeLessThan(5 * 5);
  });

  it('移动的物体不会残留在背景里', () => {
    const w = 40;
    const h = 30;
    const frames: Raster[] = [];
    // 30 帧,一个亮块每帧移动,另外有两个随机"行人"短暂经过
    for (let f = 0; f < 30; f++) {
      const fr = makeFrame(w, h, [90, 100, 110], 2);
      const bx = f % w;
      for (let y = 4; y < 10; y++) {
        for (let x = bx; x < Math.min(w, bx + 5); x++) {
          const o = (y * w + x) * 4;
          fr.data[o] = 230;
          fr.data[o + 1] = 40;
          fr.data[o + 2] = 40;
        }
      }
      if (f >= 8 && f < 12) {
        for (let y = 14; y < 24; y++) {
          for (let x = 2; x < 8; x++) {
            const o = (y * w + x) * 4;
            fr.data[o] = 20;
            fr.data[o + 1] = 20;
            fr.data[o + 2] = 20;
          }
        }
      }
      frames.push(fr);
    }
    const bg = estimateTemporalModeBackground(frames, w, h);
    let contaminated = 0;
    for (let p = 0; p < w * h; p++) {
      const o = p * 4;
      // 背景应接近 [90,100,110],任何残留的红块/黑块都算污染
      if (colorDistSq(bg.data[o], bg.data[o + 1], bg.data[o + 2], 90, 100, 110) > 16 * 16) contaminated++;
    }
    expect(contaminated / (w * h)).toBeLessThan(0.01);
  });

  it('晃动的叶色围绕真值抖动时众数仍命中叶色', () => {
    const w = 16;
    const h = 16;
    const frames: Raster[] = [];
    for (let f = 0; f < 24; f++) {
      const fr = makeFrame(w, h, [60, 150, 60], 0);
      // 叶色在 ±12 内周期抖动
      const sway = Math.sin(f * 0.9) * 12;
      for (let p = 0; p < w * h; p++) {
        const o = p * 4;
        fr.data[o] = Math.max(0, Math.min(255, 60 + sway));
        fr.data[o + 1] = Math.max(0, Math.min(255, 150 + sway * 0.5));
      }
      frames.push(fr);
    }
    const bg = estimateTemporalModeBackground(frames, w, h);
    let err = 0;
    for (let p = 0; p < w * h; p++) {
      const o = p * 4;
      err += colorDistSq(bg.data[o], bg.data[o + 1], bg.data[o + 2], 60, 150, 60);
    }
    expect(err / (w * h)).toBeLessThan(10 * 10);
  });
});

describe('软阈值抠图', () => {
  it('保留半透明边缘而不是一刀切', () => {
    const bg = makeFrame(20, 20, [100, 100, 100]);
    const frame = makeFrame(20, 20, [100, 100, 100]);
    // 实心红块
    for (let y = 6; y < 14; y++) {
      for (let x = 6; x < 14; x++) {
        const o = (y * 20 + x) * 4;
        frame.data[o] = 220;
        frame.data[o + 1] = 40;
        frame.data[o + 2] = 40;
      }
    }
    // 边缘一圈"运动模糊":与背景色差处于软边区间
    for (let x = 5; x < 15; x++) {
      const o1 = (5 * 20 + x) * 4;
      const o2 = (14 * 20 + x) * 4;
      frame.data[o1] = 150;
      frame.data[o2] = 150;
      frame.data[o1 + 1] = 75;
      frame.data[o2 + 1] = 75;
      frame.data[o1 + 2] = 75;
      frame.data[o2 + 2] = 75;
    }
    const matte = matteFrame(frame, bg, { minComponentRatio: 0.001, dilateRadius: 1, featherRadius: 1 });
    const center = matte.data[(10 * 20 + 10) * 4 + 3];
    const edge = matte.data[(5 * 20 + 10) * 4 + 3];
    const outside = matte.data[(2 * 20 + 2) * 4 + 3];
    expect(center).toBeGreaterThan(240);
    expect(edge).toBeGreaterThan(20);
    expect(edge).toBeLessThan(235);
    expect(outside).toBe(0);
  });

  it('细淡的线不会被连通域过滤删掉', () => {
    const bg = makeFrame(30, 30, [120, 120, 120]);
    const frame = makeFrame(30, 30, [120, 120, 120]);
    // 1px 淡色横线
    for (let x = 4; x < 26; x++) {
      const o = (15 * 30 + x) * 4;
      frame.data[o] = 155;
      frame.data[o + 1] = 155;
      frame.data[o + 2] = 150;
    }
    const matte = matteFrame(frame, bg, {
      softBandSq: 8 * 8,
      hardTolSq: 20 * 20,
      dilateRadius: 2,
      minComponentRatio: 0.001,
    });
    let kept = 0;
    for (let x = 4; x < 26; x++) if (matte.data[(15 * 30 + x) * 4 + 3] > 0) kept++;
    expect(kept).toBeGreaterThan(15);
  });
});
