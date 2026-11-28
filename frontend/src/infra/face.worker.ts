/// <reference lib="webworker" />

import { FaceLandmarker, type FaceLandmarkerResult, type NormalizedLandmark } from '@mediapipe/tasks-vision';

import type { FaceLines, FaceMarks, FaceState, FromFaceWorker, LoadStep, ModelStats, ToFaceWorker } from '@/infra/face-wire';
import { isSeeThrough, wireBackingOf } from '@/infra/model-backing';
import { createModelScene, type ModelScene } from '@/infra/model-draw';
import { FaceTracker, moodOf, type Pose, type Reading, restPose, SHAPE_COUNT, SHAPES, shapeIndex } from '@/infra/pose';

const scope = self as unknown as DedicatedWorkerGlobalScope;

const HERE = scope.location.origin;
const ours = (target: string): boolean => {
  try {
    const url = new URL(target, scope.location.href);
    return url.origin === HERE || url.protocol === 'data:';
  } catch {
    return false;
  }
};
const plainFetch = scope.fetch.bind(scope);
let early: { url: string; answer: Promise<Response> } | null = null;
scope.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
  const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!ours(target)) return Promise.reject(new TypeError(`the face worker fetches from this site only, not ${target}`));
  if (early && new URL(target, scope.location.href).href === early.url) {
    const { answer } = early;
    early = null;
    return answer;
  }
  return plainFetch(input, init);
};
const plainOpen = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
  if (!ours(String(url))) throw new TypeError(`the face worker fetches from this site only, not ${String(url)}`);
  return (plainOpen as (...args: unknown[]) => void).call(this, method, url, ...rest);
} as typeof XMLHttpRequest.prototype.open;

const STATS_MS = 500;
const LOST_MS = 400;
const post = (msg: FromFaceWorker, transfer: Transferable[] = []) => scope.postMessage(msg, transfer);
const wordsOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

let scene: ModelScene | null = null;
let canvas: OffscreenCanvas | null = null;
let sink: WritableStreamDefaultWriter<VideoFrame> | null = null;
let wire: WritableStreamDefaultWriter<VideoFrame> | null = null;
let flat: OffscreenCanvasRenderingContext2D | null = null;
let backing = '';
let landmarker: FaceLandmarker | null = null;
let cameraReader: ReadableStreamDefaultReader<VideoFrame> | null = null;
const tracker = new FaceTracker();
let pose: Pose = restPose();
const REST: Pose = restPose();
let stopped = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let interval = 1000 / 30;
let lastDraw = 0;
let nextDraw = 0;
let lastStamp = 0;
let lastReadAt = 0;
let readTakes = 0;
const READ_SHARE = 1.6;
let faceSeenAt = 0;
let state: FaceState = 'starting';
const counts = { drawn: 0, reads: 0, readMs: 0, since: 0 };

let marksWanted = false;
let linesTold = false;

function pairs(...lists: { start: number; end: number }[][]): Uint16Array {
  const out = new Uint16Array(lists.reduce((sum, list) => sum + list.length, 0) * 2);
  let at = 0;
  for (const list of lists) {
    for (const join of list) {
      out[at++] = join.start;
      out[at++] = join.end;
    }
  }
  return out;
}

function linesOf(): FaceLines {
  return {
    mesh: pairs(FaceLandmarker.FACE_LANDMARKS_TESSELATION),
    outline: pairs(FaceLandmarker.FACE_LANDMARKS_FACE_OVAL),
    features: pairs(
      FaceLandmarker.FACE_LANDMARKS_LEFT_EYE,
      FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE,
      FaceLandmarker.FACE_LANDMARKS_LEFT_EYEBROW,
      FaceLandmarker.FACE_LANDMARKS_RIGHT_EYEBROW,
      FaceLandmarker.FACE_LANDMARKS_LIPS
    ),
    irises: pairs(FaceLandmarker.FACE_LANDMARKS_LEFT_IRIS, FaceLandmarker.FACE_LANDMARKS_RIGHT_IRIS)
  };
}

