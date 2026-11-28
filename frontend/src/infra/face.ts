import weights from '@/assets/face_landmarker.task?url';
import type { FaceLines, FaceMarks, FaceState, FromFaceWorker, LoadStep, ModelStats, RigInfo, ToFaceWorker } from '@/infra/face-wire';
import FaceWorker from '@/infra/face.worker?worker';
import faceWorkerUrl from '@/infra/face.worker?worker&url';
import { HERE } from '@/infra/here';
import { wireBackingOf } from '@/infra/model-backing';
import { frameSizeOf, type ModelFrame, STAGE_ASPECT } from '@/infra/model-frame';

export type { FaceLines, FaceMarks, FaceState, LoadStep, ModelStats, RigInfo, RigPart } from '@/infra/face-wire';

const FPS = 30;
const LOAD_TIMEOUT_MS = 30_000;

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
  model: ArrayBuffer;
  camera: MediaStreamTrack | null;
  mirror: boolean;
  expressions: boolean;
  background: string;
  frame: ModelFrame;
  onLoading: (step: LoadStep, loaded: number, total: number) => void;
  onState: (face: FaceState, why?: string) => void;
  onStats: (stats: ModelStats) => void;
  onLines: (lines: FaceLines) => void;
  onMarks: (marks: FaceMarks) => void;
  onFailed: (why: string) => void;
}

export interface ModelSession {
  readonly track: MediaStreamTrack;
  readonly wireTrack: MediaStreamTrack;
  readonly path: 'worker' | 'page';
  readonly rig: RigInfo;
  readonly fitAspect: number;
  setCamera(camera: MediaStreamTrack | null): void;
  setMirror(mirror: boolean): void;
  setBackground(css: string): void;
  setExpressions(on: boolean): void;
  setFrame(frame: ModelFrame): void;
  setMarks(on: boolean): void;
  rest(): void;
  stop(): void;
}

export function modelSurvivesHiddenTab(): boolean {
  return pathHere() === 'worker';
}

function pathHere(): 'worker' | 'page' {
  let asked: string | null = null;
  try {
    asked = localStorage.getItem('settings.modelPath');
  } catch {
  }
  const can = typeof window.MediaStreamTrackProcessor === 'function' && typeof window.MediaStreamTrackGenerator === 'function';
  return can && asked !== 'page' ? 'worker' : 'page';
}

const loadFaceWasm = async () => (import.meta.env.DEV ? await import('@/infra/face-wasm.module') : await import('@/infra/face-wasm.classic')).default;

let warmed = false;

export function warmModelFiles(): void {
  if (warmed) return;
  warmed = true;
  const warm = () => {
    void loadFaceWasm().then((wasm) => {
      for (const url of [faceWorkerUrl, wasm.loader, wasm.binary, weights]) {
        void fetch(url, { priority: 'low' })
          .then((res) => (res.ok ? res.blob() : null))
          .catch(() => undefined);
      }
    });
  };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(warm, { timeout: 3000 });
  else setTimeout(warm, 1000);
}

export async function startModel(options: ModelOptions): Promise<ModelSession> {
  const wasm = await loadFaceWasm();
  const path = pathHere();
  const worker = new FaceWorker();
  const send = (msg: ToFaceWorker, transfer: Transferable[] = []) => worker.postMessage(msg, transfer);
  let stopped = false;

  let track: MediaStreamTrack;
  let wireTrack: MediaStreamTrack;
  let sink: WritableStream<VideoFrame> | null = null;
  let wire: WritableStream<VideoFrame> | null = null;
  let paint: ((bitmap: ImageBitmap) => void) | null = null;
  let backing = options.background;
  const first = frameSizeOf(options.frame);
  if (path === 'worker') {
    const generator = new window.MediaStreamTrackGenerator!({ kind: 'video' });
    const wireGenerator = new window.MediaStreamTrackGenerator!({ kind: 'video' });
    track = generator;
    sink = generator.writable;
    wireTrack = wireGenerator;
    wire = wireGenerator.writable;
  } else {
    const canvas = document.createElement('canvas');
    canvas.width = first.width;
    canvas.height = first.height;
    const ctx = canvas.getContext('bitmaprenderer');
    const flat = document.createElement('canvas');
    flat.width = first.width;
    flat.height = first.height;
    const flatCtx = flat.getContext('2d', { alpha: false });
    if (!ctx || !flatCtx) throw new Error(`${HERE} cannot draw a model`);
    track = canvas.captureStream(FPS).getVideoTracks()[0]!;
    wireTrack = flat.captureStream(FPS).getVideoTracks()[0]!;
    paint = (bitmap) => {
      for (const c of [canvas, flat]) {
        if (c.width !== bitmap.width) c.width = bitmap.width;
        if (c.height !== bitmap.height) c.height = bitmap.height;
      }
      flatCtx.fillStyle = wireBackingOf(backing);
      flatCtx.fillRect(0, 0, bitmap.width, bitmap.height);
      flatCtx.drawImage(bitmap, 0, 0);
      ctx.transferFromImageBitmap(bitmap);
    };
  }

  let video: HTMLVideoElement | null = null;
  let wanted = false;
  let raf = 0;
  let sentAt = 0;
  const feed = (now: number) => {
    raf = 0;
    if (stopped || !video) return;
    raf = requestAnimationFrame(feed);
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
    setTimeout(() => worker.terminate(), 500);
    track.stop();
    wireTrack.stop();
  };

  const session: ModelSession & { rig: RigInfo; fitAspect: number } = {
    track,
    wireTrack,
    path,
    rig: { kind: 'none', parts: [] },
    fitAspect: STAGE_ASPECT,
    setCamera(camera) {
      if (stopped) return;
      const frames = framesOf(camera);
      send({ type: 'frames', frames }, frames ? [frames] : []);
      watch(camera);
    },
    setMirror: (mirror) => void (!stopped && send({ type: 'set', mirror })),
    setBackground: (background) => {
      backing = background;
      if (!stopped) send({ type: 'set', background });
    },
    setExpressions: (expressions) => void (!stopped && send({ type: 'set', expressions })),
    setMarks: (marks) => void (!stopped && send({ type: 'set', marks })),
    setFrame: (frame) => void (!stopped && send({ type: 'set', frame })),
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
        session.rig = msg.rig;
        session.fitAspect = msg.fitAspect;
        resolve(session);
      } else if (msg.type === 'loading') options.onLoading(msg.step, msg.loaded, msg.total);
      else if (msg.type === 'failed') {
        clearTimeout(timeout);
        giveUp(msg.why);
      } else if (msg.type === 'state') options.onState(msg.face, msg.why);
      else if (msg.type === 'stats') options.onStats(msg.stats);
      else if (msg.type === 'lines') options.onLines(msg.lines);
      else if (msg.type === 'marks') options.onMarks(msg.marks);
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
    if (wire) transfer.push(wire);
    send(
      {
        type: 'start',
        model: options.model,
        width: first.width,
        height: first.height,
        fps: FPS,
        background: options.background,
        frame: options.frame,
        mirror: options.mirror,
        expressions: options.expressions,
        wasm,
        weights,
        frames,
        sink,
        wire
      },
      transfer
    );
    watch(options.camera);
  });
}
