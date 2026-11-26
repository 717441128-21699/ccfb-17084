import { useState } from 'react';
import { renderVideo, VENUE_NAMES, TRICK_NAMES } from '../core/synthRenderer';
import type { RenderConfig, VenueId, TrickId } from '../core/synthRenderer';
import type { DatasetMeta, Raster, TruthEvent } from '../core/types';
import { selectKeyMoments, evaluateAgainstTruth } from '../core/keyMoments';
import { estimateTemporalModeBackground, matteFrame } from '../core/background';
import { compositeLayers } from '../core/compositor';
import { colorDistSq } from '../core/imageUtils';
import { RasterCanvas } from '../components/RasterCanvas';

interface ComboResult {
  key: string;
  meta: DatasetMeta;
  preview: Raster;
  composite: Raster;
  residual: number;
  meanIoU: number;
  hardIoU: number;
  evalReport: ReturnType<typeof evaluateAgainstTruth>;
  timingMs: number;
}

const VENUES: VenueId[] = ['park', 'plaza', 'gym'];
const TRICKS: TrickId[] = ['toss', 'exchange', 'string'];

function rasterToCanvas(r: Raster): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = r.width;
  c.height = r.height;
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(r.data), r.width, r.height), 0, 0);
  return c;
}

async function encodeWebM(frames: Raster[], fps: number): Promise<Blob> {
  const c = document.createElement('canvas');
  c.width = frames[0].width;
  c.height = frames[0].height;
  const ctx = c.getContext('2d')!;
  const stream = c.captureStream(fps);
  const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm';
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000 });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => chunks.push(e.data);
  const done = new Promise<Blob>((resolve) => {
    rec.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' }));
  });
  rec.start();
  for (const f of frames) {
    ctx.putImageData(new ImageData(new Uint8ClampedArray(f.data), f.width, f.height), 0, 0);
    await new Promise((r) => setTimeout(r, 1000 / fps / 2));
  }
  rec.stop();
  return done;
}

