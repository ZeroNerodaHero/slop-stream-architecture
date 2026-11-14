/**
 * A model as a camera (docs/vtuber.md): a .vrm's bytes and a camera's track in, one video
 * track out, whose picture is the model moving with the face in front of that camera. The
 * track is what `publish-atoms.ts` puts where the camera's picture would go; the camera's own
 * track is handed to the face reader here and to nothing else.
 *
 * The work is the face worker's (`face.worker.ts`). This file starts it, and connects it to
 * the camera and to a track, one of two ways:
 *
 * - `worker`: the camera's frames go straight into the worker and its drawn frames straight
 *   into a track (chrome's and edge's insertable streams). The page is not in the loop, so a
 *   hidden tab changes nothing.
 * - `page`: this page reads each camera frame and posts it in, and paints each drawn frame the
 *   worker posts back onto a canvas whose capture is the track. Every browser can; it stops
 *   while the tab is hidden, because a hidden page gets no animation frames.
 *
 * `localStorage['settings.modelPath'] = 'page'` asks for the second on a browser that has the
 * first (to look at it, and for the test).
 */

import weights from '@/assets/face_landmarker.task?url';
import type { FaceState, FromFaceWorker, ModelStats, ToFaceWorker } from '@/infra/face-wire';
// the worker as vite builds it (see events.ts). the lint strips the query and finds no default
// export in the worker file; vite's own typing says there is one
// oxlint-disable-next-line import/default -- `?worker` is vite's: the default export is the worker's constructor
import FaceWorker from '@/infra/face.worker?worker';

export type { FaceState, ModelStats } from '@/infra/face-wire';

/** The model's picture: the camera's own size (publish-atoms' `CAMERA_VIDEO`) and rate. */
const WIDTH = 1280;
const HEIGHT = 720;
const FPS = 30;
/** A model that has not drawn its first frame in this long is given up on: a file can be made so a loader waits forever. */
const LOAD_TIMEOUT_MS = 30_000;

// chrome's own early shape of insertable streams: both made on the page, their streams handed to a worker
interface TrackProcessor {
  readonly readable: ReadableStream<VideoFrame>;
}
type TrackGenerator = MediaStreamTrack & { readonly writable: WritableStream<VideoFrame> };
declare global {
  interface Window {
    MediaStreamTrackProcessor?: new (init: { track: MediaStreamTrack; maxBufferSize?: number }) => TrackProcessor;
    MediaStreamTrackGenerator?: new (init: { kind: 'video' }) => TrackGenerator;
  }
}

export interface ModelOptions {
  /** The .vrm's bytes, already read by `infra/vrm.ts`. Handed to the worker: gone from the caller after this. */
  model: ArrayBuffer;
  /** The camera the face is read from. `null`: none, and the model breathes and blinks on its own. Never sent anywhere. */
  camera: MediaStreamTrack | null;
  mirror: boolean;
  /** The flat colour behind the model, as css. */
  background: string;
  onState: (face: FaceState, why?: string) => void;
  onStats: (stats: ModelStats) => void;
  /** The model stopped after it had started: the drawing was lost, the worker died. Nothing more comes from it. */
  onFailed: (why: string) => void;
}

export interface ModelSession {
  /** The model's picture. The caller puts it in the camera's place, and `stop` ends it. */
  readonly track: MediaStreamTrack;
  /** Which of the two ways this browser got. */
  readonly path: 'worker' | 'page';
  /** Another camera to read the face from, or none. */
  setCamera(camera: MediaStreamTrack | null): void;
  setMirror(mirror: boolean): void;
  setBackground(css: string): void;
  /** Take the resting face again. */
  rest(): void;
  stop(): void;
}

/** This browser can keep a model moving while its tab is hidden. */
export function modelSurvivesHiddenTab(): boolean {
  return pathHere() === 'worker';
}

function pathHere(): 'worker' | 'page' {
  let asked: string | null = null;
  try {
    asked = localStorage.getItem('settings.modelPath');
  } catch {
    // no storage here: the browser's own answer
  }
  const can = typeof window.MediaStreamTrackProcessor === 'function' && typeof window.MediaStreamTrackGenerator === 'function';
  return can && asked !== 'page' ? 'worker' : 'page';
}

/**
 * The model, started. Resolves once its first frame is drawn, with the track that carries it;
 * rejects with words when the file cannot be made a model of (or takes too long).
 */
