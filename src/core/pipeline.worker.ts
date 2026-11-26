import type {
  BackgroundOptions,
  MattingOptions,
} from './background';
import { estimateTemporalModeBackground, matteFrame } from './background';
import type { Raster, ScanFrame, VideoMeta, KeyMoment } from './types';
import { selectKeyMoments } from './keyMoments';
import { decodeVideo, extractFramesAt } from './videoDecode';
import type { ScanOptions } from './keyMoments';

export type WorkerRequest =
  | {
      type: 'decode';
      file: File;
      scanWidth: number;
      fullResLimit: number;
    }
  | { type: 'estimateBackground'; frames: Raster[]; width: number; height: number; options: BackgroundOptions }
  | {
      type: 'detectMoments';
      scanFrames: ScanFrame[];
      fps: number;
      targetCount: number;
      diaboloColor?: [number, number, number];
    }
  | { type: 'matte'; frame: Raster; background: Raster; options: MattingOptions }
  | { type: 'extractFrames'; file: File; indices: number[] }
  | { type: 'cancel' };

export type WorkerResponse =
  | { type: 'progress'; stage: string; done: number; total: number }
  | {
      type: 'decoded';
      meta: VideoMeta;
      scanFrames: ScanFrame[];
      fullFrames: Raster[];
      fullFrameIndices: number[];
    }
  | { type: 'background'; background: Raster }
  | { type: 'moments'; moments: KeyMoment[] }
  | { type: 'matted'; matte: Raster }
  | { type: 'extracted'; frames: Raster[]; frameIndices: number[] }
  | { type: 'error'; message: string };

const post = (msg: WorkerResponse, transfer: Transferable[] = []) => postMessage(msg, transfer);
const progress = (stage: string, done: number, total: number) => post({ type: 'progress', stage, done, total });

let cancelled = { cancelled: false };

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  if (req.type === 'cancel') {
    cancelled.cancelled = true;
    return;
  }
  cancelled = { cancelled: false };
  try {
    switch (req.type) {
      case 'decode': {
        const result = await decodeVideo(req.file, {
          scanWidth: req.scanWidth,
          fullResLimit: req.fullResLimit,
          signal: cancelled,
          onProgress: (d, t) => progress('解码视频', d, t),
        });
        const transfer = [
          ...result.scanFrames.map((f) => f.data.buffer),
          ...result.fullFrames.map((f) => f.data.buffer),
        ] as Transferable[];
        post(
          {
            type: 'decoded',
            meta: result.meta,
            scanFrames: result.scanFrames,
            fullFrames: result.fullFrames,
            fullFrameIndices: result.fullFrameIndices,
          },
          transfer,
        );
        break;
      }
      case 'estimateBackground': {
        const bg = estimateTemporalModeBackground(req.frames, req.width, req.height, {
          ...req.options,
          onProgress: (d, t) => progress('背景估计', d, t),
        });
        post({ type: 'background', background: bg }, [bg.data.buffer]);
        break;
      }
      case 'detectMoments': {
        const moments = selectKeyMoments(req.scanFrames, {
          fps: req.fps,
          targetCount: req.targetCount,
          diaboloColor: req.diaboloColor,
        } satisfies ScanOptions);
        post({ type: 'moments', moments });
        break;
      }
      case 'matte': {
        const matte = matteFrame(req.frame, req.background, req.options);
        post({ type: 'matted', matte }, [matte.data.buffer]);
        break;
      }
      case 'extractFrames': {
        const res = await extractFramesAt(req.file, req.indices, {
          onProgress: (d, t) => progress('提取全分辨率帧', d, t),
        });
        post(
          { type: 'extracted', frames: res.frames, frameIndices: res.frameIndices },
          res.frames.map((f) => f.data.buffer as Transferable),
        );
        break;
      }
    }
  } catch (e) {
    post({ type: 'error', message: (e as Error).message ?? String(e) });
  }
};