function download(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** 二值蒙版游程编码:交替记录 0 段/1 段长度,首段从 0 开始 */
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

export function DatasetStudio({ onClose }: { onClose: () => void }) {
  const [results, setResults] = useState<ComboResult[]>([]);
  const [running, setRunning] = useState(false);
  const [selected, setSelected] = useState<ComboResult | null>(null);

  const runAll = () => {
    setRunning(true);
    setTimeout(() => {
      const out: ComboResult[] = [];
      for (const venue of VENUES) {
        for (const trick of TRICKS) {
          const t0 = performance.now();
          const cfg: RenderConfig = {
            venue,
            trick,
            width: 480,
            height: 270,
            fps: 30,
            durationSec: 9,
            seed: 1000 + VENUES.indexOf(venue) * 100 + TRICKS.indexOf(trick),
          };
          const video = renderVideo(cfg);
          // 1) 背景估计(全帧)
          const bg = estimateTemporalModeBackground(
            video.frames.map((f) => ({ width: f.width, height: f.height, data: f.data })),
            cfg.width,
            cfg.height,
            { stride: 1 },
          );
          // 残留:对真值干净背景做差异
          let residual = 0;
          for (let p = 0; p < cfg.width * cfg.height; p++) {
            const o = p * 4;
            if (
              colorDistSq(
                bg.data[o],
                bg.data[o + 1],
                bg.data[o + 2],
                video.cleanBackground.data[o],
                video.cleanBackground.data[o + 1],
                video.cleanBackground.data[o + 2],
              ) >
              18 * 18
            ) {
              residual++;
            }
          }
          residual /= cfg.width * cfg.height;

          // 2) 关键时刻(扫描帧直接用合成帧)
          const moments = selectKeyMoments(
            video.frames.map((f) => ({ ...f })),
            { fps: cfg.fps, targetCount: 6 },
          );
          const evalReport = evaluateAgainstTruth(moments, video.meta.events);

          // 3) 对每个时刻抠图并与真值蒙版算软/硬 IoU
          let hardSum = 0;
          let softSum = 0;
          const layers = moments.map((m) => {
            const frame = video.frames[m.frameIndex];
            const matte = matteFrame(frame, bg, {});
            let hardInter = 0;
            let hardUnion = 0;
            let softInter = 0;
            let softUnion = 0;
            for (let p = 0; p < cfg.width * cfg.height; p++) {
              const a = matte.data[p * 4 + 3] / 255;
              const hard = a > 0.43 ? 1 : 0;
              const truth = frame.truthMask[p];
              if (hard && truth) hardInter++;
              if (hard || truth) hardUnion++;
              softInter += Math.min(a, truth);
              softUnion += Math.max(a, truth);
            }
            hardSum += hardInter / Math.max(1, hardUnion);
            softSum += softInter / Math.max(1, softUnion);
            return { ...matte, frameIndex: m.frameIndex, timestamp: m.timestamp };
          });
          const composite = compositeLayers(bg, layers, {});

          out.push({
            key: `${venue}-${trick}`,
            meta: video.meta,
            preview: video.frames[Math.floor(video.frames.length / 2)],
            composite,
            residual,
            meanIoU: softSum / layers.length,
            hardIoU: hardSum / layers.length,
            evalReport,
            timingMs: performance.now() - t0,
          });
        }
      }
      setResults(out);
      setRunning(false);
    }, 30);
  };

  const exportCombo = async (key: string) => {
    const [venue, trick] = key.split('-') as [VenueId, TrickId];
    const cfg: RenderConfig = {
      venue,
      trick,
      width: 640,
      height: 360,
      fps: 30,
      durationSec: 9,
      seed: 1000 + VENUES.indexOf(venue) * 100 + TRICKS.indexOf(trick),
    };
    const video = renderVideo(cfg);
    const blob = await encodeWebM(video.frames, cfg.fps);
    download(blob, `${key}.webm`);
    // 真值包:事件 + 每帧二值蒙版(RLE)+ 干净背景说明
    const truthPayload = {
      ...video.meta,
      maskEncoding: 'RLE:runs alternate zero-run/one-run lengths, starting with zero',
      masks: video.frames.map((f) => ({ frame: f.frameIndex, rle: encodeMaskRLE(f.truthMask) })),
    };
    download(
      new Blob([JSON.stringify(truthPayload)], { type: 'application/json' }),
      `${key}.meta.json`,
    );
  };

  const exportComposite = (r: ComboResult) => {
    rasterToCanvas(r.composite).toBlob((b) => b && download(b, `${r.key}-strobe.png`), 'image/png');
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0 }}>数据集工作室 · 3 场地 × 3 花样 = 9 组带真值教学录像</h3>
          <button className="ghost" onClick={onClose}>
            关闭
          </button>
        </div>
        <div className="row" style={{ margin: '12px 0' }}>
          <button className="btn" onClick={runAll} disabled={running}>
            {running ? '渲染中…' : '渲染并跑完整流水线评估'}
          </button>
          <span className="muted small">
            每组输出:时序众数背景残留率、关键时刻与真值帧差、抠图蒙版 IoU、合成图、端到端耗时
          </span>
        </div>

        {results.length > 0 && (
          <table className="grid">
            <thead>
              <tr>
                <th>场地/花样</th>
                <th>背景残留率</th>
                <th>3 帧内命中</th>
                <th>平均帧差</th>
                <th>最大帧差</th>
                <th>蒙版软 IoU</th>
                <th>硬 IoU</th>
                <th>耗时</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r) => (
                <tr key={r.key}>
                  <td>
                    {VENUE_NAMES[r.meta.venue as VenueId]} · {TRICK_NAMES[r.meta.trick as TrickId]}
                  </td>
                  <td style={{ color: r.residual < 0.02 ? 'var(--accent-2)' : 'var(--danger)' }}>
                    {(r.residual * 100).toFixed(2)}%
                  </td>
                  <td style={{ color: r.evalReport.within3 === r.evalReport.total ? 'var(--accent-2)' : 'var(--warn)' }}>
                    {r.evalReport.within3}/{r.evalReport.total}
                  </td>
                  <td>{r.evalReport.meanFrameDiff.toFixed(2)}</td>
                  <td>{r.evalReport.maxFrameDiff}</td>
                  <td>{(r.meanIoU * 100).toFixed(1)}%</td>
                  <td>{(r.hardIoU * 100).toFixed(1)}%</td>
                  <td>{(r.timingMs / 1000).toFixed(2)}s</td>
                  <td>
                    <div className="row tight">
                      <button className="ghost small" onClick={() => setSelected(r)}>
                        看合成图
                      </button>
                      <button className="ghost small" onClick={() => void exportCombo(r.key)}>
                        WebM+真值
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {selected && (
          <div className="panel col" style={{ marginTop: 14 }}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <b>
                {VENUE_NAMES[selected.meta.venue as VenueId]} · {TRICK_NAMES[selected.meta.trick as TrickId]} 合成分解图(6 时刻)
              </b>
              <div className="row tight">
                <button className="ghost" onClick={() => exportComposite(selected)}>
                  下载 PNG
                </button>
                <button className="ghost" onClick={() => setSelected(null)}>
                  收起
                </button>
              </div>
            </div>
            <div style={{ maxHeight: 420, overflow: 'auto' }}>
              <RasterCanvas raster={selected.composite} />
            </div>
            <div className="small muted">
              真值事件:
              {selected.meta.events.map((e: TruthEvent) => `帧${e.frame}(${e.label})`).join('、')}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
