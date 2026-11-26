import type { Raster, ScanFrame, VideoMeta } from './types';

export interface DecodeOptions {
  /** 扫描输出宽度(等比缩小),0 表示原始尺寸 */
  scanWidth?: number;
  /** 背景/抠图保留的全分辨率帧上限(均匀抽样) */
  fullResLimit?: number;
  onProgress?: (done: number, total: number) => void;
  signal?: { cancelled: boolean };
}

export interface DecodeResult {
  meta: VideoMeta;
  /** 低分辨率扫描帧(全片,关键时刻分析用) */
  scanFrames: ScanFrame[];
  /** 全分辨率帧(均匀抽样,背景估计用) */
  fullFrames: Raster[];
  /** 每个全分辨率帧对应的原始视频帧号 */
  fullFrameIndices: number[];
}

interface Mp4BoxFile {
  onReady: (info: Mp4Info) => void;
  onSamples: (id: number, user: unknown, samples: Mp4Sample[]) => void;
  appendBuffer: (data: ArrayBuffer & { fileStart?: number }, end?: boolean) => void;
  flush: () => void;
  start: () => void;
  setExtractionOptions: (id: number, user: unknown, opts?: { nbSamples?: number }) => void;
}
interface Mp4Info {
  duration: number;
  timescale: number;
  video: { trackId: number; codec: string; movie_duration?: number; duration?: number; nb_samples: number }[];
}
interface Mp4Sample {
  description: { avcC?: unknown; hvcC?: unknown; type?: string };
  is_sync: boolean;
  dts: number;
  cts: number;
  data: ArrayBuffer;
}

async function loadMp4Box(): Promise<{ createFile: () => Mp4BoxFile }> {
  const mod = await import('mp4box');
  return mod as unknown as { createFile: () => Mp4BoxFile };
}

