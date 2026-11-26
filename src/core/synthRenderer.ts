import type { DatasetMeta, Raster, TruthEvent } from './types';
import { clamp, createRaster, mulberry32 } from './imageUtils';

export type VenueId = 'park' | 'plaza' | 'gym';
export type TrickId = 'toss' | 'exchange' | 'string';

export interface RenderConfig {
  venue: VenueId;
  trick: TrickId;
  width: number;
  height: number;
  fps: number;
  durationSec: number;
  seed: number;
}

export interface RenderedFrame extends Raster {
  frameIndex: number;
  timestamp: number;
  /** 真值蒙版:选手/杆/线/空竹覆盖处为 1 */
  truthMask: Uint8Array;
}

export interface RenderedVideo {
  config: RenderConfig;
  frames: RenderedFrame[];
  meta: DatasetMeta;
  /** 无选手、无行人、树叶静止的干净场地背景(真值) */
  cleanBackground: Raster;
}

interface RGB {
  r: number;
  g: number;
  b: number;
}

const SHIRT: RGB = { r: 24, g: 86, b: 210 };
const PANTS: RGB = { r: 22, g: 26, b: 38 };
const SKIN: RGB = { r: 232, g: 140, b: 92 };
const STICK: RGB = { r: 130, g: 76, b: 24 };
const STRING: RGB = { r: 235, g: 235, b: 225 };
const DIABOLO: RGB = { r: 230, g: 36, b: 38 };
const DIABOLO_DARK: RGB = { r: 130, g: 14, b: 16 };

/** 覆盖率混合(用于抗锯齿边缘与半透明物体) */
function blend(buf: Uint8ClampedArray, w: number, h: number, x: number, y: number, c: RGB, a: number): void {
  if (x < 0 || y < 0 || x >= w || y >= h) return;
  const o = ((y | 0) * w + (x | 0)) * 4;
  const ia = 1 - a;
  buf[o] = buf[o] * ia + c.r * a;
  buf[o + 1] = buf[o + 1] * ia + c.g * a;
  buf[o + 2] = buf[o + 2] * ia + c.b * a;
  buf[o + 3] = 255;
}

/** 像素对齐的实心小叶块:位置量化到整数,微风抖动只在少数帧改变占用,颜色集稳定 */
function fillLeafBlock(
  buf: Uint8ClampedArray,
  w: number,
  h: number,
  cx: number,
  cy: number,
  r: number,
  c: RGB,
): void {
  const x0 = Math.max(0, Math.round(cx) - r);
  const x1 = Math.min(w - 1, Math.round(cx) + r);
  const y0 = Math.max(0, Math.round(cy) - r);
  const y1 = Math.min(h - 1, Math.round(cy) + r);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const o = (y * w + x) * 4;
      buf[o] = c.r;
      buf[o + 1] = c.g;
      buf[o + 2] = c.b;
      buf[o + 3] = 255;
    }
  }
}

function fillCircle(
  buf: Uint8ClampedArray,
  mask: Uint8Array | null,
  w: number,
  h: number,
  cx: number,
  cy: number,
  r: number,
  c: RGB,
  alpha = 1,
): void {
  const x0 = Math.max(0, Math.floor(cx - r - 1));
  const x1 = Math.min(w - 1, Math.ceil(cx + r + 1));
  const y0 = Math.max(0, Math.floor(cy - r - 1));
  const y1 = Math.min(h - 1, Math.ceil(cy + r + 1));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const cov = clamp(r + 0.5 - d, 0, 1);
      if (cov <= 0) continue;
      blend(buf, w, h, x, y, c, cov * alpha);
      if (mask && cov * alpha > 0.5) mask[y * w + x] = 1;
    }
  }
}

function fillCapsule(
  buf: Uint8ClampedArray,
  mask: Uint8Array | null,
  w: number,
  h: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  width: number,
  c: RGB,
  alpha = 1,
): void {
  const minX = Math.max(0, Math.floor(Math.min(x1, x2) - width - 1));
  const maxX = Math.min(w - 1, Math.ceil(Math.max(x1, x2) + width + 1));
  const minY = Math.max(0, Math.floor(Math.min(y1, y2) - width - 1));
  const maxY = Math.min(h - 1, Math.ceil(Math.max(y1, y2) + width + 1));
  const vx = x2 - x1;
  const vy = y2 - y1;
  const len2 = vx * vx + vy * vy || 1;
  const r = width / 2;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const t = clamp(((px - x1) * vx + (py - y1) * vy) / len2, 0, 1);
      const d = Math.hypot(px - (x1 + vx * t), py - (y1 + vy * t));
      const cov = clamp(r + 0.5 - d, 0, 1);
      if (cov <= 0) continue;
      blend(buf, w, h, x, y, c, cov * alpha);
      if (mask && cov * alpha > 0.5) mask[y * w + x] = 1;
    }
  }
}

