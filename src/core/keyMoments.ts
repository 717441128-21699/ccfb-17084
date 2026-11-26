import type { KeyMoment, Raster, TruthEvent } from './types';
import { clamp, colorDistSq, labelComponents } from './imageUtils';

export interface DetectionFrame extends Raster {
  frameIndex: number;
  timestamp: number;
}

export interface DetectedEvent {
  frameIndex: number;
  timestamp: number;
  eventType: KeyMoment['eventType'];
  label: string;
  score: number;
}

export interface ScanOptions {
  fps: number;
  /** 空竹主色 RGB(合成渲染器与真实录像可通过色卡设置) */
  diaboloColor?: [number, number, number];
  /** 事件最小间隔(秒),避免同一转折被重复选取 */
  minEventGapSec?: number;
  /** 期望的关键时刻数量 */
  targetCount?: number;
}

interface FrameSignal {
  diabolo: { x: number; y: number; found: boolean };
  hands: { leftX: number; leftY: number; rightX: number; rightY: number };
  fgArea: number;
  energy: number;
}

/**
 * 对低分辨率扫描帧做运动学分析:
 *  - 空竹:按主色筛选 + 连通域,取面积/圆度最合适的组件,给出质心轨迹
 *  - 双手:取前景在左右半区的最低点质心
 *  - 能量:相邻帧前景差分
 */
export function analyzeSignals(frames: DetectionFrame[], opts: ScanOptions): FrameSignal[] {
  const w = frames[0].width;
  const h = frames[0].height;
  const npx = w * h;
  const color = opts.diaboloColor ?? [214, 48, 49];
  const colorTolSq = 55 * 55;
  const signals: FrameSignal[] = [];
  let prevFg: Uint8Array | null = null;

  for (const frame of frames) {
    const d = frame.data;
    const fg = new Uint8Array(npx);
    const diaboloCand = new Uint8Array(npx);
    let fgCount = 0;
    for (let p = 0; p < npx; p++) {
      const o = p * 4;
      // 前景:显著偏暗或高饱和(简化的低分辨率前景,不需要背景也能跑)
      const r = d[o];
      const g = d[o + 1];
      const b = d[o + 2];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const isFg = max - min > 60 || max < 90;
      if (isFg) {
        fg[p] = 1;
        fgCount++;
      }
      if (colorDistSq(r, g, b, color[0], color[1], color[2]) < colorTolSq) {
        diaboloCand[p] = 1;
      }
    }

    // 空竹:候选组件中取最圆、面积适中者
    const comps = labelComponents(diaboloCand, w, h);
    let best = -1;
    let bestScore = Infinity;
    for (let l = 1; l <= comps.count; l++) {
      const size = comps.sizes[l];
      if (size < 6 || size > npx * 0.08) continue;
      const box = comps.boxes[l];
      const bw = box[2] - box[0] + 1;
      const bh = box[3] - box[1] + 1;
      const aspect = Math.max(bw, bh) / Math.max(1, Math.min(bw, bh));
      const fill = size / (bw * bh);
      const score = Math.abs(aspect - 1) + Math.abs(fill - 0.7);
      if (score < bestScore) {
        bestScore = score;
        best = l;
      }
    }
    let diabolo = { x: 0, y: 0, found: false };
    if (best > 0) {
      let sx = 0;
      let sy = 0;
      let n = 0;
      for (let p = 0; p < npx; p++) {
        if (comps.labels[p] === best) {
          sx += p % w;
          sy += (p / w) | 0;
          n++;
        }
      }
      diabolo = { x: sx / n, y: sy / n, found: true };
    }

    // 双手质心:左右半区前景按 y 加权(手在身体两侧偏下)
    const hands = { leftX: 0, leftY: 0, rightX: 0, rightY: 0 };
    let ln = 0;
    let rn = 0;
    for (let p = 0; p < npx; p++) {
      if (!fg[p]) continue;
      const x = p % w;
      const y = (p / w) | 0;
      if (x < w / 2) {
        hands.leftX += x;
        hands.leftY += y;
        ln++;
      } else {
        hands.rightX += x;
        hands.rightY += y;
        rn++;
      }
    }
    if (ln) {
      hands.leftX /= ln;
      hands.leftY /= ln;
    }
    if (rn) {
      hands.rightX = rn ? hands.rightX / rn : 0;
      hands.rightY = rn ? hands.rightY / rn : 0;
    }

    // 帧间能量
    let energy = 0;
    if (prevFg) {
      for (let p = 0; p < npx; p++) energy += fg[p] !== prevFg[p] ? 1 : 0;
    }
    prevFg = fg;
    signals.push({ diabolo, hands, fgArea: fgCount / npx, energy });
  }
  return signals;
}

