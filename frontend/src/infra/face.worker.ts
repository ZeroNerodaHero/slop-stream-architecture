/// <reference lib="webworker" />
/**
 * The face worker (docs/vtuber.md): the camera's frames in, the model's frames out, and the
 * page nowhere in between. It reads the face in each camera frame (mediapipe's face
 * landmarker, in wasm), turns the reading into a pose (`pose.ts`), and thirty times a second
 * moves the model toward that pose and draws it (`model-draw.ts`).
 *
 * In a worker because a page that is hidden gets no animation frames and one timer a second,
 * and the streamer is in another tab, or a game, the whole time. A worker's timers and a
 * camera's frames are not held back. Where the browser hands a track's frames to a worker and
 * makes a track of a worker's frames (`frames` and `sink` on `start`), the whole loop is in
 * here and a hidden tab changes nothing. Where it cannot, the page posts each camera frame in
 * and gets each drawn frame back, and that way stops when the page does.
 *
 * The reading and the drawing are not tied: the model is drawn on a timer, from whatever pose
 * the last reading left, so a slow reader makes a face that follows late, never a picture
 * that stutters, and a camera with no face in it still leaves a model that breathes.
 *
 * This worker talks to this site and to nobody else (`fetch` and `XMLHttpRequest` below). The
 * reader is pinned to the last version that sends nothing to its maker; this is the second
 * lock on that door.
 */

import { FaceLandmarker, type FaceLandmarkerResult } from '@mediapipe/tasks-vision';

import type { FaceState, FromFaceWorker, ModelStats, ToFaceWorker } from '@/infra/face-wire';
import { createModelScene, type ModelScene } from '@/infra/model-draw';
import { FaceTracker, type Pose, type Reading, restPose, SHAPE_COUNT, SHAPES, shapeIndex } from '@/infra/pose';

const scope = self as unknown as DedicatedWorkerGlobalScope;

// ---- this site only ------------------------------------------------------------------------
const HERE = scope.location.origin;
const ours = (target: string): boolean => {
  try {
    const url = new URL(target, scope.location.href);
    // a blob made here has this origin; a data: url has none and goes nowhere
    return url.origin === HERE || url.protocol === 'data:';
  } catch {
    return false;
  }
};
const plainFetch = scope.fetch.bind(scope);
scope.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
  const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return ours(target) ? plainFetch(input, init) : Promise.reject(new TypeError(`the face worker fetches from this site only, not ${target}`));
};
const plainOpen = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
  if (!ours(String(url))) throw new TypeError(`the face worker fetches from this site only, not ${String(url)}`);
  return (plainOpen as (...args: unknown[]) => void).call(this, method, url, ...rest);
} as typeof XMLHttpRequest.prototype.open;

// ---- the loop --------------------------------------------------------------------------------
/** Stats go to the page this often. */
const STATS_MS = 500;
/** No face for this long is `lost`: a blink of the reader is not. */
const LOST_MS = 400;
const post = (msg: FromFaceWorker, transfer: Transferable[] = []) => scope.postMessage(msg, transfer);
const wordsOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

let scene: ModelScene | null = null;
let canvas: OffscreenCanvas | null = null;
let sink: WritableStreamDefaultWriter<VideoFrame> | null = null;
let landmarker: FaceLandmarker | null = null;
let cameraReader: ReadableStreamDefaultReader<VideoFrame> | null = null;
const tracker = new FaceTracker();
/** The pose the model is drawn toward: the last reading's, or rest. */
let pose: Pose = restPose();
let stopped = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let interval = 1000 / 30;
let lastDraw = 0;
let nextDraw = 0;
/** The reader's own clock must only go up. */
let lastStamp = 0;
/** When the last reading began, and what a reading takes (smoothed): the reader's share of this thread is kept from these. */
let lastReadAt = 0;
let readTakes = 0;
/** A reading is not begun sooner after the last one than this many times what a reading takes. */
const READ_SHARE = 1.6;
let faceSeenAt = 0;
let state: FaceState = 'starting';
const counts = { drawn: 0, reads: 0, readMs: 0, since: 0 };