/** 细线:线又细又淡,1px、低不透明度,考验抠图保边能力 */
function fillThinLine(
  buf: Uint8ClampedArray,
  mask: Uint8Array | null,
  w: number,
  h: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  c: RGB,
  alpha: number,
): void {
  const steps = Math.max(1, Math.round(Math.hypot(x2 - x1, y2 - y1)));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = Math.round(x1 + (x2 - x1) * t);
    const y = Math.round(y1 + (y2 - y1) * t);
    blend(buf, w, h, x, y, c, alpha);
    if (mask) mask[y * w + x] = 1;
  }
}

function fillEllipse(
  buf: Uint8ClampedArray,
  w: number,
  h: number,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  c: RGB,
  alpha: number,
): void {
  const x0 = Math.max(0, Math.floor(cx - rx - 1));
  const x1 = Math.min(w - 1, Math.ceil(cx + rx + 1));
  const y0 = Math.max(0, Math.floor(cy - ry - 1));
  const y1 = Math.min(h - 1, Math.ceil(cy + ry + 1));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const v = ((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2;
      if (v > 1) continue;
      const cov = clamp(1.1 - Math.sqrt(v), 0, 1);
      blend(buf, w, h, x, y, c, cov * alpha);
    }
  }
}

function fillRect(buf: Uint8ClampedArray, w: number, x0: number, y0: number, rw: number, rh: number, c: RGB): void {
  for (let y = Math.max(0, y0); y < Math.min(buf.length / 4 / w, y0 + rh); y++) {
    for (let x = Math.max(0, x0); x < Math.min(w, x0 + rw); x++) {
      const o = (y * w + x) * 4;
      buf[o] = c.r;
      buf[o + 1] = c.g;
      buf[o + 2] = c.b;
      buf[o + 3] = 255;
    }
  }
}

interface Leaf {
  x: number;
  y: number;
  r: number;
  phase: number;
  color: RGB;
}
interface Pedestrian {
  startTime: number;
  duration: number;
  fromX: number;
  toX: number;
  baseY: number;
  scale: number;
  color: RGB;
}

interface Scene {
  base: Raster;
  leaves: Leaf[];
  pedestrians: Pedestrian[];
  rng: () => number;
}

function venuePalette(venue: VenueId): { ground: RGB[]; sky: RGB[]; accent: RGB } {
  if (venue === 'park') {
    return {
      ground: [
        { r: 96, g: 138, b: 72 },
        { r: 78, g: 118, b: 58 },
      ],
      sky: [
        { r: 198, g: 226, b: 238 },
        { r: 226, g: 240, b: 246 },
      ],
      accent: { r: 92, g: 70, b: 44 },
    };
  }
  if (venue === 'plaza') {
    return {
      ground: [
        { r: 188, g: 184, b: 172 },
        { r: 166, g: 162, b: 152 },
      ],
      sky: [
        { r: 210, g: 216, b: 226 },
        { r: 232, g: 234, b: 238 },
      ],
      accent: { r: 140, g: 90, b: 70 },
    };
  }
  return {
    ground: [
      { r: 202, g: 168, b: 120 },
      { r: 178, g: 144, b: 102 },
    ],
    sky: [
      { r: 228, g: 224, b: 214 },
      { r: 240, g: 238, b: 232 },
    ],
    accent: { r: 60, g: 80, b: 110 },
  };
}

