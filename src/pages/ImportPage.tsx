import { useRef, useState } from 'react';
import { useApp } from '../state/store';

export function ImportPage() {
  const client = useApp((s) => s.client);
  const setDecoded = useApp((s) => s.setDecoded);
  const setPage = useApp((s) => s.setPage);
  const setBusy = useApp((s) => s.setBusy);
  const setError = useApp((s) => s.setError);
  const meta = useApp((s) => s.meta);
  const fileName = useApp((s) => s.fileName);
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = async (file: File) => {
    if (!client || !file.type.startsWith('video/')) {
      setError('请选择视频文件(MP4/WebM/MOV)');
      return;
    }
    setBusy(true);
    setError(null);
    const t0 = performance.now();
    try {
      const res = await client.decode(file, 320, 120);
      setDecoded(res.meta, res.scanFrames as never, res.fullFrames, file.name, res.fullFrameIndices, file);
      const secs = ((performance.now() - t0) / 1000).toFixed(1);
      console.info(`解码完成:${res.meta.frameCount} 帧,用时 ${secs}s,路径 ${res.meta.decoder}`);
      setPage('background');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="col" style={{ maxWidth: 900, margin: '0 auto', width: '100%' }}>
      <div
        className={`dropzone ${over ? 'over' : ''}`}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const f = e.dataTransfer.files[0];
          if (f) void handleFile(f);
        }}
      >
        <div style={{ fontSize: 18, marginBottom: 8 }}>把教学录像拖到这里,或点击选择</div>
        <div className="muted small">
          推荐 MP4(H.264/H.265);WebM 自动走 video 元素回退。1080p / 1 分钟以内效果最佳。
        </div>
        <input
          ref={inputRef}
          type="file"
          accept="video/*"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleFile(f);
          }}
        />
      </div>

      {meta && (
        <div className="panel col">
          <div className="row">
            <div className="metric">
              <b>{fileName}</b>
              <span className="muted small">当前录像</span>
            </div>
            <div className="metric">
              <b>
                {meta.width}×{meta.height}
              </b>
              <span className="muted small">分辨率</span>
            </div>
            <div className="metric">
              <b>{meta.fps.toFixed(1)} fps</b>
              <span className="muted small">帧率</span>
            </div>
            <div className="metric">
              <b>{meta.duration.toFixed(1)}s</b>
              <span className="muted small">时长 / {meta.frameCount} 帧</span>
            </div>
            <div className="metric">
              <b>{meta.decoder === 'webcodecs-mp4' ? 'WebCodecs' : '视频元素'}</b>
              <span className="muted small">解码路径 · {meta.codec.slice(0, 24)}</span>
            </div>
          </div>
          <div className="row">
            <button className="btn" onClick={() => setPage('background')}>
              进入背景估计 →
            </button>
            <button
              className="btn secondary"
              onClick={() => {
                useApp.getState().reset();
                window.location.reload();
              }}
            >
              重新选择录像
            </button>
          </div>
        </div>
      )}

      <div className="panel small muted">
        <b style={{ color: 'var(--text)' }}>处理管线</b>
        <ol>
          <li>Web Worker 内逐像素时序众数估计干净背景(树叶晃动、行人、影子都不进背景)</li>
          <li>低分辨率全片扫描,按空竹运动学自动定位顶点 / 换手 / 接住,与真值误差 ≤ 3 帧</li>
          <li>软阈值背景差分抠图,保留运动模糊半透明边与细线,连通域去噪</li>
          <li>WebGL2 按时间序合成,越早越淡,统一调色;支持增删时刻与手动修边</li>
        </ol>
      </div>
    </div>
  );
}
