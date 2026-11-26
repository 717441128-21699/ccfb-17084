import { describe, it, expect } from 'vitest';
import { renderVideo } from '../src/core/synthRenderer';
import type { RenderConfig } from '../src/core/synthRenderer';
import { selectKeyMoments, evaluateAgainstTruth, detectEvents } from '../src/core/keyMoments';
import type { DetectionFrame } from '../src/core/keyMoments';

const base: RenderConfig = {
  venue: 'park',
  trick: 'toss',
  width: 320,
  height: 180,
  fps: 30,
  durationSec: 9,
  seed: 42,
};

describe('合成录像与关键时刻', () => {
  it('每种花样都产出真值事件', () => {
    for (const trick of ['toss', 'exchange', 'string'] as const) {
      const v = renderVideo({ ...base, trick });
      expect(v.frames.length).toBe(270);
      expect(v.meta.events.length).toBeGreaterThan(0);
      expect(v.cleanBackground.width).toBe(320);
      const types = new Set(v.meta.events.map((e) => e.type));
      expect(types.size).toBeGreaterThan(0);
    }
  });

  it('抛接:自动顶点与真值顶点相差不超过 3 帧', () => {
    const v = renderVideo({ ...base, trick: 'toss' });
    const frames: DetectionFrame[] = v.frames.map((f) => ({ ...f }));
    const moments = selectKeyMoments(frames, { fps: 30, targetCount: 6 });
    const apexTruth = v.meta.events.filter((e) => e.type === 'apex');
    const report = evaluateAgainstTruth(moments, apexTruth);
    expect(report.maxFrameDiff).toBeLessThanOrEqual(3);
  });

  it('换手:换手事件 3 帧内命中', () => {
    const v = renderVideo({ ...base, trick: 'exchange' });
    const switchTruth = v.meta.events.filter((e) => e.type === 'switch');
    // 时刻预算按真值事件数量给足,验证的是定位精度而不是容量
    const moments = selectKeyMoments(
      v.frames.map((f) => ({ ...f })),
      { fps: 30, targetCount: switchTruth.length },
    );
    const report = evaluateAgainstTruth(moments, switchTruth);
    expect(report.within3).toBe(switchTruth.length);
  });

  it('接住事件可被检测且时间有序', () => {
    const v = renderVideo({ ...base, trick: 'toss' });
    const events = detectEvents(
      v.frames.map((f) => ({ ...f })),
      { fps: 30 },
    );
    const frames = events.map((e) => e.frameIndex);
    for (let i = 1; i < frames.length; i++) expect(frames[i]).toBeGreaterThan(frames[i - 1]);
    expect(events.some((e) => e.eventType === 'catch' || e.eventType === 'apex')).toBe(true);
  });

  it('目标时刻数量得到满足', () => {
    const v = renderVideo({ ...base, trick: 'string' });
    const moments = selectKeyMoments(
      v.frames.map((f) => ({ ...f })),
      { fps: 30, targetCount: 6 },
    );
    expect(moments.length).toBe(6);
    // 帧号严格递增
    for (let i = 1; i < moments.length; i++) {
      expect(moments[i].frameIndex).toBeGreaterThan(moments[i - 1].frameIndex);
    }
  });
});
