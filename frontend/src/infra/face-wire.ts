export type FaceState = 'starting' | 'on' | 'lost' | 'off';

export type RigKind = 'arkit' | 'shapes' | 'presets' | 'none';
export type RigPart = 'eyes' | 'blink' | 'mouth' | 'brows' | 'smile';
export interface RigInfo {
  kind: RigKind;
  parts: RigPart[];
}

export type LoadStep = 'model' | 'reader';

export interface ModelStats {
  fps: number;
  reads: number;
  readMs: number;
  face: boolean;
  yaw: number;
  pitch: number;
  roll: number;
  mouth: number;
  blink: number;
  smile: number;
  brows: number;
}

export interface FaceLines {
  mesh: Uint16Array;
  outline: Uint16Array;
  features: Uint16Array;
  irises: Uint16Array;
}

export interface FaceMarks extends Pick<ModelStats, 'yaw' | 'pitch' | 'roll' | 'mouth' | 'blink' | 'smile' | 'brows'> {
  points: Float32Array | null;
}

export interface FaceWasm {
  loader: string;
  binary: string;
  module: boolean;
}

export type ToFaceWorker =
  | {
      type: 'start';
      model: ArrayBuffer;
      width: number;
      height: number;
      fps: number;
      background: string;
      mirror: boolean;
      expressions: boolean;
      wasm: FaceWasm;
      weights: string;
      frames: ReadableStream<VideoFrame> | null;
      sink: WritableStream<VideoFrame> | null;
      wire: WritableStream<VideoFrame> | null;
    }
  | { type: 'frames'; frames: ReadableStream<VideoFrame> | null }
  | { type: 'frame'; bitmap: ImageBitmap }
  | { type: 'set'; mirror?: boolean; background?: string; expressions?: boolean; marks?: boolean }
  | { type: 'rest' }
  | { type: 'stop' };

export type FromFaceWorker =
  | { type: 'loading'; step: LoadStep; loaded: number; total: number }
  | { type: 'ready'; rig: RigInfo }
  | { type: 'failed'; why: string }
  | { type: 'state'; face: FaceState; why?: string }
  | { type: 'stats'; stats: ModelStats }
  | { type: 'lines'; lines: FaceLines }
  | { type: 'marks'; marks: FaceMarks }
  | { type: 'bitmap'; bitmap: ImageBitmap }
  | { type: 'want' };
