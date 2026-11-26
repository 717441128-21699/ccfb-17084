import { useMemo, useRef, useState } from 'react';
import { useApp } from '../state/store';
import { RasterCanvas } from '../components/RasterCanvas';
import type { Raster, TruthEvent } from '../core/types';

function FrameThumb({ frame, active, onClick, badge }: { frame: Raster; active?: boolean; onClick?: () => void; badge?: string }) {
  return (
    <button
      onClick={onClick}
      style={{
        border: active ? '2px solid var(--accent)' : '1px solid var(--line)',
        background: 'none',
        padding: 2,
        borderRadius: 6,
        position: 'relative',
        cursor: 'pointer',
        flex: '0 0 auto',
      }}
    >
      <canvas
        ref={(el) => {
          if (!el) return;
          if (el.width !== frame.width) el.width = frame.width;
          if (el.height !== frame.height) el.height = frame.height;
          el.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(frame.data), frame.width, frame.height), 0, 0);
        }}
        style={{ width: 96, height: 'auto', display: 'block', borderRadius: 4 }}
      />
      {badge && (
        <span
          style={{
            position: 'absolute',
            top: 2,
            left: 2,
            background: 'rgba(0,0,0,0.65)',
            fontSize: 10,
            padding: '1px 5px',
            borderRadius: 4,
          }}
        >
          {badge}
        </span>
      )}
    </button>
  );
}

export function MomentsPage() {
  const client = useApp((s) => s.client);
  const scanFrames = useApp((s) => s.scanFrames);
  const meta = useApp((s) => s.meta);
  const moments = useApp((s) => s.moments);
  const setMoments = useApp((s) => s.setMoments);
  const targetMomentCount = useApp((s) => s.targetMomentCount);
  const setTargetCount = useApp((s) => s.setTargetCount);
  const addMoment = useApp((s) => s.addMoment);
  const removeMoment = useApp((s) => s.removeMoment);
  const setBusy = useApp((s) => s.setBusy);
  const setError = useApp((s) => s.setError);
  const setPage = useApp((s) => s.setPage);
  const [selected, setSelected] = useState(0);
  const [truthText, setTruthText] = useState('');
  const [evalResult, setEvalResult] = useState<{ within3: number; total: number; maxFrameDiff: number; mean: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const framesByIndex = useMemo(() => {
    const m = new Map<number, Raster>();
    for (const f of scanFrames as (Raster & { frameIndex: number })[]) m.set(f.frameIndex, f);
    return m;
  }, [scanFrames]);

  const runDetect = async () => {
    if (!client || !meta) return;
    setBusy(true);
    setError(null);
    const t0 = performance.now();
    try {
      const res = await client.detectMoments(
        scanFrames as never,
        meta.fps,
        targetMomentCount,
      );
      setMoments(res.moments);
      setSelected(0);
      console.info(`关键时刻检测用时 ${((performance.now() - t0) / 1000).toFixed(2)}s`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const evaluate = () => {
    try {
      const truth = JSON.parse(truthText) as TruthEvent[];
      let maxDiff = 0;
      let sum = 0;
      let within3 = 0;
      for (const t of truth) {
        const best = Math.min(...moments.map((m) => Math.abs(m.frameIndex - t.frame)));
        maxDiff = Math.max(maxDiff, best);
        sum += best;
        if (best <= 3) within3++;
      }
      setEvalResult({ within3, total: truth.length, maxFrameDiff: maxDiff, mean: sum / truth.length });
    } catch (e) {
      setError('真值 JSON 解析失败:' + (e as Error).message);
    }
  };

  const selectedFrame = moments[selected] ? framesByIndex.get(moments[selected].frameIndex) : null;

  return (
    <div className="layout">
      <div className="col" style={{ flex: 1, minWidth: 0 }}>
        <div className="row">
          <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            时刻数量
            <input
              type="number"
              min={2}
              max={12}
              value={targetMomentCount}
              style={{ width: 70 }}
              onChange={(e) => setTargetCount(Number(e.target.value))}
            />
          </label>
          <button className="btn" onClick={runDetect}>
            自动挑选关键时刻
          </button>
          {moments.length > 0 && (
            <button className="btn" onClick={() => setPage('editor')}>
              进入分解图编辑 →
            </button>
          )}
        </div>

        <div className="canvas-stage" style={{ minHeight: 280 }}>
          {selectedFrame ? (
            <RasterCanvas raster={selectedFrame} />
          ) : (
            <div className="muted">自动挑选将定位抛起最高点、换手、接住等动作转折</div>
          )}
        </div>

        <div className="panel col">
          <b>时间轴(点击任意帧可手动加入/查看)</b>
          <div ref={scrollRef} style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 6 }}>
            {(scanFrames as (Raster & { frameIndex: number; timestamp: number })[]).map((f) => {
              const mi = moments.findIndex((m) => m.frameIndex === f.frameIndex);
              return (
                <FrameThumb
                  key={f.frameIndex}
                  frame={f}
                  active={mi >= 0}
                  badge={mi >= 0 ? `#${mi + 1} ${moments[mi].label}` : undefined}
                  onClick={() => {
                    if (mi >= 0) setSelected(mi);
                    else addMoment(f.frameIndex);
                  }}
                />
              );
            })}
          </div>
        </div>
      </div>

      <div className="panel sidebar col">
        <b>已选关键时刻({moments.length})</b>
        <div className="moment-list">
          {moments.map((m, i) => (
            <div key={m.id} className="moment-item">
              <button className="ghost small" onClick={() => setSelected(i)}>
                #{i + 1}
              </button>
              <span className={`chip ${m.eventType}`}>{m.label}</span>
              <span className="muted small">
                帧 {m.frameIndex} · {m.timestamp.toFixed(2)}s
              </span>
              <button className="btn danger small" style={{ marginLeft: 'auto', padding: '2px 8px' }} onClick={() => removeMoment(m.id)}>
                删
              </button>
            </div>
          ))}
          {moments.length === 0 && <span className="muted small">尚未挑选</span>}
        </div>

        <div className="col">
          <b className="small">真值评估(粘贴 events JSON)</b>
          <textarea
            rows={5}
            style={{ background: 'var(--panel-2)', border: '1px solid var(--line)', color: 'var(--text)', borderRadius: 6 }}
            placeholder='[{"frame":12,"type":"apex",...}]'
            value={truthText}
            onChange={(e) => setTruthText(e.target.value)}
          />
          <button className="btn secondary" onClick={evaluate} disabled={!truthText || moments.length === 0}>
            计算帧差
          </button>
          {evalResult && (
            <div className="col small">
              <span className="chip">
                3 帧内命中 <b>{evalResult.within3}/{evalResult.total}</b>
              </span>
              <span className="muted">
                平均帧差 {evalResult.mean.toFixed(2)} · 最大帧差 {evalResult.maxFrameDiff}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