/**
 * 事件检测(分类型独立判定,同类事件做时间去重):
 *  apex   —— 空竹 y 坐标局部极小(画面坐标,y 越小越高),且垂直速度由负转正
 *  switch —— 空竹越过双手中点,或水平速度显著变号
 *  catch  —— 空竹与手距离局部极小且垂直速度骤降
 *  energy —— 兜底:动作能量局部峰
 */
export function detectEvents(frames: DetectionFrame[], opts: ScanOptions): DetectedEvent[] {
  const sig = analyzeSignals(frames, opts);
  const n = frames.length;
  const events: DetectedEvent[] = [];
  const fps = opts.fps;
  // 同一动作的两个触发信号(端点反向、过中点)可能相隔 10+ 帧,间隔取 0.65s 去重
  const minGap = Math.round((opts.minEventGapSec ?? 0.65) * fps);
  const apexR = Math.max(2, Math.round(fps * 0.1));

  const pushTyped = (i: number, type: KeyMoment['eventType'], label: string, score: number) => {
    const fi = frames[i].frameIndex;
    if (events.some((e) => e.eventType === type && Math.abs(e.frameIndex - fi) < minGap)) return;
    events.push({ frameIndex: fi, timestamp: frames[i].timestamp, eventType: type, label, score });
  };

  for (let i = apexR + 1; i < n - apexR - 1; i++) {
    const s = sig[i];
    if (!s.diabolo.found) continue;

    // ---- apex:窗口内最高点 + 垂直速度由上转下 ----
    let isApex = true;
    for (let k = i - apexR; k <= i + apexR; k++) {
      if (!sig[k].diabolo.found || sig[k].diabolo.y < s.diabolo.y - 0.5) {
        isApex = false;
        break;
      }
    }
    const vyPrev = sig[i - 1].diabolo.found ? s.diabolo.y - sig[i - 1].diabolo.y : 0;
    const vyNext = sig[i + 1].diabolo.found ? sig[i + 1].diabolo.y - s.diabolo.y : 0;
    if (isApex && vyPrev <= 0.5 && vyNext >= -0.5) {
      pushTyped(i, 'apex', '抛起最高点', 1 - clamp(s.diabolo.y / frames[0].height, 0, 1));
    }

    // ---- switch:越过双手中点,或水平速度显著变号(必须以水平运动为主,排除竖直回环) ----
    const midX = (s.hands.leftX + s.hands.rightX) / 2;
    const prev = sig[i - 1];
    const prev2 = sig[i - 2];
    let crossed = false;
    if (prev.diabolo.found) {
      const prevMidX = (prev.hands.leftX + prev.hands.rightX) / 2;
      if ((prev.diabolo.x - prevMidX) * (s.diabolo.x - midX) < 0) crossed = true;
    }
    let reversed = false;
    if (prev.diabolo.found && prev2?.diabolo.found) {
      const vx = s.diabolo.x - prev.diabolo.x;
      const vy = s.diabolo.y - prev.diabolo.y;
      const pvx = prev.diabolo.x - prev2.diabolo.x;
      const pvy = prev.diabolo.y - prev2.diabolo.y;
      // 水平分量占主导且方向反转,才是换手;竖直圆环的 vy 占主导不会触发
      if (vx * pvx < 0 && Math.abs(vx - pvx) > 1.5 && Math.abs(vx) >= Math.abs(vy) && Math.abs(pvx) >= Math.abs(pvy)) {
        reversed = true;
      }
    }
    if (crossed || reversed) {
      pushTyped(i, 'switch', '换手', 0.8);
    }

    // ---- catch:与最近手距离局部极小 + 速度骤降 + 位置足够低 ----
    const distHand = (k: number) => {
      const sk = sig[k];
      if (!sk.diabolo.found) return Infinity;
      return Math.min(
        Math.hypot(sk.diabolo.x - sk.hands.leftX, sk.diabolo.y - sk.hands.leftY),
        Math.hypot(sk.diabolo.x - sk.hands.rightX, sk.diabolo.y - sk.hands.rightY),
      );
    };
    const dHand = distHand(i);
    let isLocalMin = true;
    for (let k = i - apexR; k <= i + apexR; k++) {
      if (k === i || k < 0 || k >= n) continue;
      if (distHand(k) < dHand) {
        isLocalMin = false;
        break;
      }
    }
    const speedNow =
      prev.diabolo.found ? Math.hypot(s.diabolo.x - prev.diabolo.x, s.diabolo.y - prev.diabolo.y) : Infinity;
    const speedPrev =
      prev2?.diabolo.found && prev.diabolo.found
        ? Math.hypot(prev.diabolo.x - prev2.diabolo.x, prev.diabolo.y - prev2.diabolo.y)
        : Infinity;
    if (isLocalMin && speedNow < speedPrev * 0.75 && dHand < frames[0].height * 0.22) {
      pushTyped(i, 'catch', '接住', 0.75);
    }

    // ---- 能量峰兜底 ----
    const er = apexR;
    let isPeak = true;
    for (let k = i - er; k <= i + er; k++) {
      if (k < 0 || k >= n) continue;
      if (sig[k].energy > s.energy) {
        isPeak = false;
        break;
      }
    }
    if (isPeak && s.energy > frames[0].width * frames[0].height * 0.02) {
      pushTyped(i, 'energy', '动作转折', 0.4);
    }
  }

  events.sort((a, b) => a.frameIndex - b.frameIndex);
  return events;
}

