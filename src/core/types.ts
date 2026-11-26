/** 共享类型定义 —— 核心算法只依赖结构化光栅,不直接依赖 DOM ImageData */

/** 结构化光栅:ImageData 与自有实现都满足该结构 */
export interface Raster {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

export interface VideoMeta {
  width: number;
  height: number;
  duration: number; // 秒
  fps: number;
  frameCount: number;
  codec: string;
  decoder: 'webcodecs-mp4' | 'video-element';
}

export interface ScanFrame extends Raster {
  frameIndex: number;
  timestamp: number;
}

/** 关键时刻 */
export interface KeyMoment {
  id: string;
  frameIndex: number;
  timestamp: number;
  /** 顶点 / 换手 / 接住 / 能量峰 / 手动 */
  label: string;
  eventType: 'apex' | 'switch' | 'catch' | 'energy' | 'manual';
  auto: boolean;
}

/** 抠图后的图层(RGBA,alpha 为软蒙版) */
export interface MatteLayer extends Raster {
  frameIndex: number;
  timestamp: number;
  label: string;
}

export interface GradeParams {
  brightness: number; // -1 .. 1
  contrast: number; // -1 .. 1
  saturation: number; // -1 .. 1
  gamma: number; // 0.5 .. 2.0
}

export const DEFAULT_GRADE: GradeParams = {
  brightness: 0,
  contrast: 0,
  saturation: 0,
  gamma: 1,
};

export interface PipelineProgress {
  stage: string;
  done: number;
  total: number;
}

/** 合成数据集真值事件 */
export interface TruthEvent {
  frame: number;
  time: number;
  type: 'apex' | 'switch' | 'catch';
  label: string;
}

export interface DatasetMeta {
  venue: string;
  trick: string;
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  duration: number;
  events: TruthEvent[];
}
