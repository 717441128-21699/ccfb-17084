/* 性能基准:按 1 分钟 1080p 录像的真实数据规模分段计时
   运行:npm run bench
   说明:Node 内无 DOM/GL,合成段用 CPU 参考实现计时;WebGL2 路径在浏览器里更快(GPU) */
import { estimateTemporalModeBackground, matteFrame } from '../src/core/background';
import { selectKeyMoments } from '../src/core/keyMoments';
import { compositeLayers } from '../src/core/compositor';
import { renderVideo, type RenderConfig } from '../src/core/synthRenderer';
import { downsample, createRaster } from '../src/core/imageUtils';
import type { Raster } from '../src/core/types';

const W = 1920;
const H = 1080;
const FPS = 30;
const DURATION = 60;
const FULL_SAMPLES = 120; // 与 UI 默认 fullResLimit 一致
const TARGET_MOMENTS = 6;

function makeNoisyFrame(i: number): Raster {
  const r = createRaster(W, H);
  // 草地 + 噪声,模拟相机传感器
  for (let p = 0; p < W * H; p++) {
    const o = p * 4;
    const n = ((i * 31 + p * 7) % 11) - 5;
    r.data[o] = 90 + n;
    r.data[o + 1] = 130 + n;
    r.data[o + 2] = 70 + n;
    r.data[o + 3] = 255;
  }
  // 移动的"选手"色块,每帧位置不同
  const bx = (i * 23) % W;
  for (let y = 300; y < 760; y++) {
    for (let x = bx; x < Math.min(W, bx + 160); x++) {
      const o = (y * W + x) * 4;
      r.data[o] = 40;
      r.data[o + 1] = 110;
      r.data[o + 2] = 190;
    }
  }
  return r;
}

function time<T>(label: string, fn: () => T): T {
  const t0 = performance.now();
  const out = fn();
  const ms = performance.now() - t0;
  console.log(`${label.padEnd(28)} ${(ms / 1000).toFixed(2)} s`);
  return out;
}

console.log(`\n=== 1080p / ${DURATION}s / ${FPS}fps 数据规模基准 ===\n`);

// 1) 全分辨率背景帧(240 张均匀抽样)
const fullFrames = time(`生成 ${FULL_SAMPLES} 张 1080p 帧`, () =>
  Array.from({ length: FULL_SAMPLES }, (_, i) => makeNoisyFrame(i)),
);

const bg = time(`时序众数背景估计(${FULL_SAMPLES} 帧,stride=2)`, () =>
  estimateTemporalModeBackground(fullFrames, W, H, { stride: 2 }),
);

// 2) 扫描帧:全片 1800 帧降采样到 320 宽
const scanCfg: RenderConfig = {
  venue: 'park',
  trick: 'toss',
  width: 320,
  height: 180,
  fps: FPS,
  durationSec: DURATION,
  seed: 7,
};
const synth = time('生成 320p 全片扫描帧(1800 帧)', () => renderVideo(scanCfg));
const scanFrames = synth.frames.map((f) => ({ ...f }));

const moments = time(`关键时刻检测(${scanFrames.length} 扫描帧,目标 ${TARGET_MOMENTS})`, () =>
  selectKeyMoments(scanFrames, { fps: FPS, targetCount: TARGET_MOMENTS }),
);
console.log('  选出帧:', moments.map((m) => m.frameIndex).join(', '));

// 3) 6 个时刻的全分辨率抠图
const mattes = time(`软抠图 ×${TARGET_MOMENTS} 张 1080p`, () =>
  moments.map((_m, i) => matteFrame(fullFrames[i % fullFrames.length], bg, {})),
);

// 4) CPU 参考合成(浏览器里该步骤走 WebGL2,显著更快)
const layers = mattes.map((m, i) => ({ ...m, frameIndex: moments[i].frameIndex, timestamp: i }));
time(`CPU 参考合成 ${TARGET_MOMENTS} 层`, () => compositeLayers(bg, layers, {}));

console.log('\n=== 端到端(不含视频解码;解码在 Worker 内与分析并行) ===');
const t0 = performance.now();
const bg2 = estimateTemporalModeBackground(fullFrames, W, H, { stride: 2 });
const mm = selectKeyMoments(scanFrames, { fps: FPS, targetCount: TARGET_MOMENTS });
const mt = mm.map((_m, i) => matteFrame(fullFrames[i % fullFrames.length], bg2, {}));
compositeLayers(bg2, mt.map((m, i) => ({ ...m, frameIndex: mm[i].frameIndex, timestamp: i })), {});
console.log(`总计 ${((performance.now() - t0) / 1000).toFixed(2)} s(预算 20 s)\n`);

// 5) 数据集渲染器小规模计时(9 组 480p)
const t1 = performance.now();
for (const venue of ['park', 'plaza', 'gym'] as const) {
  for (const trick of ['toss', 'exchange', 'string'] as const) {
    renderVideo({ venue, trick, width: 480, height: 270, fps: 30, durationSec: 9, seed: 1 });
  }
}
console.log(`9 组 480p/270 帧数据集渲染: ${((performance.now() - t1) / 1000).toFixed(2)} s`);
void downsample;
