import { describe, it, expect } from 'vitest';
import { compositeLayers, buildGradeLUT } from '../src/core/compositor';
import { createRaster } from '../src/core/imageUtils';
import type { Raster } from '../src/core/types';

function layer(w: number, h: number, x: number, y: number, color: [number, number, number], alpha = 255): Raster {
  const r = createRaster(w, h);
  const o = (y * w + x) * 4;
  r.data[o] = color[0];
  r.data[o + 1] = color[1];
  r.data[o + 2] = color[2];
  r.data[o + 3] = alpha;
  return r;
}

describe('CPU 参考合成器', () => {
  it('后一时刻压住前一时刻(遮挡顺序由帧号决定)', () => {
    const bg = createRaster(4, 4);
    for (let p = 0; p < 16; p++) {
      bg.data[p * 4] = 10;
      bg.data[p * 4 + 1] = 10;
      bg.data[p * 4 + 2] = 10;
      bg.data[p * 4 + 3] = 255;
    }
    const early = { ...layer(4, 4, 2, 2, [255, 0, 0]), frameIndex: 10, timestamp: 0 };
    const late = { ...layer(4, 4, 2, 2, [0, 255, 0]), frameIndex: 20, timestamp: 1 };
    // 故意乱序传入,合成器内部必须排序
    const out = compositeLayers(bg, [late, early], { earliestOpacity: 1 });
    const o = (2 * 4 + 2) * 4;
    expect(out.data[o + 1]).toBe(255); // 绿色(晚)胜出
    expect(out.data[o]).toBe(0);
  });

  it('越早的层越淡:早层透明度被压低', () => {
    const bg = createRaster(2, 2);
    for (let p = 0; p < 4; p++) {
      bg.data[p * 4] = 0;
      bg.data[p * 4 + 1] = 0;
      bg.data[p * 4 + 2] = 0;
      bg.data[p * 4 + 3] = 255;
    }
    const a = { ...layer(2, 2, 0, 0, [255, 255, 255]), frameIndex: 0, timestamp: 0 };
    const b = { ...layer(2, 2, 1, 1, [255, 255, 255]), frameIndex: 1, timestamp: 1 };
    const out = compositeLayers(bg, [a, b], { earliestOpacity: 0.4 });
    const earlyPx = out.data[0]; // (0,0) 只有早层
    const latePx = out.data[(1 * 2 + 1) * 4]; // 只有晚层
    expect(latePx).toBe(255);
    expect(earlyPx).toBeGreaterThan(80);
    expect(earlyPx).toBeLessThan(140); // 0.4*255 ≈ 102
  });

  it('调色 LUT:亮度与 gamma 单调', () => {
    const lutUp = buildGradeLUT({ brightness: 0.5, contrast: 0, saturation: 0, gamma: 1 });
    const lutDown = buildGradeLUT({ brightness: -0.5, contrast: 0, saturation: 0, gamma: 1 });
    expect(lutUp[128 * 3]).toBeGreaterThan(128);
    expect(lutDown[128 * 3]).toBeLessThan(128);
    // gamma < 1:低端提亮、255 不动点保持
    const lutGamma = buildGradeLUT({ brightness: 0, contrast: 0, saturation: 0, gamma: 0.5 });
    const lutLinear = buildGradeLUT({ brightness: 0, contrast: 0, saturation: 0, gamma: 1 });
    expect(lutGamma[64 * 3]).toBeGreaterThan(lutLinear[64 * 3]);
    expect(lutGamma[0]).toBe(0);
    expect(lutGamma[255 * 3]).toBe(255);
    // 单调性
    for (let v = 1; v < 256; v++) expect(lutGamma[v * 3]).toBeGreaterThanOrEqual(lutGamma[(v - 1) * 3]);
  });
});