function say(next: FaceState, why?: string) {
  if (next === state && !why) return;
  state = next;
  post({ type: 'state', face: next, ...(why && { why }) });
}

/** The reader's answer as a reading: the head's matrix and the 52 scores by name. `null`: no face in the frame. */
function readingOf(result: FaceLandmarkerResult): Reading | null {
  const matrix = result.facialTransformationMatrixes[0]?.data;
  const categories = result.faceBlendshapes[0]?.categories;
  if (!matrix || matrix.length < 16 || !categories) return null;
  const shapes = new Float32Array(SHAPE_COUNT);
  for (const category of categories) {
    // the reader has a `_neutral` and no `tongueOut`: by name, never by place
    if ((SHAPES as readonly string[]).includes(category.categoryName)) shapes[shapeIndex(category.categoryName as (typeof SHAPES)[number])] = category.score;
  }
  return { matrix, shapes };
}

/**
 * One camera frame through the reader, if it is up. The frame is the caller's to close.
 *
 * The reading and the drawing share this thread. A reader that takes about as long as the
 * camera takes to make a frame (no gpu for it, or a game on the gpu) would read every frame
 * and leave the drawing whatever was left: so a frame that comes too soon after the last
 * reading began is let go unread. A quick reader reads them all; a slow one reads every
 * second or third, and the model is still drawn on time, its face a little later.
 */
function read(image: VideoFrame | ImageBitmap) {
  if (!landmarker || stopped) return;
  const began = performance.now();
  if (began - lastReadAt < readTakes * READ_SHARE) return;
  lastReadAt = began;
  lastStamp = Math.max(lastStamp + 1, began);
  let reading: Reading | null = null;
  try {
    reading = readingOf(landmarker.detectForVideo(image, lastStamp));
  } catch (err) {
    // one frame the reader choked on is not the end of the reader
    console.warn('face reader:', wordsOf(err));
    return;
  }
  const now = performance.now();
  counts.reads++;
  counts.readMs += now - began;
  readTakes = readTakes ? readTakes * 0.8 + (now - began) * 0.2 : now - began;
  pose = tracker.update(reading, now);
  if (reading) {
    faceSeenAt = now;
    say('on');
  } else if (now - faceSeenAt > LOST_MS) {
    say('lost');
  }
}

/** The camera's frames, as they come, for as long as this stream is the camera. A frame not read is still closed: the camera has only so many. */
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
    // the track ended, or another camera took over
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

/**
 * The frame just drawn, on its way out: into the track's stream, or back to the page. `due` is
 * the time the frame carries, in ms: when it was due, not when this thread got to it. A reading
 * can hold a frame up by its own length, and a frame stamped with that would reach a watcher as
 * a picture that hurries and waits (their player drops the ones that come too close). Stamped
 * with the time it was due, the frames are evenly spaced however this thread ran.
 */
function emit(due: number) {
  if (!canvas) return;
  if (sink) {
    // the encoder is behind: this frame is not handed over, the next one is newer
    if ((sink.desiredSize ?? 1) <= 0) return;
    const frame = new VideoFrame(canvas, { timestamp: Math.round(due * 1000), alpha: 'discard' });
    sink.write(frame).catch(() => {
      // the track was stopped under us: the page's stop follows
      frame.close();
    });
    return;
  }
  const bitmap = canvas.transferToImageBitmap();
  post({ type: 'bitmap', bitmap }, [bitmap]);
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
  // the next frame is due a frame after this one was, not after it finished: a slow frame does not slow the rest.
  // more than a frame behind (the thread was held): the frames that were due meanwhile are not made up
  nextDraw += interval;
  if (nextDraw < now) nextDraw = now + interval;
  timer = setTimeout(tick, Math.max(0, nextDraw - performance.now()));
}