export async function startModel(options: ModelOptions): Promise<ModelSession> {
  // a build's worker is a classic script and the dev server's a module: each wants its own loader, and only one is built
  const wasm = (import.meta.env.DEV ? await import('@/infra/face-wasm.module') : await import('@/infra/face-wasm.classic')).default;
  const path = pathHere();
  const worker = new FaceWorker();
  const send = (msg: ToFaceWorker, transfer: Transferable[] = []) => worker.postMessage(msg, transfer);
  let stopped = false;

  // ---- the track the drawn frames become ------------------------------------------------
  let track: MediaStreamTrack;
  let sink: WritableStream<VideoFrame> | null = null;
  let paint: ((bitmap: ImageBitmap) => void) | null = null;
  if (path === 'worker') {
    const generator = new window.MediaStreamTrackGenerator!({ kind: 'video' });
    track = generator;
    sink = generator.writable;
  } else {
    const canvas = document.createElement('canvas');
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    const ctx = canvas.getContext('bitmaprenderer');
    if (!ctx) throw new Error('this browser cannot draw a model');
    track = canvas.captureStream(FPS).getVideoTracks()[0]!;
    paint = (bitmap) => ctx.transferFromImageBitmap(bitmap);
  }

  // ---- the camera's frames, into the worker ---------------------------------------------
  /** The page's way: a <video> of the camera, read once per animation frame while the worker wants one. */
  let video: HTMLVideoElement | null = null;
  let wanted = false;
  let raf = 0;
  let sentAt = 0;
  const feed = (now: number) => {
    raf = 0;
    if (stopped || !video) return;
    raf = requestAnimationFrame(feed);
    // no faster than the camera: a screen paints twice for each of its frames, and the second look is the same picture
    if (!wanted || video.readyState < 2 || video.videoWidth === 0 || now - sentAt < 1000 / FPS - 4) return;
    sentAt = now;
    wanted = false;
    createImageBitmap(video)
      .then((bitmap) => (stopped ? bitmap.close() : send({ type: 'frame', bitmap }, [bitmap])))
      .catch(() => {
        wanted = true;
      });
  };
  const framesOf = (camera: MediaStreamTrack | null): ReadableStream<VideoFrame> | null => {
    if (!camera) return null;
    // one frame kept at most: the reader gets the newest, never a queue of old ones
    return path === 'worker' ? new window.MediaStreamTrackProcessor!({ track: camera, maxBufferSize: 1 }).readable : null;
  };
  const watch = (camera: MediaStreamTrack | null) => {
    if (path === 'worker') return;
    if (!camera) {
      if (video) video.srcObject = null;
      return;
    }
    if (!video) {
      video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
    }
    video.srcObject = new MediaStream([camera]);
    video.play().catch(() => undefined);
    if (!raf) raf = requestAnimationFrame(feed);
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (raf) cancelAnimationFrame(raf);
    if (video) video.srcObject = null;
    send({ type: 'stop' });
    // the worker closes itself on `stop`; this is for one that is stuck in a frame
    setTimeout(() => worker.terminate(), 500);
    track.stop();
  };

  const session: ModelSession = {
    track,
    path,
    setCamera(camera) {
      if (stopped) return;
      const frames = framesOf(camera);
      send({ type: 'frames', frames }, frames ? [frames] : []);
      watch(camera);
    },
    setMirror: (mirror) => void (!stopped && send({ type: 'set', mirror })),
    setBackground: (background) => void (!stopped && send({ type: 'set', background })),
    rest: () => void (!stopped && send({ type: 'rest' })),
    stop
  };

  return new Promise<ModelSession>((resolve, reject) => {
    let ready = false;
    const giveUp = (why: string) => {
      const wasReady = ready;
      stop();
      if (wasReady) options.onFailed(why);
      else reject(new Error(why));
    };
    const timeout = setTimeout(() => !ready && giveUp('that model took too long to load'), LOAD_TIMEOUT_MS);
    worker.onmessage = (e: MessageEvent<FromFaceWorker>) => {
      const msg = e.data;
      if (stopped) {
        if (msg.type === 'bitmap') msg.bitmap.close();
        return;
      }
      if (msg.type === 'ready') {
        ready = true;
        clearTimeout(timeout);
        resolve(session);
      } else if (msg.type === 'failed') {
        clearTimeout(timeout);
        giveUp(msg.why);
      } else if (msg.type === 'state') options.onState(msg.face, msg.why);
      else if (msg.type === 'stats') options.onStats(msg.stats);
      else if (msg.type === 'bitmap') {
        if (paint) paint(msg.bitmap);
        else msg.bitmap.close();
      } else if (msg.type === 'want') wanted = true;
    };
    worker.onerror = (e) => {
      clearTimeout(timeout);
      giveUp(`its worker stopped${e.message ? `: ${e.message}` : ''}`);
    };
    const frames = framesOf(options.camera);
    const transfer: Transferable[] = [options.model];
    if (frames) transfer.push(frames);
    if (sink) transfer.push(sink);
    send(
      {
        type: 'start',
        model: options.model,
        width: WIDTH,
        height: HEIGHT,
        fps: FPS,
        background: options.background,
        mirror: options.mirror,
        wasm,
        weights,
        frames,
        sink
      },
      transfer
    );
    watch(options.camera);
  });
}