function buildScene(cfg: RenderConfig): Scene {
  const { width: w, height: h } = cfg;
  const base = createRaster(w, h);
  const buf = base.data;
  const pal = venuePalette(cfg.venue);
  const horizon = Math.round(h * 0.42);
  const rng = mulberry32(cfg.seed);

  // 天空/墙面渐变
  for (let y = 0; y < horizon; y++) {
    const t = y / horizon;
    const c: RGB = {
      r: Math.round(pal.sky[0].r * (1 - t) + pal.sky[1].r * t),
      g: Math.round(pal.sky[0].g * (1 - t) + pal.sky[1].g * t),
      b: Math.round(pal.sky[0].b * (1 - t) + pal.sky[1].b * t),
    };
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      buf[o] = c.r;
      buf[o + 1] = c.g;
      buf[o + 2] = c.b;
      buf[o + 3] = 255;
    }
  }
  // 地面渐变
  for (let y = horizon; y < h; y++) {
    const t = (y - horizon) / (h - horizon);
    const c: RGB = {
      r: Math.round(pal.ground[0].r * (1 - t) + pal.ground[1].r * t),
      g: Math.round(pal.ground[0].g * (1 - t) + pal.ground[1].g * t),
      b: Math.round(pal.ground[0].b * (1 - t) + pal.ground[1].b * t),
    };
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      buf[o] = c.r;
      buf[o + 1] = c.g;
      buf[o + 2] = c.b;
      buf[o + 3] = 255;
    }
  }

  const leaves: Leaf[] = [];
  const pedestrians: Pedestrian[] = [];

  if (cfg.venue === 'park') {
    // 树干
    fillRect(buf, w, Math.round(w * 0.12), horizon - h * 0.3, Math.round(w * 0.03), Math.round(h * 0.34), {
      r: 104,
      g: 78,
      b: 50,
    });
    fillRect(buf, w, Math.round(w * 0.82), horizon - h * 0.34, Math.round(w * 0.035), Math.round(h * 0.38), {
      r: 96,
      g: 70,
      b: 44,
    });
    // 树冠:叶子(微风下亚像素级抖动,静态叶色在时序上仍占稳定多数)
    for (let i = 0; i < 170; i++) {
      const x = rng() * w;
      const y = rng() * horizon * 0.8;
      const green = 90 + rng() * 70;
      const leaf: Leaf = {
        x,
        y,
        r: 5 + rng() * 7,
        phase: rng() * Math.PI * 2,
        color: { r: 40 + rng() * 40, g: green, b: 36 + rng() * 30 },
      };
      leaves.push(leaf);
      // 静止叶色直接进入干净背景
      fillLeafBlock(base.data, w, h, x, y, Math.max(1, Math.round(leaf.r * 0.7)), leaf.color);
    }
    // 少量会漂移的落叶(全程移动,不会污染众数;负 phase 作为漂移标记)
    for (let i = 0; i < 14; i++) {
      leaves.push({
        x: rng() * w,
        y: rng() * horizon * 0.7,
        r: 3 + rng() * 2,
        phase: -(rng() * Math.PI * 2 + 0.1),
        color: { r: 150 + rng() * 60, g: 130 + rng() * 40, b: 50 },
      });
    }
  } else if (cfg.venue === 'plaza') {
    // 建筑与铺砖缝
    for (let i = 0; i < 5; i++) {
      const bw = w * (0.12 + rng() * 0.08);
      const bh = h * (0.16 + rng() * 0.16);
      const bx = rng() * w * 0.9;
      fillRect(buf, w, Math.round(bx), Math.round(horizon - bh), Math.round(bw), Math.round(bh), {
        r: 150 + rng() * 40,
        g: 140 + rng() * 30,
        b: 130 + rng() * 30,
      });
    }
    for (let y = horizon + 8; y < h; y += 22) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        buf[o] *= 0.82;
        buf[o + 1] *= 0.82;
        buf[o + 2] *= 0.82;
      }
    }
  } else {
    // 体育馆:肋木架与横幅
    for (let i = 0; i < 8; i++) {
      fillRect(buf, w, Math.round(w * 0.08) + i * 6, Math.round(h * 0.1), 2, Math.round(h * 0.26), {
        r: 70,
        g: 90,
        b: 120,
      });
    }
    fillRect(buf, w, Math.round(w * 0.6), Math.round(h * 0.08), Math.round(w * 0.28), Math.round(h * 0.08), {
      r: 180,
      g: 60,
      b: 60,
    });
    for (let y = horizon + 10; y < h; y += 26) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        buf[o] *= 0.9;
        buf[o + 1] *= 0.9;
        buf[o + 2] *= 0.9;
      }
    }
  }

  // 两名行人在不同时段路过(带自己的影子)
  const pedColors: RGB[] = [
    { r: 120, g: 96, b: 140 },
    { r: 90, g: 130, b: 110 },
  ];
  for (let i = 0; i < 2; i++) {
    pedestrians.push({
      startTime: cfg.durationSec * (0.18 + i * 0.34),
      duration: cfg.durationSec * 0.16,
      fromX: -w * 0.1,
      toX: w * 1.1,
      baseY: h * (0.72 + rng() * 0.1),
      scale: 0.55 + rng() * 0.2,
      color: pedColors[i],
    });
  }
  return { base, leaves, pedestrians, rng };
}

