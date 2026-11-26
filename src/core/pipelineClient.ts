import type { BackgroundOptions, MattingOptions } from './background';
import type { KeyMoment, PipelineProgress, Raster, ScanFrame, VideoMeta } from './types';
import type { WorkerRequest, WorkerResponse } from './pipeline.worker';

/** Worker 的 Promise 化客户端 */
export class PipelineClient {
  private worker: Worker;
  private seq = 0;

  constructor() {
    this.worker = new Worker(new URL('./pipeline.worker.ts', import.meta.url), { type: 'module' });
  }

  onProgress: ((p: PipelineProgress) => void) | null = null;

  private call<T extends Extract<WorkerResponse, { type: string }>>(
    req: WorkerRequest,
    expect: T['type'],
    transfer: Transferable[] = [],
  ): Promise<T> {
    const id = ++this.seq;
    void id;
    return new Promise<T>((resolve, reject) => {
      const handler = (ev: MessageEvent<WorkerResponse>) => {
        const msg = ev.data;
        if (msg.type === 'progress') {
          this.onProgress?.({ stage: msg.stage, done: msg.done, total: msg.total });
          return;
        }
        if (msg.type === 'error') {
          this.worker.removeEventListener('message', handler);
          reject(new Error(msg.message));
          return;
        }
        if (msg.type === expect) {
          this.worker.removeEventListener('message', handler);
          resolve(msg as T);
        }
      };
      this.worker.addEventListener('message', handler);
      this.worker.postMessage(req, transfer);
    });
  }

  decode(file: File, scanWidth = 320, fullResLimit = 120) {
    return this.call<Extract<WorkerResponse, { type: 'decoded' }>>(
      {
        type: 'decode',
        file,
        scanWidth,
        fullResLimit,
      },
      'decoded',
    );
  }

  estimateBackground(frames: Raster[], width: number, height: number, options: BackgroundOptions = {}) {
    const transfer = frames.map((f) => f.data.buffer as Transferable);
    return this.call<Extract<WorkerResponse, { type: 'background' }>>(
      { type: 'estimateBackground', frames, width, height, options },
      'background',
      transfer,
    );
  }

  detectMoments(
    scanFrames: ScanFrame[],
    fps: number,
    targetCount: number,
    diaboloColor?: [number, number, number],
  ) {
    return this.call<Extract<WorkerResponse, { type: 'moments' }>>(
      { type: 'detectMoments', scanFrames, fps, targetCount, diaboloColor },
      'moments',
    );
  }

  matte(frame: Raster, background: Raster, options: MattingOptions = {}) {
    // 不转移:背景在调参/重抠时要复用,结构化克隆即可(1080p RGBA 约 8MB)
    return this.call<Extract<WorkerResponse, { type: 'matted' }>>(
      { type: 'matte', frame, background, options },
      'matted',
    );
  }

  /** 按需提取指定帧号的全分辨率帧(仅 WebCodecs 路径支持,回退路径返回空数组) */
  extractFrames(file: File, indices: number[]) {
    return this.call<Extract<WorkerResponse, { type: 'extracted' }>>(
      { type: 'extractFrames', file, indices },
      'extracted',
    );
  }

  cancel() {
    this.worker.postMessage({ type: 'cancel' } satisfies WorkerRequest);
  }

  dispose() {
    this.worker.terminate();
  }
}

export type { VideoMeta, KeyMoment };