function numbersOf(): Pick<ModelStats, 'yaw' | 'pitch' | 'roll' | 'mouth' | 'blink' | 'smile' | 'brows'> {
  const asked = pose.face ? pose : REST;
  const degrees = (radians: number) => Math.round((radians * 180) / Math.PI);
  const mood = moodOf(asked.shapes);
  return {
    yaw: degrees(asked.yaw),
    pitch: degrees(asked.pitch),
    roll: degrees(asked.roll),
    mouth: Math.round(asked.shapes[shapeIndex('jawOpen')]! * 100),
    blink: Math.round(((asked.shapes[shapeIndex('eyeBlinkLeft')]! + asked.shapes[shapeIndex('eyeBlinkRight')]!) / 2) * 100),
    smile: Math.round(mood.smile * 100),
    brows: Math.round((mood.browUp - mood.browDown) * 100)
  };
}

function tellMarks(found: NormalizedLandmark[] | undefined) {
  let points: Float32Array | null = null;
  if (found) {
    points = new Float32Array(found.length * 2);
    for (let i = 0; i < found.length; i++) {
      points[i * 2] = found[i]!.x;
      points[i * 2 + 1] = found[i]!.y;
    }
  }
  const marks: FaceMarks = { points, ...numbersOf() };
  post({ type: 'marks', marks }, points ? [points.buffer] : []);
}

let step: LoadStep | null = 'model';
const coming = { loaded: 0, sizes: [null, null] as (number | null)[], toldAt: 0 };
const TELL_MS = 100;

function tellLoading(now = false) {
  if (!step || stopped) return;
  const at = performance.now();
  if (!now && (step !== 'reader' || at - coming.toldAt < TELL_MS)) return;
  coming.toldAt = at;
  const total = coming.sizes.every((size) => size !== null && size > 0) ? coming.sizes.reduce<number>((sum, size) => sum + (size ?? 0), 0) : 0;
  post({ type: 'loading', step, loaded: step === 'reader' ? coming.loaded : 0, total: step === 'reader' ? total : 0 });
}

async function countBody(res: Response, slot: number, keep: boolean): Promise<Uint8Array | null> {
  coming.sizes[slot] = !res.ok || res.headers.get('content-encoding') ? 0 : Number(res.headers.get('content-length')) || 0;
  if (!res.ok || !res.body) throw new Error(`http ${res.status}`);
  const reader = res.body.getReader();
  const pieces: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (keep) pieces.push(value);
    size += value.length;
    coming.loaded += value.length;
    tellLoading();
  }
  if (!keep) return null;
  const whole = new Uint8Array(size);
  let at = 0;
  for (const piece of pieces) {
    whole.set(piece, at);
    at += piece.length;
  }
  return whole;
}

function fetchReaderFiles(msg: Extract<ToFaceWorker, { type: 'start' }>): Promise<Uint8Array | null> {
  const url = new URL(msg.wasm.binary, scope.location.href).href;
  const answer = plainFetch(url, { credentials: 'same-origin' });
  early = { url, answer };
  answer
    .then((res) => countBody(res.clone(), 0, false))
    .catch(() => {
      coming.sizes[0] = 0;
    });
  return plainFetch(msg.weights)
    .then((res) => countBody(res, 1, true))
    .catch(() => {
      coming.sizes[1] = 0;
      return null;
    });
}

function say(next: FaceState, why?: string) {
  if (next === state && !why) return;
  state = next;
  post({ type: 'state', face: next, ...(why && { why }) });
}

function readingOf(result: FaceLandmarkerResult): Reading | null {
  const matrix = result.facialTransformationMatrixes[0]?.data;
  const categories = result.faceBlendshapes[0]?.categories;
  if (!matrix || matrix.length < 16 || !categories) return null;
  const shapes = new Float32Array(SHAPE_COUNT);
  for (const category of categories) {
    if ((SHAPES as readonly string[]).includes(category.categoryName)) shapes[shapeIndex(category.categoryName as (typeof SHAPES)[number])] = category.score;
  }
  return { matrix, shapes };
}

