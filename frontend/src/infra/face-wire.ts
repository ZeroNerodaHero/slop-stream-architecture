/**
 * What the page and the face worker say to each other (docs/vtuber.md). Types only: the worker
 * imports this and not `face.ts`, so nothing of the page ends up in its bundle.
 */

/**
 * The face reader, as the streamer is told: `starting` while it loads, `on` with a face in
 * view, `lost` with none, `off` when it did not load (the model still breathes and blinks).
 */
export type FaceState = 'starting' | 'on' | 'lost' | 'off';

/** How the worker is doing, twice a second: for the status line, and for the test. */
export interface ModelStats {
  /** Frames drawn a second. */
  fps: number;
  /** Faces read a second, and how long one reading takes, in ms. */
  reads: number;
  readMs: number;
  face: boolean;
  /** Where the model's head is asked to turn, in whole degrees: the pose's, after rest and mirror. */
  yaw: number;
  pitch: number;
  roll: number;
  /** The jaw and the blink of the pose, 0 to 100. */
  mouth: number;
  blink: number;
}

/** Where the reader's wasm is: its loader script and its binary, and which kind of worker the loader is for. */
export interface FaceWasm {
  loader: string;
  binary: string;
  /** The loader is an es module (`import()`), not a classic script (`importScripts`). */
  module: boolean;
}

export type ToFaceWorker =
  | {
      type: 'start';
      /** The .vrm's bytes. Handed over, not copied. */
      model: ArrayBuffer;
      width: number;
      height: number;
      fps: number;
      background: string;
      mirror: boolean;
      wasm: FaceWasm;
      /** The reader's weights (`face_landmarker.task`), by url. */
      weights: string;
      /** The camera's frames, when the browser can hand a track's frames to a worker. `null`: the page posts them (`frame`), or there is no camera. */
      frames: ReadableStream<VideoFrame> | null;
      /** Where the drawn frames go, when the browser can make a track out of a worker's frames. `null`: they are posted back (`bitmap`). */
      sink: WritableStream<VideoFrame> | null;
    }
  /** Another camera's frames, or none: the picker changed, the camera went. */
  | { type: 'frames'; frames: ReadableStream<VideoFrame> | null }
  /** One camera frame, from a page that reads them itself. Answered with `want`. */
  | { type: 'frame'; bitmap: ImageBitmap }
  | { type: 'set'; mirror?: boolean; background?: string }
  /** Take the resting face again. */
  | { type: 'rest' }
  | { type: 'stop' };

export type FromFaceWorker =
  /** The model is loaded and its first frame is drawn. */
  | { type: 'ready' }
  /** The model could not be loaded, or the drawing was lost: nothing more comes. */
  | { type: 'failed'; why: string }
  | { type: 'state'; face: FaceState; why?: string }
  | { type: 'stats'; stats: ModelStats }
  /** One drawn frame, for a page that makes the track itself. */
  | { type: 'bitmap'; bitmap: ImageBitmap }
  /** Ready for the next camera frame, from a page that reads them itself. */
  | { type: 'want' };
