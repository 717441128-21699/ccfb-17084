import { describe, it, expect } from 'vitest';
import { decodeMaskRLE } from '../src/core/imageUtils';
import { renderVideo } from '../src/core/synthRenderer';
import { matteFrame } from '../src/core/background';
import { estimateTemporalModeBackground } from '../src/core/background';

function encodeMaskRLE(mask: Uint8Array): number[] {
  const runs: number[] = [];
  let cur = 0;
  let len = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] === cur) {
      len++;
    } else {
      runs.push(len);
      cur = mask[i];
      len = 1;
    }
  }
  runs.push(len);
  return runs;
}

describe('真值蒙版 RLE 与抠图精度', () => {
  it('RLE 往返无损', () => {
    const v = renderVideo({ venue: 'gym', trick: 'string', width: 200, height: 120, fps: 30, durationSec: 3, seed: 9 });
    const frame = v.frames[10];
    const rle = encodeMaskRLE(frame.truthMask);
    const back = decodeMaskRLE(rle, frame.truthMask.length);
    expect(back.length).toBe(frame.truthMask.length);
    let diff = 0;
    for (let i = 0; i < back.length; i++) if (back[i] !== frame.truthMask[i]) diff++;
    expect(diff).toBe(0);
  });

  it('抠图蒙版与真值蒙版软 IoU 超过 0.6(公园/抛接,含半透明边)', () => {
    const v = renderVideo({ venue: 'park', trick: 'toss', width: 320, height: 180, fps: 30, durationSec: 6, seed: 3 });
    const bg = estimateTemporalModeBackground(
      v.frames.map((f) => ({ width: f.width, height: f.height, data: f.data })),
      320,
      180,
    );
    // 取一个顶点附近的帧
    const apex = v.meta.events.find((e) => e.type === 'apex')!;
    const frame = v.frames[apex.frame];
    const matte = matteFrame(frame, bg, {});
    let softInter = 0;
    let softUnion = 0;
    let hardInter = 0;
    let hardUnion = 0;
    for (let p = 0; p < 320 * 180; p++) {
      const a = matte.data[p * 4 + 3] / 255;
      const hard = a > 0.43 ? 1 : 0;
      const truth = frame.truthMask[p];
      softInter += Math.min(a, truth);
      softUnion += Math.max(a, truth);
      if (hard && truth) hardInter++;
      if (hard || truth) hardUnion++;
    }
    const softIoU = softInter / softUnion;
    const hardIoU = hardInter / hardUnion;
    console.log(`softIoU=${softIoU.toFixed(3)} hardIoU=${hardIoU.toFixed(3)}`);
    expect(softIoU).toBeGreaterThan(0.6);
    expect(hardIoU).toBeGreaterThan(0.5);
  });

  it('背景估计对干净真值背景的残留率低于 2%', () => {
    const v = renderVideo({ venue: 'plaza', trick: 'exchange', width: 320, height: 180, fps: 30, durationSec: 6, seed: 5 });
    const bg = estimateTemporalModeBackground(
      v.frames.map((f) => ({ width: f.width, height: f.height, data: f.data })),
      320,
      180,
    );
    let bad = 0;
    for (let p = 0; p < 320 * 180; p++) {
      const o = p * 4;
      const dr = bg.data[o] - v.cleanBackground.data[o];
      const dg = bg.data[o + 1] - v.cleanBackground.data[o + 1];
      const db = bg.data[o + 2] - v.cleanBackground.data[o + 2];
      if (0.3 * dr * dr + 0.59 * dg * dg + 0.11 * db * db > 18 * 18) bad++;
    }
    expect(bad / (320 * 180)).toBeLessThan(0.02);
  });
});