function read(image: VideoFrame | ImageBitmap) {
  if (!landmarker || stopped) return;
  const began = performance.now();
  if (began - lastReadAt < readTakes * READ_SHARE) return;
  lastReadAt = began;
  lastStamp = Math.max(lastStamp + 1, began);
  let result: FaceLandmarkerResult;
  let reading: Reading | null = null;
  try {
    result = landmarker.detectForVideo(image, lastStamp);
    reading = readingOf(result);
  } catch (err) {
    console.warn('face reader:', wordsOf(err));
    return;
  }
  const now = performance.now();
  counts.reads++;
  counts.readMs += now - began;
  readTakes = readTakes ? readTakes * 0.8 + (now - began) * 0.2 : now - began;
  pose = tracker.update(reading, now);
  if (marksWanted) tellMarks(reading ? result.faceLandmarks[0] : undefined);
  if (reading) {
    faceSeenAt = now;
    say('on');
  } else if (now - faceSeenAt > LOST_MS) {
    say('lost');
  }
}

async function pump(frames: ReadableStream<VideoFrame>) {
  const reader = frames.getReader();
  cameraReader = reader;
  try {
    for (;;) {
      const { value: frame, done } = await reader.read();
      if (done || !frame) break;
      try {
        if (cameraReader === reader) read(frame);
      } finally {
        frame.close();
      }
      if (cameraReader !== reader || stopped) break;
    }
  } catch {
  } finally {
    reader.releaseLock();
    if (cameraReader === reader) cameraReader = null;
  }
}

function useCamera(frames: ReadableStream<VideoFrame> | null) {
  const old = cameraReader;
  cameraReader = null;
  old?.cancel().catch(() => undefined);
  if (frames) void pump(frames);
}

function emit(due: number) {
  if (!canvas) return;
  if (sink) {
    if ((sink.desiredSize ?? 1) <= 0) return;
    const timestamp = Math.round(due * 1000);
    const frame = new VideoFrame(canvas, { timestamp, alpha: 'keep' });
    if (wire && (wire.desiredSize ?? 1) > 0) write(wire, wireFrame(frame, timestamp));
    write(sink, frame);
    return;
  }
  const bitmap = canvas.transferToImageBitmap();
  post({ type: 'bitmap', bitmap }, [bitmap]);
}

function write(to: WritableStreamDefaultWriter<VideoFrame>, frame: VideoFrame) {
  to.write(frame).catch(() => {
    frame.close();
  });
}

function wireFrame(frame: VideoFrame, timestamp: number): VideoFrame {
  if (!canvas || !isSeeThrough(backing)) return frame.clone();
  if (!flat || flat.canvas.width !== canvas.width || flat.canvas.height !== canvas.height)
    flat = new OffscreenCanvas(canvas.width, canvas.height).getContext('2d', { alpha: false });
  if (!flat) return frame.clone();
  flat.fillStyle = wireBackingOf(backing);
  flat.fillRect(0, 0, canvas.width, canvas.height);
  flat.drawImage(canvas, 0, 0);
  return new VideoFrame(flat.canvas, { timestamp, alpha: 'discard' });
}

function tick() {
  timer = null;
  if (stopped || !scene) return;
  const now = performance.now();
  const dt = Math.min(0.1, Math.max(0, (now - lastDraw) / 1000));
  lastDraw = now;
  try {
    scene.draw(pose, dt);
    emit(nextDraw);
  } catch (err) {
    fail(`the model stopped drawing: ${wordsOf(err)}`);
    return;
  }
  counts.drawn++;
  if (now - counts.since >= STATS_MS) sendStats(now);
  nextDraw += interval;
  if (nextDraw < now) nextDraw = now + interval;
  timer = setTimeout(tick, Math.max(0, nextDraw - performance.now()));
}

function sendStats(now: number) {
  const seconds = (now - counts.since) / 1000;
  const stats: ModelStats = {
    fps: Math.round(counts.drawn / seconds),
    reads: Math.round(counts.reads / seconds),
    readMs: counts.reads ? Math.round(counts.readMs / counts.reads) : 0,
    face: pose.face,
    ...numbersOf()
  };
  counts.drawn = counts.reads = counts.readMs = 0;
  counts.since = now;
  post({ type: 'stats', stats });
}

function fail(why: string) {
  if (stopped) return;
  shutdown();
  post({ type: 'failed', why });
}

function shutdown() {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
  useCamera(null);
  try {
    landmarker?.close();
  } catch {
  }
  landmarker = null;
  sink?.close().catch(() => undefined);
  sink = null;
  wire?.close().catch(() => undefined);
  wire = null;
  flat = null;
  scene?.dispose();
  scene = null;
}

