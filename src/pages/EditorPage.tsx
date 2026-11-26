import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../state/store';
import { GLCompositor } from '../webgl/glCompositor';
import { paintMatte } from '../core/background';
import { DEFAULT_GRADE } from '../core/types';
import type { MatteLayer, Raster } from '../core/types';
import { RasterCanvas } from '../components/RasterCanvas';

type BrushMode = 'add' | 'erase';

export function EditorPage() {
  const client = useApp((s) => s.client);
  const file = useApp((s) => s.file);
  const background = useApp((s) => s.background);
  const fullFrames = useApp((s) => s.fullFrames);
  const fullFrameIndices = useApp((s) => s.fullFrameIndices);
  const moments = useApp((s) => s.moments);
  const mattes = useApp((s) => s.mattes);
  const setMatte = useApp((s) => s.setMatte);
  const grade = useApp((s) => s.grade);
  const setGrade = useApp((s) => s.setGrade);
  const earliestOpacity = useApp((s) => s.earliestOpacity);
  const setEarliestOpacity = useApp((s) => s.setEarliestOpacity);
  const bgSettings = useApp((s) => s.bgSettings);
  const setBgSettings = useApp((s) => s.setBgSettings);
  const setBusy = useApp((s) => s.setBusy);
  const setError = useApp((s) => s.setError);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const compositorRef = useRef<GLCompositor | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const [brush, setBrush] = useState<BrushMode>('add');
  const [brushRadius, setBrushRadius] = useState(14);
  const [showMatteOnly, setShowMatteOnly] = useState(false);
  const [exactFrames, setExactFrames] = useState<Map<number, Raster>>(new Map());
  const painting = useRef(false);

  // 每个时刻对应的全分辨率帧:优先按需提取的精确帧,否则回退到最近抽样帧
  const momentFrames = useMemo(() => {
    return moments.map((m) => {
      const exact = exactFrames.get(m.frameIndex);
      if (exact) return { moment: m, frame: exact, fullIndex: m.frameIndex, slot: -1 };
      let best = 0;
      let bestD = Infinity;
      fullFrameIndices.forEach((fi, i) => {
        const d = Math.abs(fi - m.frameIndex);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      });
      return { moment: m, frame: fullFrames[best], fullIndex: fullFrameIndices[best], slot: best };
    });
  }, [moments, fullFrames, fullFrameIndices, exactFrames]);

  // 进入编辑器时按真实帧号提取全分辨率帧(WebCodecs 路径;回退路径返回空,自动用最近邻)
  useEffect(() => {
    if (!client || !file || moments.length === 0) return;
    let cancelled = false;
    const need = moments.filter((m) => !exactFrames.has(m.frameIndex)).map((m) => m.frameIndex);
    if (need.length === 0) return;
    setBusy(true);
    client
      .extractFrames(file, need)
      .then((res) => {
        if (cancelled || res.frames.length === 0) return;
        setExactFrames((prev) => {
          const next = new Map(prev);
          res.frameIndices.forEach((fi, i) => next.set(fi, res.frames[i]));
          return next;
        });
      })
      .catch((e) => console.warn('精确帧提取失败,使用最近邻抽样帧:', e))
      .finally(() => !cancelled && setBusy(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, file, moments.length]);

  useEffect(() => {
    if (!canvasRef.current) return;
    try {
      compositorRef.current = new GLCompositor(canvasRef.current);
    } catch (e) {
      setError((e as Error).message);
    }
    return () => compositorRef.current?.dispose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 合成刷新
  useEffect(() => {
    const gl = compositorRef.current;
    if (!gl || !background) return;
    const layers = momentFrames
      .filter((mf) => mattes.has(mf.fullIndex))
      .sort((a, b) => a.moment.frameIndex - b.moment.frameIndex)
      .map((mf, i, arr) => ({
        raster: mattes.get(mf.fullIndex)!,
        fade: arr.length <= 1 ? 1 : earliestOpacity + (1 - earliestOpacity) * (i / (arr.length - 1)),
      }));
    gl.render(background, layers, grade);
  }, [background, momentFrames, mattes, grade, earliestOpacity]);

  const matteAll = async () => {
    if (!client || !background) return;
    setBusy(true);
    setError(null);
    const t0 = performance.now();
    try {
      for (const mf of momentFrames) {
        const existing = mattes.get(mf.fullIndex);
        if (existing) continue;
        const res = await client.matte(mf.frame, background, {
          hardTolSq: bgSettings.hardTol ** 2,
          softBandSq: bgSettings.softBand ** 2,
          featherRadius: bgSettings.feather,
          dilateRadius: bgSettings.dilate,
          minComponentRatio: bgSettings.minComponent,
        });
        const layer: MatteLayer = {
          ...res.matte,
          frameIndex: mf.moment.frameIndex,
          timestamp: mf.moment.timestamp,
          label: mf.moment.label,
        };
        setMatte(mf.fullIndex, layer);
      }
      console.info(`全部抠图用时 ${((performance.now() - t0) / 1000).toFixed(2)}s`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const rematteOne = async (slot: number) => {
    if (!client || !background) return;
    const mf = momentFrames[slot];
    setBusy(true);
    try {
      const res = await client.matte(mf.frame, background, {
        hardTolSq: bgSettings.hardTol ** 2,
        softBandSq: bgSettings.softBand ** 2,
        featherRadius: bgSettings.feather,
        dilateRadius: bgSettings.dilate,
        minComponentRatio: bgSettings.minComponent,
      });
      setMatte(mf.fullIndex, {
        ...res.matte,
        frameIndex: mf.moment.frameIndex,
        timestamp: mf.moment.timestamp,
        label: mf.moment.label,
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const activeMatte: MatteLayer | undefined = momentFrames[activeIdx]
    ? mattes.get(momentFrames[activeIdx].fullIndex)
    : undefined;

  const handlePaint = (p: { x: number; y: number; kind: 'down' | 'move' | 'up'; button: number }) => {
    if (!activeMatte) return;
    if (p.kind === 'down') painting.current = true;
    if (p.kind === 'up') {
      painting.current = false;
      return;
    }
    if (!painting.current && p.kind !== 'down') return;
    const copy: MatteLayer = {
      ...activeMatte,
      data: new Uint8ClampedArray(activeMatte.data),
    };
    paintMatte(copy, p.x, p.y, brushRadius, brush === 'add' ? 1 : 1, brush);
    const mf = momentFrames[activeIdx];
    setMatte(mf.fullIndex, copy);
  };

  const mattePreview: Raster | null = useMemo(() => {
    if (!activeMatte) return null;
    if (!showMatteOnly) return activeMatte;
    const d = new Uint8ClampedArray(activeMatte.data.length);
    for (let p = 0; p < activeMatte.width * activeMatte.height; p++) {
      const o = p * 4;
      const a = activeMatte.data[o + 3];
      d[o] = a;
      d[o + 1] = a;
      d[o + 2] = a;
      d[o + 3] = 255;
    }
    return { width: activeMatte.width, height: activeMatte.height, data: d };
  }, [activeMatte, showMatteOnly]);

  const exportPng = () => {
    const gl = compositorRef.current;
    if (!gl) return;
    const img = gl.readPixels();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    c.getContext('2d')!.putImageData(img, 0, 0);
    c.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'diabolo-strobe.png';
      a.click();
      URL.revokeObjectURL(a.href);
    }, 'image/png');
  };

  return (
    <div className="layout">
      <div className="col" style={{ flex: 1, minWidth: 0 }}>
        <div className="toolbar">
          <button className="btn" onClick={matteAll} disabled={!background || momentFrames.length === 0}>
            一键抠全部时刻
          </button>
          <button className="btn secondary" onClick={() => rematteOne(activeIdx)} disabled={!activeMatte}>
            按当前参数重抠本层
          </button>
          <button className="btn secondary" onClick={exportPng} disabled={mattes.size === 0}>
            导出 PNG
          </button>
          <label className="row tight small muted" style={{ gap: 4 }}>
            <input type="checkbox" checked={showMatteOnly} onChange={(e) => setShowMatteOnly(e.target.checked)} />
            只看蒙版
          </label>
        </div>
        <div className="canvas-stage">
          {showMatteOnly && mattePreview ? (
            <RasterCanvas
              raster={mattePreview}
              cursor="crosshair"
              onPointer={handlePaint}
            />
          ) : (
            <canvas ref={canvasRef} style={{ maxWidth: '100%', maxHeight: '100%' }} />
          )}
        </div>
        {!showMatteOnly && activeMatte && (
          <div className="small muted">修边模式下可直接在合成图对应的蒙版上涂抹(切到「只看蒙版」更精确)</div>
        )}
        <div className="row tight" style={{ overflowX: 'auto' }}>
          {momentFrames.map((mf, i) => (
            <div key={mf.moment.id} className="col" style={{ alignItems: 'center', gap: 4 }}>
              <button
                className={`chip ${i === activeIdx ? 'active' : ''}`}
                style={i === activeIdx ? { borderColor: 'var(--accent)' } : undefined}
                onClick={() => setActiveIdx(i)}
              >
                #{i + 1} {mf.moment.label}
              </button>
              <div className="small muted">
                帧 {mf.moment.frameIndex}
                {mattes.has(mf.fullIndex) ? ' · 已抠' : ' · 待抠'}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="panel sidebar col">
        <b>抠图参数</b>
        <label className="field">
          硬阈值 {bgSettings.hardTol}
          <input
            type="range"
            min={20}
            max={90}
            value={bgSettings.hardTol}
            onChange={(e) => setBgSettings({ hardTol: Number(e.target.value) })}
          />
        </label>
        <label className="field">
          软边带宽 {bgSettings.softBand}
          <input
            type="range"
            min={6}
            max={50}
            value={bgSettings.softBand}
            onChange={(e) => setBgSettings({ softBand: Number(e.target.value) })}
          />
        </label>
        <label className="field">
          羽化半径 {bgSettings.feather}px
          <input
            type="range"
            min={0}
            max={6}
            value={bgSettings.feather}
            onChange={(e) => setBgSettings({ feather: Number(e.target.value) })}
          />
        </label>
        <label className="field">
          细线保护膨胀 {bgSettings.dilate}px
          <input
            type="range"
            min={0}
            max={5}
            value={bgSettings.dilate}
            onChange={(e) => setBgSettings({ dilate: Number(e.target.value) })}
          />
        </label>

        <b style={{ marginTop: 6 }}>修边画笔</b>
        <div className="row tight">
          <button className={`btn ${brush === 'add' ? '' : 'secondary'}`} onClick={() => setBrush('add')}>
            加回
          </button>
          <button className={`btn ${brush === 'erase' ? 'danger' : 'secondary'}`} onClick={() => setBrush('erase')}>
            擦除
          </button>
        </div>
        <label className="field">
          笔刷半径 {brushRadius}px
          <input type="range" min={4} max={60} value={brushRadius} onChange={(e) => setBrushRadius(Number(e.target.value))} />
        </label>

        <b style={{ marginTop: 6 }}>统一调色</b>
        <label className="field">
          亮度 {grade.brightness.toFixed(2)}
          <input type="range" min={-1} max={1} step={0.01} value={grade.brightness} onChange={(e) => setGrade({ brightness: Number(e.target.value) })} />
        </label>
        <label className="field">
          对比度 {grade.contrast.toFixed(2)}
          <input type="range" min={-1} max={1} step={0.01} value={grade.contrast} onChange={(e) => setGrade({ contrast: Number(e.target.value) })} />
        </label>
        <label className="field">
          饱和度 {grade.saturation.toFixed(2)}
          <input type="range" min={-1} max={1} step={0.01} value={grade.saturation} onChange={(e) => setGrade({ saturation: Number(e.target.value) })} />
        </label>
        <label className="field">
          伽马 {grade.gamma.toFixed(2)}
          <input type="range" min={0.5} max={2} step={0.01} value={grade.gamma} onChange={(e) => setGrade({ gamma: Number(e.target.value) })} />
        </label>
        <button className="btn secondary" onClick={() => setGrade({ ...DEFAULT_GRADE })}>
          重置调色
        </button>

        <b style={{ marginTop: 6 }}>时序淡化</b>
        <label className="field">
          最早一层不透明度 {earliestOpacity.toFixed(2)}
          <input type="range" min={0.15} max={1} step={0.01} value={earliestOpacity} onChange={(e) => setEarliestOpacity(Number(e.target.value))} />
        </label>
        <div className="small muted">图层按帧号升序 over 混合,后一时刻必然压住前一时刻,遮挡顺序不会乱。</div>
      </div>
    </div>
  );
}
