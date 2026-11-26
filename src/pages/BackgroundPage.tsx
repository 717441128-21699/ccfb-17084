import { useMemo, useState } from 'react';
import { useApp } from '../state/store';
import { RasterCanvas } from '../components/RasterCanvas';
import { colorDistSq, downsample } from '../core/imageUtils';
import type { Raster } from '../core/types';

/** 背景覆盖率:每个像素有多少比例的采样帧与背景色接近,低覆盖区域可视化 */
function computeCoverage(background: Raster, frames: Raster[]): { mean: number; map: Raster } {
  const small = downsample(background, 240, Math.round((240 / background.width) * background.height));
  const npx = small.width * small.height;
  const hits = new Uint32Array(npx);
  for (const f of frames) {
    const fs = downsample(f, small.width, small.height);
    for (let p = 0; p < npx; p++) {
      const o = p * 4;
      if (
        colorDistSq(
          fs.data[o],
          fs.data[o + 1],
          fs.data[o + 2],
          small.data[o],
          small.data[o + 1],
          small.data[o + 2],
        ) <
        22 * 22
      ) {
        hits[p]++;
      }
    }
  }
  const map = new Uint8ClampedArray(npx * 4);
  let sum = 0;
  for (let p = 0; p < npx; p++) {
    const ratio = hits[p] / frames.length;
    sum += ratio;
    const o = p * 4;
    // 绿(高覆盖) -> 红(低覆盖,疑似残留)
    map[o] = Math.round(255 * (1 - ratio));
    map[o + 1] = Math.round(200 * ratio);
    map[o + 2] = 60;
    map[o + 3] = 255;
  }
  return { mean: sum / npx, map: { width: small.width, height: small.height, data: map } };
}

export function BackgroundPage() {
  const client = useApp((s) => s.client);
  const fullFrames = useApp((s) => s.fullFrames);
  const background = useApp((s) => s.background);
  const setBackground = useApp((s) => s.setBackground);
  const setBusy = useApp((s) => s.setBusy);
  const setError = useApp((s) => s.setError);
  const setPage = useApp((s) => s.setPage);
  const [refineTol, setRefineTol] = useState(18);
  const [stride, setStride] = useState(1);
  const [showMap, setShowMap] = useState(false);

  const coverage = useMemo(
    () => (background ? computeCoverage(background, fullFrames.slice(0, 60)) : null),
    [background, fullFrames],
  );

  const run = async () => {
    if (!client || fullFrames.length === 0) return;
    setBusy(true);
    setError(null);
    const t0 = performance.now();
    try {
      const res = await client.estimateBackground(fullFrames, fullFrames[0].width, fullFrames[0].height, {
        refineTolSq: refineTol * refineTol,
        stride,
      });
      setBackground(res.background);
      console.info(`背景估计用时 ${((performance.now() - t0) / 1000).toFixed(2)}s`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="layout">
      <div className="col" style={{ flex: 1, minWidth: 0 }}>
        <div className="row">
          <button className="btn" onClick={run} disabled={!fullFrames.length}>
            {background ? '重新估计背景' : '开始估计背景'}
          </button>
          {background && (
            <button className="btn secondary" onClick={() => setShowMap(!showMap)}>
              {showMap ? '查看背景' : '查看残留热力图'}
            </button>
          )}
          {background && (
            <button className="btn" onClick={() => setPage('moments')}>
              进入关键时刻挑选 →
            </button>
          )}
        </div>
        <div className="canvas-stage">
          {!background && <div className="muted">点击「开始估计背景」,Worker 将逐像素统计时序众数</div>}
          {background && showMap && coverage && <RasterCanvas raster={coverage.map} />}
          {background && (!showMap || !coverage) && <RasterCanvas raster={background} />}
        </div>
        {coverage && (
          <div className="row tight small muted">
            <span className="chip">
              平均背景覆盖率 <b style={{ color: 'var(--accent-2)' }}>{(coverage.mean * 100).toFixed(1)}%</b>
            </span>
            <span>热力图红色区域表示很少有帧与背景一致,需检查是否残留运动物体</span>
          </div>
        )}
      </div>

      <div className="panel sidebar col">
        <b>估计参数</b>
        <label className="field">
          颜色精修容差 {refineTol}
          <input
            type="range"
            min={6}
            max={40}
            value={refineTol}
            onChange={(e) => setRefineTol(Number(e.target.value))}
          />
        </label>
        <label className="field">
          帧采样步长 {stride}(大步长更快)
          <input
            type="range"
            min={1}
            max={4}
            value={stride}
            onChange={(e) => setStride(Number(e.target.value))}
          />
        </label>
        <div className="small muted">
          <p>
            <b>为什么不会留下选手/行人影子:</b>
            每个像素取全部采样帧里出现次数最多的颜色。选手持续移动,在任一像素停留的帧数远少于背景;行人只是路过;影子随人移动且颜色深,永远成不了众数。
          </p>
          <p>晃动树叶围绕真实叶色小幅抖动,众数仍落在叶色,二次均值还能压掉抖动。</p>
        </div>
        {fullFrames[0] && (
          <div className="col">
            <span className="muted small">原始采样帧对照</span>
            <div className="canvas-stage" style={{ minHeight: 160 }}>
              <RasterCanvas raster={fullFrames[Math.floor(fullFrames.length / 2)]} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
