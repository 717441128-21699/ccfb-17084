import { useEffect } from 'react';
import { useApp } from './state/store';
import { PipelineClient } from './core/pipelineClient';
import { ImportPage } from './pages/ImportPage';
import { BackgroundPage } from './pages/BackgroundPage';
import { MomentsPage } from './pages/MomentsPage';
import { EditorPage } from './pages/EditorPage';
import { DatasetStudio } from './pages/DatasetStudio';
import './styles.css';

const STEPS = [
  { id: 'import', label: '1 录像导入' },
  { id: 'background', label: '2 背景估计' },
  { id: 'moments', label: '3 关键时刻' },
  { id: 'editor', label: '4 分解图编辑' },
] as const;

export default function App() {
  const page = useApp((s) => s.page);
  const setPage = useApp((s) => s.setPage);
  const setClient = useApp((s) => s.setClient);
  const meta = useApp((s) => s.meta);
  const studioOpen = useApp((s) => s.studioOpen);
  const setStudioOpen = useApp((s) => s.setStudioOpen);
  const progress = useApp((s) => s.progress);
  const busy = useApp((s) => s.busy);
  const error = useApp((s) => s.error);

  useEffect(() => {
    const c = new PipelineClient();
    c.onProgress = (p) => useApp.setState({ progress: p });
    setClient(c);
    return () => c.dispose();
  }, [setClient]);

  const canOpen = (id: string) => {
    if (id === 'import') return true;
    if (!meta) return false;
    if (id === 'background') return true;
    if (id === 'moments') return useApp.getState().fullFrames.length > 0;
    if (id === 'editor') return useApp.getState().moments.length > 0;
    return false;
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">空竹频闪分解图工作台</div>
        <nav className="steps">
          {STEPS.map((st) => (
            <button
              key={st.id}
              className={`step ${page === st.id ? 'active' : ''} ${canOpen(st.id) ? '' : 'locked'}`}
              disabled={!canOpen(st.id)}
              onClick={() => setPage(st.id)}
            >
              {st.label}
            </button>
          ))}
        </nav>
        <button className="ghost" onClick={() => setStudioOpen(!studioOpen)}>
          {studioOpen ? '关闭数据集工作室' : '数据集工作室'}
        </button>
      </header>

      {busy && progress && (
        <div className="progress-bar">
          <span>
            {progress.stage} {progress.done}/{progress.total}
          </span>
          <div className="progress-track">
            <div
              className="progress-fill"
              style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }}
            />
          </div>
        </div>
      )}
      {error && (
        <div className="error-banner" onClick={() => useApp.setState({ error: null })}>
          出错了:{error}(点击关闭)
        </div>
      )}

      <main className="content">
        {page === 'import' && <ImportPage />}
        {page === 'background' && <BackgroundPage />}
        {page === 'moments' && <MomentsPage />}
        {page === 'editor' && <EditorPage />}
      </main>
      {studioOpen && <DatasetStudio onClose={() => setStudioOpen(false)} />}
    </div>
  );
}