/**
 * 选出目标数量的关键时刻:
 * 把时间轴均分成 target 个桶,每桶取优先级最高、同分再取分数最高的事件,
 * 保证关键时刻覆盖全片且动作转折类型优先;桶内无事件时取能量峰兜底。
 */
export function selectKeyMoments(frames: DetectionFrame[], opts: ScanOptions): KeyMoment[] {
  const target = opts.targetCount ?? 6;
  const events = detectEvents(frames, opts);
  const span = frames.length;
  const bucketSize = span / target;
  // 动作转折的语义优先级:顶点/接住 > 换手 > 能量峰
  const typePriority: Record<KeyMoment['eventType'], number> = {
    apex: 0,
    catch: 1,
    switch: 2,
    energy: 3,
    manual: 0,
  };
  const indexOf = new Map<number, number>();
  frames.forEach((f, i) => indexOf.set(f.frameIndex, i));
  const chosen: DetectedEvent[] = [];

  for (let b = 0; b < target; b++) {
    const lo = Math.floor(b * bucketSize);
    const hi = Math.floor((b + 1) * bucketSize);
    const inBucket = events
      .filter((e) => {
        const localIdx = indexOf.get(e.frameIndex);
        return localIdx !== undefined && localIdx >= lo && localIdx < hi;
      })
      .sort((a, c) => typePriority[a.eventType] - typePriority[c.eventType] || c.score - a.score);
    const pick = inBucket[0];
    if (pick) chosen.push(pick);
  }

  // 桶内落空:用扫描能量峰补
  if (chosen.length < target) {
    const sig = analyzeSignals(frames, opts);
    const have = new Set(chosen.map((c) => c.frameIndex));
    const candidates: { i: number; energy: number }[] = [];
    for (let i = 2; i < frames.length - 2; i++) {
      if (!have.has(frames[i].frameIndex)) candidates.push({ i, energy: sig[i].energy });
    }
    candidates.sort((a, c) => c.energy - a.energy);
    for (const cand of candidates) {
      if (chosen.length >= target) break;
      chosen.push({
        frameIndex: frames[cand.i].frameIndex,
        timestamp: frames[cand.i].timestamp,
        eventType: 'energy',
        label: '动作转折',
        score: 0.3,
      });
    }
  }
  chosen.sort((a, b) => a.frameIndex - b.frameIndex);
  return chosen.map((e, i) => ({
    id: `km-${i}-f${e.frameIndex}`,
    frameIndex: e.frameIndex,
    timestamp: e.timestamp,
    label: e.label,
    eventType: e.eventType,
    auto: true,
  }));
}

/** 与真值事件比对:每个真值找最近的自动时刻,返回帧差统计 */
export function evaluateAgainstTruth(
  moments: KeyMoment[],
  truth: TruthEvent[],
): { matched: number; total: number; maxFrameDiff: number; meanFrameDiff: number; within3: number } {
  let maxDiff = 0;
  let sum = 0;
  let within3 = 0;
  for (const t of truth) {
    let best = Infinity;
    for (const m of moments) {
      best = Math.min(best, Math.abs(m.frameIndex - t.frame));
    }
    maxDiff = Math.max(maxDiff, best);
    sum += best;
    if (best <= 3) within3++;
  }
  return {
    matched: truth.length,
    total: truth.length,
    maxFrameDiff: maxDiff,
    meanFrameDiff: truth.length ? sum / truth.length : 0,
    within3,
  };
}