async function loadReader(msg: Extract<ToFaceWorker, { type: 'start' }>, files: Promise<Uint8Array | null>) {
  let classic = true;
  try {
    scope.importScripts();
  } catch {
    classic = false;
  }
  if (classic === msg.wasm.module) console.warn(`face reader: a ${classic ? 'classic' : 'module'} worker handed the ${msg.wasm.module ? 'module' : 'classic'} loader`);
  const fileset = { wasmLoaderPath: msg.wasm.loader, wasmBinaryPath: msg.wasm.binary };
  const weights = await files;
  if (stopped) return;
  const options = (delegate: 'GPU' | 'CPU') => ({
    baseOptions: weights ? { modelAssetBuffer: weights, delegate } : { modelAssetPath: msg.weights, delegate },
    runningMode: 'VIDEO' as const,
    numFaces: 1,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true
  });
  try {
    let made: FaceLandmarker;
    try {
      made = await FaceLandmarker.createFromOptions(fileset, options('GPU'));
    } catch (err) {
      console.warn('face reader: no gpu for it, reading on the cpu:', wordsOf(err));
      made = await FaceLandmarker.createFromOptions(fileset, options('CPU'));
    }
    if (stopped) {
      made.close();
      return;
    }
    try {
      lastStamp = Math.max(lastStamp + 1, performance.now());
      made.detectForVideo(new OffscreenCanvas(256, 256).transferToImageBitmap(), lastStamp);
    } catch {
    }
    landmarker = made;
    faceSeenAt = performance.now();
    step = null;
    say('lost');
  } catch (err) {
    step = null;
    say('off', wordsOf(err));
  }
}

const READER_WAIT_MS = 4000;

async function start(msg: Extract<ToFaceWorker, { type: 'start' }>) {
  interval = 1000 / Math.min(60, Math.max(5, msg.fps));
  tracker.mirror = msg.mirror;
  tellLoading(true);
  const files = fetchReaderFiles(msg);
  try {
    canvas = new OffscreenCanvas(msg.width, msg.height);
    canvas.addEventListener('webglcontextlost', () => fail('the drawing was lost (the gpu let go of it)'));
    backing = msg.background;
    scene = await createModelScene(canvas, msg.model, msg.background, msg.frame);
    if (stopped) {
      scene.dispose();
      scene = null;
      return;
    }
    scene.setExpressions(msg.expressions);
    sink = msg.sink ? msg.sink.getWriter() : null;
    wire = msg.wire ? msg.wire.getWriter() : null;
    scene.draw(pose, 0);
    emit(performance.now());
  } catch (err) {
    fail(wordsOf(err));
    return;
  }
  step = 'reader';
  tellLoading(true);
  const reader = loadReader(msg, files);
  await Promise.race([reader, new Promise((resolve) => setTimeout(resolve, READER_WAIT_MS))]);
  if (stopped || !scene) return;
  post({ type: 'ready', rig: scene.rig, fitAspect: scene.fitAspect });
  lastDraw = nextDraw = counts.since = performance.now();
  nextDraw += interval;
  timer = setTimeout(tick, interval);
  if (msg.frames) void pump(msg.frames);
  else post({ type: 'want' });
}

scope.onmessage = (e: MessageEvent<ToFaceWorker>) => {
  const msg = e.data;
  if (msg.type === 'start') void start(msg);
  else if (msg.type === 'frames') useCamera(msg.frames);
  else if (msg.type === 'frame') {
    try {
      read(msg.bitmap);
    } finally {
      msg.bitmap.close();
    }
    if (!stopped) post({ type: 'want' });
  } else if (msg.type === 'set') {
    if (msg.mirror !== undefined) tracker.mirror = msg.mirror;
    if (msg.background !== undefined) {
      backing = msg.background;
      scene?.setBackground(msg.background);
    }
    if (msg.expressions !== undefined) scene?.setExpressions(msg.expressions);
    if (msg.frame !== undefined) scene?.setFrame(msg.frame);
    if (msg.marks !== undefined) {
      marksWanted = msg.marks;
      if (marksWanted && !linesTold) {
        linesTold = true;
        post({ type: 'lines', lines: linesOf() });
      }
    }
  } else if (msg.type === 'rest') tracker.rest();
  else if (msg.type === 'stop') {
    shutdown();
    scope.close();
  }
};