interface Pose {
  cx: number;
  groundY: number;
  shoulderY: number;
  hipY: number;
  headY: number;
  leftHand: { x: number; y: number };
  rightHand: { x: number; y: number };
  leftTip: { x: number; y: number };
  rightTip: { x: number; y: number };
  diabolo: { x: number; y: number; speed: number };
}

const TRICK_LABEL: Record<TrickId, string> = {
  toss: '抛接',
  exchange: '左右换手',
  string: '捞月',
};

function computePose(cfg: RenderConfig, t: number): Pose {
  const { width: w, height: h } = cfg;
  const s = h / 360;
  // 重心左右转移幅度必须超过身体半径,否则中心像素被身体长期占据、众数学到身体色
  const cx = w * 0.5 + Math.sin(t * 1.5) * 48 * s;
  const groundY = h * 0.86;
  const shoulderY = groundY - 110 * s;
  const hipY = groundY - 55 * s;
  const headY = shoulderY - 26 * s;
  const restY = shoulderY + 30 * s;
  const armReach = 52 * s;

  let lh = { x: cx - armReach * 0.7, y: restY };
  let rh = { x: cx + armReach * 0.7, y: restY };
  let diabolo = { x: cx, y: restY + 26 * s, speed: 0 };

  if (cfg.trick === 'toss') {
    const P = 2.2;
    const u = (t % P) / P;
    const arcH = 120 * s;
    const x = cx + Math.sin(t * 0.9) * 10 * s;
    const y = restY - arcH * 4 * u * (1 - u);
    const vy = (arcH * 4 * (2 * u - 1)) / P;
    diabolo = { x, y, speed: Math.abs(vy) };
    // 手随抛接小幅抬起
    lh = { x: cx - armReach * 0.6, y: restY - Math.sin(Math.PI * u) * 14 * s };
    rh = { x: cx + armReach * 0.6, y: restY - Math.sin(Math.PI * u) * 14 * s };
  } else if (cfg.trick === 'exchange') {
    const P = 1.8;
    const u = (t % P) / P;
    const half = u < 0.5 ? u * 2 : (1 - u) * 2; // 0..1..0
    const dir = u < 0.5 ? 1 : -1;
    const ease = half * half * (3 - 2 * half);
    const x = cx + dir * (ease - 0.5) * armReach * 1.6;
    const y = restY - Math.sin(Math.PI * half) * 70 * s;
    const vx = (dir * armReach * 1.6) / P;
    diabolo = { x, y, speed: Math.abs(vx) };
    lh = { x: cx - armReach * 0.7, y: restY + Math.sin(Math.PI * half) * 8 * s };
    rh = { x: cx + armReach * 0.7, y: restY + Math.sin(Math.PI * half) * 8 * s };
  } else {
    // 捞月:空竹在线上做竖直圆环
    const P = 2.0;
    const u = (t % P) / P;
    const ang = 2 * Math.PI * u - Math.PI / 2;
    const rx = 30 * s;
    const ry = 46 * s;
    const x = cx + Math.cos(ang) * rx;
    const y = restY + 10 * s + Math.sin(ang) * ry;
    const vx = (-Math.sin(ang) * rx * 2 * Math.PI) / P;
    const vy = (Math.cos(ang) * ry * 2 * Math.PI) / P;
    diabolo = { x, y, speed: Math.hypot(vx, vy) };
    lh = { x: cx - armReach * 0.75, y: restY + 6 * s };
    rh = { x: cx + armReach * 0.75, y: restY + 6 * s };
  }

  const stickLen = 26 * s;
  const leftTip = { x: lh.x + stickLen * 0.5, y: lh.y - stickLen * 0.85 };
  const rightTip = { x: rh.x - stickLen * 0.5, y: rh.y - stickLen * 0.85 };
  return {
    cx,
    groundY,
    shoulderY,
    hipY,
    headY,
    leftHand: lh,
    rightHand: rh,
    leftTip,
    rightTip,
    diabolo,
  };
}

