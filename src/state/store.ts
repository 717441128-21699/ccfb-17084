import { create } from 'zustand';
import type { GradeParams, KeyMoment, MatteLayer, PipelineProgress, Raster, VideoMeta } from '../core/types';
import { DEFAULT_GRADE } from '../core/types';
import type { PipelineClient } from '../core/pipelineClient';

export type PageId = 'import' | 'background' | 'moments' | 'editor';

export interface BackgroundSettings {
  hardTol: number;
  softBand: number;
  feather: number;
  dilate: number;
  minComponent: number;
}

export const DEFAULT_BG_SETTINGS: BackgroundSettings = {
  hardTol: 42,
  softBand: 22,
  feather: 1,
  dilate: 2,
  minComponent: 0.0004,
};

interface AppState {
  page: PageId;
  client: PipelineClient | null;
  file: File | null;
  fileName: string;
  meta: VideoMeta | null;
  scanFrames: Raster[];
  fullFrames: Raster[];
  fullFrameIndices: number[];
  background: Raster | null;
  bgResidual: number | null; // 背景残留率(真值评估用)
  moments: KeyMoment[];
  targetMomentCount: number;
  mattes: Map<number, MatteLayer>; // frameIndex -> 蒙版层
  grade: GradeParams;
  earliestOpacity: number;
  bgSettings: BackgroundSettings;
  progress: PipelineProgress | null;
  busy: boolean;
  error: string | null;
  // dataset studio
  studioOpen: boolean;

  setPage: (p: PageId) => void;
  setClient: (c: PipelineClient) => void;
  setDecoded: (m: VideoMeta, scan: Raster[], full: Raster[], name: string, indices: number[], file: File) => void;
  setBackground: (bg: Raster, residual?: number) => void;
  setMoments: (m: KeyMoment[]) => void;
  addMoment: (frameIndex: number) => void;
  removeMoment: (id: string) => void;
  updateMoment: (id: string, patch: Partial<KeyMoment>) => void;
  setTargetCount: (n: number) => void;
  setMatte: (frameIndex: number, matte: MatteLayer) => void;
  paintMatteAt: (frameIndex: number, next: MatteLayer) => void;
  setGrade: (g: Partial<GradeParams>) => void;
  setEarliestOpacity: (v: number) => void;
  setBgSettings: (s: Partial<BackgroundSettings>) => void;
  setProgress: (p: PipelineProgress | null) => void;
  setBusy: (b: boolean) => void;
  setError: (e: string | null) => void;
  setStudioOpen: (open: boolean) => void;
  reset: () => void;
}

const initial = {
  page: 'import' as PageId,
  file: null as File | null,
  fileName: '',
  meta: null,
  scanFrames: [],
  fullFrames: [],
  fullFrameIndices: [],
  background: null,
  bgResidual: null,
  moments: [],
  targetMomentCount: 6,
  mattes: new Map<number, MatteLayer>(),
  grade: { ...DEFAULT_GRADE },
  earliestOpacity: 0.45,
  bgSettings: { ...DEFAULT_BG_SETTINGS },
  progress: null,
  busy: false,
  error: null,
  studioOpen: false,
};

export const useApp = create<AppState>((set) => ({
  ...initial,
  client: null,
  setPage: (page) => set({ page }),
  setClient: (client) => set({ client }),
  setDecoded: (meta, scanFrames, fullFrames, fileName, fullFrameIndices, file) =>
    set({
      meta,
      scanFrames,
      fullFrames,
      fullFrameIndices,
      fileName,
      file,
      moments: [],
      mattes: new Map(),
      background: null,
    }),
  setBackground: (background, bgResidual) => set({ background, bgResidual: bgResidual ?? null }),
  setMoments: (moments) => set({ moments }),
  setTargetCount: (targetMomentCount) => set({ targetMomentCount }),
  addMoment: (frameIndex) =>
    set((s) => {
      if (s.moments.some((m) => m.frameIndex === frameIndex) || !s.meta) return {};
      const m: KeyMoment = {
        id: `km-manual-f${frameIndex}`,
        frameIndex,
        timestamp: frameIndex / s.meta.fps,
        label: '手动',
        eventType: 'manual',
        auto: false,
      };
      return { moments: [...s.moments, m].sort((a, b) => a.frameIndex - b.frameIndex) };
    }),
  removeMoment: (id) => set((s) => ({ moments: s.moments.filter((m) => m.id !== id) })),
  updateMoment: (id, patch) =>
    set((s) => ({ moments: s.moments.map((m) => (m.id === id ? { ...m, ...patch } : m)) })),
  setMatte: (frameIndex, matte) =>
    set((s) => {
      const next = new Map(s.mattes);
      next.set(frameIndex, matte);
      return { mattes: next };
    }),
  paintMatteAt: (frameIndex, matte) =>
    set((s) => {
      const next = new Map(s.mattes);
      next.set(frameIndex, matte);
      return { mattes: next };
    }),
  setGrade: (g) => set((s) => ({ grade: { ...s.grade, ...g } })),
  setEarliestOpacity: (earliestOpacity) => set({ earliestOpacity }),
  setBgSettings: (bgSettings) => set((s) => ({ bgSettings: { ...s.bgSettings, ...bgSettings } })),
  setProgress: (progress) => set({ progress }),
  setBusy: (busy) => set({ busy }),
  setError: (error) => set({ error }),
  setStudioOpen: (studioOpen) => set({ studioOpen }),
  reset: () => set({ ...initial, mattes: new Map() }),
}));