function videoFrameToRaster(frame: VideoFrame, targetWidth?: number): Raster {
  const w = targetWidth ? Math.round(targetWidth) : frame.displayWidth;
  const h = targetWidth ? Math.round((frame.displayHeight / frame.displayWidth) * targetWidth) : frame.displayHeight;
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(frame, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  return { width: w, height: h, data: new Uint8Array(img.data.buffer) };
}

/** WebCodecs + mp4box 解封装主路径 */
async function decodeWithWebCodecs(file: File, opts: DecodeOptions): Promise<DecodeResult> {
  const MP4Box = await loadMp4Box();
  const mp4 = MP4Box.createFile();
  const trackReady = new Promise<{
    trackId: number;
    codec: string;
    durationSec: number;
    nbSamples: number;
    timescale: number;
  }>((resolve) => {
    mp4.onReady = (info: Mp4Info) => {
      const v = info.video[0];
      resolve({
        trackId: v.trackId,
        codec: v.codec,
        durationSec: info.duration / info.timescale,
        nbSamples: v.nb_samples,
        timescale: info.timescale,
      });
    };
  });

  const samples: Mp4Sample[] = [];
  mp4.onSamples = (_id, _user, s) => {
    samples.push(...s);
  };

  // 喂数据
  const CHUNK = 8 * 1024 * 1024;
  let offset = 0;
  while (offset < file.size) {
    const slice = file.slice(offset, Math.min(file.size, offset + CHUNK));
    const buf = (await slice.arrayBuffer()) as ArrayBuffer & { fileStart?: number };
    buf.fileStart = offset;
    mp4.appendBuffer(buf);
    offset += CHUNK;
    if (opts.signal?.cancelled) throw new Error('已取消');
  }
  mp4.flush();
  const info = await trackReady;
  mp4.setExtractionOptions(info.trackId, null, { nbSamples: info.nbSamples });
  mp4.start();

  // 等 mp4box 把样本吐完
  while (samples.length < info.nbSamples) {
    await new Promise((r) => setTimeout(r, 10));
    if (opts.signal?.cancelled) throw new Error('已取消');
  }
  const first = samples[0];
  const config: VideoDecoderConfig = {
    codec: info.codec,
    codedWidth: 0,
    codedHeight: 0,
  };
  // 用 description 喂 codec extra data(mp4box 把 avcC/hvcC 挂在 sample.description)
  const descSample = samples.find((s) => s.description && (s.description.avcC || s.description.hvcC));
  if (descSample) {
    const anyDesc = descSample.description as unknown as { avcC?: Uint8Array; hvcC?: Uint8Array };
    const extra = anyDesc.avcC ?? anyDesc.hvcC;
    if (extra) (config as VideoDecoderConfig & { description?: Uint8Array }).description = extra;
  }
  const toUs = (ts: number) => Math.round((ts / info.timescale) * 1e6);
  // 探测尺寸:先解第一帧
  const probe = new Promise<void>((resolve, reject) => {
    const d0 = new VideoDecoder({
      output: (frame) => {
        config.codedWidth = frame.codedWidth;
        config.codedHeight = frame.codedHeight;
        frame.close();
        d0.close();
        resolve();
      },
      error: (e) => reject(e),
    });
    d0.configure(config);
    d0.decode(
      new EncodedVideoChunk({
        type: first.is_sync ? 'key' : 'delta',
        timestamp: toUs(first.cts),
        data: first.data,
      }),
    );
  });
  const support = await VideoDecoder.isConfigSupported(config);
  if (!support.supported) throw new Error('WebCodecs 不支持该编码配置');
  await probe;

  // 正式解码:控制输出队列,逐帧转光栅
  const scanFrames: ScanFrame[] = [];
  const fullFrames: Raster[] = [];
  const fullFrameIndices: number[] = [];
  const fullLimit = opts.fullResLimit ?? 240;
  const fullStep = Math.max(1, Math.floor(info.nbSamples / fullLimit));
  let decodedCount = 0;
  const queue: VideoFrame[] = [];
  let drainResolve: (() => void) | null = null;
  let decodeError: Error | null = null;

  const dec2 = new VideoDecoder({
    output: (frame) => {
      queue.push(frame);
      drainResolve?.();
    },
    error: (e) => {
      decodeError = e;
      drainResolve?.();
    },
  });
  dec2.configure(config);

  const nextFrame = async (): Promise<VideoFrame | null> => {
    while (queue.length === 0) {
      if (decodeError) throw decodeError;
      if (dec2.decodeQueueSize === 0 && decodedCount >= info.nbSamples) return null;
      await new Promise<void>((r) => {
        drainResolve = r;
        setTimeout(r, 30);
      });
      if (decodeError) throw decodeError;
    }
    return queue.shift()!;
  };

  for (let i = 0; i < info.nbSamples; i++) {
    const s = samples[i];
    dec2.decode(
      new EncodedVideoChunk({
        type: s.is_sync ? 'key' : 'delta',
        timestamp: toUs(s.cts),
        data: s.data,
      }),
    );
    decodedCount++;
    if (dec2.decodeQueueSize > 8) await dec2.flush().catch(() => {});
    const frame = await nextFrame();
    if (!frame) break;
    const ts = frame.timestamp / 1e6;
    scanFrames.push({ ...videoFrameToRaster(frame, opts.scanWidth ?? 320), frameIndex: i, timestamp: ts });
    if (i % fullStep === 0) {
      fullFrames.push(videoFrameToRaster(frame));
      fullFrameIndices.push(i);
    }
    frame.close();
    if (i % 15 === 0) opts.onProgress?.(i, info.nbSamples);
    if (opts.signal?.cancelled) throw new Error('已取消');
  }
  await dec2.flush().catch(() => {});
  dec2.close();

  const fw = fullFrames[0]?.width ?? scanFrames[0].width;
  const fh = fullFrames[0]?.height ?? scanFrames[0].height;
  const fps = info.nbSamples / Math.max(0.001, info.durationSec);
  return {
    meta: {
      width: fw,
      height: fh,
      duration: info.durationSec,
      fps,
      frameCount: info.nbSamples,
      codec: info.codec,
      decoder: 'webcodecs-mp4',
    },
    scanFrames,
    fullFrames,
    fullFrameIndices,
  };
}

export interface ExtractResult {
  frames: Raster[];
  frameIndices: number[];
}

/**
 * 按需提取指定帧号的全分辨率帧(关键时刻不在均匀抽样集合里时用)。
 * mp4box 样本已在首次解码时收集过,这里重新起解码器,从最近关键帧顺序解到目标帧。
 */
export async function extractFramesAt(
  file: File,
  wantedIndices: number[],
  opts: { onProgress?: (done: number, total: number) => void } = {},
): Promise<ExtractResult> {
  const wanted = [...new Set(wantedIndices)].sort((a, b) => a - b);
  if (typeof VideoDecoder === 'undefined' || file.type === 'video/webm') {
    return { frames: [], frameIndices: [] };
  }
  const MP4Box = await loadMp4Box();
  const mp4 = MP4Box.createFile();
  const info = await new Promise<{ trackId: number; codec: string; nbSamples: number; timescale: number }>((resolve) => {
    mp4.onReady = (i: Mp4Info) =>
      resolve({ trackId: i.video[0].trackId, codec: i.video[0].codec, nbSamples: i.video[0].nb_samples, timescale: i.timescale });
  });
  const samples: Mp4Sample[] = [];
  mp4.onSamples = (_id, _u, s) => samples.push(...s);
  const CHUNK = 8 * 1024 * 1024;
  let offset = 0;
  while (offset < file.size) {
    const buf = (await file.slice(offset, Math.min(file.size, offset + CHUNK)).arrayBuffer()) as ArrayBuffer & {
      fileStart?: number;
    };
    buf.fileStart = offset;
    mp4.appendBuffer(buf);
    offset += CHUNK;
  }
  mp4.flush();
  await info;
  mp4.setExtractionOptions(info.trackId, null, { nbSamples: info.nbSamples });
  mp4.start();
  while (samples.length < info.nbSamples) await new Promise((r) => setTimeout(r, 10));

  const first = samples.find((s) => s.description && (s.description.avcC || s.description.hvcC));
  const config: VideoDecoderConfig & { description?: Uint8Array } = { codec: info.codec, codedWidth: 0, codedHeight: 0 };
  if (first) {
    const d = first.description as unknown as { avcC?: Uint8Array; hvcC?: Uint8Array };
    if (d.avcC ?? d.hvcC) config.description = d.avcC ?? d.hvcC;
  }
  // 尺寸探测
  await new Promise<void>((resolve, reject) => {
    const d0 = new VideoDecoder({
      output: (fr) => {
        config.codedWidth = fr.codedWidth;
        config.codedHeight = fr.codedHeight;
        fr.close();
        d0.close();
        resolve();
      },
      error: reject,
    });
    d0.configure(config);
    const s0 = samples[0];
    d0.decode(new EncodedVideoChunk({ type: s0.is_sync ? 'key' : 'delta', timestamp: 0, data: s0.data }));
  });

  const wantedSet = new Set(wanted);
  const out: Raster[] = [];
  const outIdx: number[] = [];
  // chunk 时间戳(us) -> 帧号,VideoFrame 输出时按时间戳反查
  const tsToIndex = new Map<number, number>();
  const decoder = new VideoDecoder({
    output: (frame) => {
      const fi = tsToIndex.get(frame.timestamp);
      if (fi !== undefined && wantedSet.has(fi)) {
        out.push(videoFrameToRaster(frame));
        outIdx.push(fi);
      }
      frame.close();
    },
    error: (e) => {
      throw e;
    },
  });
  decoder.configure(config);
  // 从目标帧之前最近的关键帧开始解
  let cursor = 0;
  for (const target of wanted) {
    let start = target;
    while (start > 0 && !samples[start].is_sync) start--;
    for (let i = Math.max(cursor, start); i <= target; i++) {
      const s = samples[i];
      const ts = Math.round((s.cts / info.timescale) * 1e6);
      tsToIndex.set(ts, i);
      decoder.decode(
        new EncodedVideoChunk({
          type: s.is_sync ? 'key' : 'delta',
          timestamp: ts,
          data: s.data,
        }),
      );
    }
    await decoder.flush().catch(() => {});
    cursor = target + 1;
    opts.onProgress?.(outIdx.length, wanted.length);
  }
  decoder.close();
  return { frames: out, frameIndices: outIdx };
}

/** video 元素 + requestVideoFrameCallback 回退路径(WebM 或无 WebCodecs 时) */
async function decodeWithVideoElement(file: File, opts: DecodeOptions): Promise<DecodeResult> {
  const url = URL.createObjectURL(file);
  try {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.src = url;
    await video.play().catch(() => {});
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error('视频元数据加载失败'));
    });
    const duration = video.duration;
    const w = video.videoWidth;
    const h = video.videoHeight;
    const fps = 30; // 浏览器不暴露精确帧率,按 30fps 采样
    const targetCount = Math.min(900, Math.max(60, Math.round(duration * fps)));
    const scanCanvas = new OffscreenCanvas(
      opts.scanWidth ?? 320,
      Math.round(((opts.scanWidth ?? 320) / w) * h),
    );
    const scanCtx = scanCanvas.getContext('2d', { willReadFrequently: true })!;
    const fullCanvas = new OffscreenCanvas(w, h);
    const fullCtx = fullCanvas.getContext('2d', { willReadFrequently: true })!;
    const scanFrames: ScanFrame[] = [];
    const fullFrames: Raster[] = [];
    const fullFrameIndices: number[] = [];
    const fullStep = Math.max(1, Math.floor(targetCount / (opts.fullResLimit ?? 240)));

    const rvfc =
      video.requestVideoFrameCallback?.bind(video) ??
      ((cb: (now: number, m: { mediaTime: number }) => void) =>
        window.setTimeout(() => cb(performance.now(), { mediaTime: video.currentTime }), 16));

    for (let i = 0; i < targetCount; i++) {
      const t = duration * (i / targetCount);
      video.currentTime = t;
      await new Promise<void>((resolve) => rvfc(() => resolve()));
      scanCtx.drawImage(video, 0, 0, scanCanvas.width, scanCanvas.height);
      const sd = scanCtx.getImageData(0, 0, scanCanvas.width, scanCanvas.height);
      scanFrames.push({
        width: scanCanvas.width,
        height: scanCanvas.height,
        data: new Uint8Array(sd.data.buffer),
        frameIndex: i,
        timestamp: t,
      });
      if (i % fullStep === 0) {
        fullCtx.drawImage(video, 0, 0, w, h);
        const fd = fullCtx.getImageData(0, 0, w, h);
        fullFrames.push({ width: w, height: h, data: new Uint8Array(fd.data.buffer) });
        fullFrameIndices.push(i);
      }
      if (i % 15 === 0) opts.onProgress?.(i, targetCount);
      if (opts.signal?.cancelled) throw new Error('已取消');
    }
    return {
      meta: {
        width: w,
        height: h,
        duration,
        fps,
        frameCount: targetCount,
        codec: file.type || 'unknown',
        decoder: 'video-element',
      },
      scanFrames,
      fullFrames,
      fullFrameIndices,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function decodeVideo(file: File, opts: DecodeOptions = {}): Promise<DecodeResult> {
  const canWebCodecs =
    typeof VideoDecoder !== 'undefined' &&
    typeof EncodedVideoChunk !== 'undefined' &&
    file.type !== 'video/webm';
  if (canWebCodecs) {
    try {
      return await decodeWithWebCodecs(file, opts);
    } catch (e) {
      console.warn('WebCodecs 路径失败,回退 video 元素:', e);
    }
  }
  return decodeWithVideoElement(file, opts);
}