function sendStats(now: number) {
  const seconds = (now - counts.since) / 1000;
  const degrees = (radians: number) => Math.round((radians * 180) / Math.PI);
  const stats: ModelStats = {
    fps: Math.round(counts.drawn / seconds),
    reads: Math.round(counts.reads / seconds),
    readMs: counts.reads ? Math.round(counts.readMs / counts.reads) : 0,
    face: pose.face,
    yaw: degrees(pose.yaw),
    pitch: degrees(pose.pitch),
    roll: degrees(pose.roll),
    mouth: Math.round(pose.shapes[shapeIndex('jawOpen')]! * 100),
    blink: Math.round(((pose.shapes[shapeIndex('eyeBlinkLeft')]! + pose.shapes[shapeIndex('eyeBlinkRight')]!) / 2) * 100)
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
    // already gone
  }
  landmarker = null;
  sink?.close().catch(() => undefined);
  sink = null;
  scene?.dispose();
  scene = null;
}

/** The reader, on the gpu where it can be, else on the cpu. It never stops a model: with no reader the model breathes and blinks. */
async function loadReader(msg: Extract<ToFaceWorker, { type: 'start' }>) {
  // a worker built one way and handed the other loader: say which, the reader's own error does not
  let classic = true;
  try {
    scope.importScripts();
  } catch {
    classic = false;
  }
  if (classic === msg.wasm.module) console.warn(`face reader: a ${classic ? 'classic' : 'module'} worker handed the ${msg.wasm.module ? 'module' : 'classic'} loader`);
  const fileset = { wasmLoaderPath: msg.wasm.loader, wasmBinaryPath: msg.wasm.binary };
  const options = (delegate: 'GPU' | 'CPU') => ({
    baseOptions: { modelAssetPath: msg.weights, delegate },
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
    // the first reading is the slow one (the graph starts, the gpu compiles): made here, on nothing, so it is
    // not made on the first camera frame with the model already on the stream
    try {
      lastStamp = Math.max(lastStamp + 1, performance.now());
      made.detectForVideo(new OffscreenCanvas(256, 256).transferToImageBitmap(), lastStamp);
    } catch {
      // a reader that will not read a blank frame may still read a face
    }
    landmarker = made;
    faceSeenAt = performance.now();
    say('lost');
  } catch (err) {
    say('off', wordsOf(err));
  }
}

/** The longest a model waits for its face reader before it goes on without it: the reader joins when it is up. */
const READER_WAIT_MS = 4000;

async function start(msg: Extract<ToFaceWorker, { type: 'start' }>) {
  interval = 1000 / Math.min(60, Math.max(5, msg.fps));
  tracker.mirror = msg.mirror;
  try {
    canvas = new OffscreenCanvas(msg.width, msg.height);
    canvas.addEventListener('webglcontextlost', () => fail('the drawing was lost (the gpu let go of it)'));
    scene = await createModelScene(canvas, msg.model, msg.background);
    if (stopped) {
      scene.dispose();
      scene = null;
      return;
    }
    sink = msg.sink ? msg.sink.getWriter() : null;
    // the first frame before `ready`: the track has a picture in it by the time it is put in the camera's slot
    scene.draw(pose, 0);
    emit(performance.now());
  } catch (err) {
    fail(wordsOf(err));
    return;
  }
  // the reader loads on this thread, and while it does nothing is drawn: wait for it (not for long) before
  // saying `ready`, so the model does not go on the stream and then stand still for its first second
  const reader = loadReader(msg);
  await Promise.race([reader, new Promise((resolve) => setTimeout(resolve, READER_WAIT_MS))]);
  if (stopped) return;
  post({ type: 'ready' });
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
    if (msg.background !== undefined) scene?.setBackground(msg.background);
  } else if (msg.type === 'rest') tracker.rest();
  else if (msg.type === 'stop') {
    shutdown();
    scope.close();
  }
};