/** 解析真值事件:按轨迹相位阈值跨帧检测 */
function collectTruthEvents(cfg: RenderConfig): TruthEvent[] {
  const frames = Math.round(cfg.fps * cfg.durationSec);
  const events: TruthEvent[] = [];
  const minGap = Math.round(cfg.fps * 0.3);
  const push = (frame: number, type: TruthEvent['type'], label: string) => {
    if (events.some((e) => Math.abs(e.frame - frame) < minGap)) return;
    events.push({ frame, time: frame / cfg.fps, type, label });
  };
  const phaseOf = (t: number): { u: number; half?: number } => {
    if (cfg.trick === 'toss') return { u: (t % 2.2) / 2.2 };
    if (cfg.trick === 'exchange') return { u: (t % 1.8) / 1.8 };
    return { u: (t % 2.0) / 2.0 };
  };
  let prevU = 0;
  for (let f = 0; f < frames; f++) {
    const t = f / cfg.fps;
    const { u } = phaseOf(t);
    if (f > 0 && u < prevU) {
      // 新周期开始:上一周期末尾是接住
      push(f - 1, 'catch', '接住');
    }
    if (cfg.trick === 'toss') {
      if (prevU < 0.5 && u >= 0.5) push(f, 'apex', '抛起最高点');
    } else if (cfg.trick === 'exchange') {
      if ((prevU < 0.25 && u >= 0.25) || (prevU < 0.75 && u >= 0.75)) push(f, 'switch', '换手');
      if (prevU < 0.5 && u >= 0.5) push(f, 'catch', '接住');
    } else {
      if (prevU < 0.25 && u >= 0.25) push(f, 'apex', '圆环顶点');
      if (prevU < 0.75 && u >= 0.75) push(f, 'catch', '回线接住');
    }
    prevU = u;
  }
  return events.sort((a, b) => a.frame - b.frame);
}

function drawPedestrian(buf: Uint8ClampedArray, cfg: RenderConfig, t: number, p: Pedestrian): void {
  const { width: w, height: h } = cfg;
  const local = (t - p.startTime) / p.duration;
  if (local < 0 || local > 1) return;
  const x = p.fromX + (p.toX - p.fromX) * local;
  const y = p.baseY;
  const s = p.scale * (h / 360);
  const shadow: RGB = { r: 30, g: 30, b: 28 };
  fillEllipse(buf, w, h, x, y + 4, 16 * s, 5 * s, shadow, 0.22);
  fillCircle(buf, null, w, h, x, y - 46 * s, 9 * s, p.color, 1);
  fillCapsule(buf, null, w, h, x, y - 36 * s, x, y - 12 * s, 12 * s, p.color, 1);
  const swing = Math.sin(local * Math.PI * 8) * 8 * s;
  fillCapsule(buf, null, w, h, x, y - 12 * s, x - 6 * s + swing, y, 7 * s, p.color, 1);
  fillCapsule(buf, null, w, h, x, y - 12 * s, x + 6 * s - swing, y, 7 * s, p.color, 1);
}

function drawPlayer(
  buf: Uint8ClampedArray,
  mask: Uint8Array,
  pose: Pose,
  cfg: RenderConfig,
  t: number,
): void {
  const { width: w, height: h } = cfg;
  const s = h / 360;
  const shadow: RGB = { r: 28, g: 30, b: 26 };
  // 影子随身体轻微移动,不会在任何像素长期停留
  fillEllipse(buf, w, h, pose.cx, pose.groundY + 4, 40 * s, 9 * s, shadow, 0.24);
  // 腿
  fillCapsule(buf, mask, w, h, pose.cx - 8 * s, pose.hipY, pose.cx - 12 * s, pose.groundY, 13 * s, PANTS, 1);
  fillCapsule(buf, mask, w, h, pose.cx + 8 * s, pose.hipY, pose.cx + 12 * s, pose.groundY, 13 * s, PANTS, 1);
  // 躯干
  fillCapsule(buf, mask, w, h, pose.cx, pose.hipY, pose.cx, pose.shoulderY, 30 * s, SHIRT, 1);
  // 头
  fillCircle(buf, mask, w, h, pose.cx, pose.headY, 13 * s, SKIN, 1);
  // 手臂
  fillCapsule(
    buf,
    mask,
    w,
    h,
    pose.cx - 12 * s,
    pose.shoulderY + 4 * s,
    pose.leftHand.x,
    pose.leftHand.y,
    9 * s,
    SKIN,
    1,
  );
  fillCapsule(
    buf,
    mask,
    w,
    h,
    pose.cx + 12 * s,
    pose.shoulderY + 4 * s,
    pose.rightHand.x,
    pose.rightHand.y,
    9 * s,
    SKIN,
    1,
  );
  // 竹杆
  fillCapsule(buf, mask, w, h, pose.leftHand.x, pose.leftHand.y, pose.leftTip.x, pose.leftTip.y, 3.5 * s, STICK, 1);
  fillCapsule(buf, mask, w, h, pose.rightHand.x, pose.rightHand.y, pose.rightTip.x, pose.rightTip.y, 3.5 * s, STICK, 1);
  // 线:细但保持高对比(真实尼龙线在逆光下呈亮线)
  fillThinLine(buf, mask, w, h, pose.leftTip.x, pose.leftTip.y, pose.rightTip.x, pose.rightTip.y, STRING, 0.85);

  // 空竹:高速时沿速度方向拖运动模糊残影(半透明)
  const d = pose.diabolo;
  const r = 11 * s;
  if (d.speed > 60 * s) {
    const ghosts = 2;
    for (let k = ghosts; k >= 1; k--) {
      const back = (k * r * 0.9) / Math.max(1, d.speed / (40 * s));
      const gx = d.x - back;
      const gy = d.y + back * 0.4;
      fillCircle(buf, mask, w, h, gx, gy, r * 0.9, DIABOLO, 0.35 * (ghosts - k + 1));
    }
  }
  fillCircle(buf, mask, w, h, d.x, d.y, r, DIABOLO, 1);
  fillCircle(buf, mask, w, h, d.x, d.y, r * 0.45, DIABOLO_DARK, 0.9);
  void t;
}

export function renderVideo(cfg: RenderConfig): RenderedVideo {
  const scene = buildScene(cfg);
  const frameCount = Math.round(cfg.fps * cfg.durationSec);
  const frames: RenderedFrame[] = [];
  const { width: w, height: h } = cfg;

  for (let f = 0; f < frameCount; f++) {
    const t = f / cfg.fps;
    const raster = createRaster(w, h);
    raster.data.set(scene.base.data);
    const buf = raster.data;
    const mask = new Uint8Array(w * h);

    // 树叶:冠层叶亚像素微风抖动;落叶(phase 标记为负)持续漂移
    for (const leaf of scene.leaves) {
      if (leaf.phase < 0) {
        const drift = ((t * 14 + leaf.phase * -97) % (w + 40)) - 20;
        const fall = (leaf.y + t * 10 * (1 + (leaf.phase % 1))) % (h * 0.6);
        fillCircle(buf, null, w, h, drift, fall, leaf.r, leaf.color, 0.9);
        continue;
      }
      // 0.7px 正弦摆动:多数帧取整后位置不变,众数仍为静止叶色
      const sway = Math.sin(t * 2.2 + leaf.phase) * 0.7;
      fillLeafBlock(buf, w, h, leaf.x + sway, leaf.y, Math.max(1, Math.round(leaf.r * 0.7)), leaf.color);
    }
    // 行人
    for (const p of scene.pedestrians) drawPedestrian(buf, cfg, t, p);
    // 选手与空竹
    const pose = computePose(cfg, t);
    drawPlayer(buf, mask, pose, cfg, t);

    // 传感器噪声(确定性),保证没有像素逐帧完全不变
    const noiseRng = mulberry32(cfg.seed * 100003 + f);
    for (let p = 0; p < w * h; p++) {
      const o = p * 4;
      const n = (noiseRng() - 0.5) * 5;
      buf[o] = clamp(buf[o] + n, 0, 255);
      buf[o + 1] = clamp(buf[o + 1] + n, 0, 255);
      buf[o + 2] = clamp(buf[o + 2] + n, 0, 255);
    }

    frames.push({
      width: w,
      height: h,
      data: buf,
      frameIndex: f,
      timestamp: t,
      truthMask: mask,
    });
  }

  const events = collectTruthEvents(cfg);
  const meta: DatasetMeta = {
    venue: cfg.venue,
    trick: cfg.trick,
    width: w,
    height: h,
    fps: cfg.fps,
    frameCount,
    duration: cfg.durationSec,
    events,
  };
  return { config: cfg, frames, meta, cleanBackground: scene.base };
}

export const VENUE_NAMES: Record<VenueId, string> = {
  park: '公园',
  plaza: '广场',
  gym: '体育馆',
};

export const TRICK_NAMES: Record<TrickId, string> = {
  toss: TRICK_LABEL.toss,
  exchange: TRICK_LABEL.exchange,
  string: TRICK_LABEL.string,
};
