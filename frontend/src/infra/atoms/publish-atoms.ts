import { atom } from 'jotai';
import { atomWithStorage } from 'jotai/utils';

import { ApiError, api, type DemoModel, type Owner, messageOf, statusOf } from '@/infra/api';
import { loadMe, meAtom } from '@/infra/atoms/auth-atoms';
import { nickAtom } from '@/infra/atoms/chat-atoms';
import { cropPicture } from '@/infra/atoms/crop-atoms';
import { record } from '@/infra/atoms/inspector-atoms';
import { publishPipAtom } from '@/infra/atoms/publish-state';
import { endWatch } from '@/infra/atoms/watch-atoms';
import { pipAtom } from '@/infra/atoms/watch-state';
import {
  type FaceLines,
  type FaceMarks,
  type FaceState,
  type LoadStep,
  type ModelSession,
  type ModelStats,
  type RigInfo,
  startModel,
  warmModelFiles
} from '@/infra/face';
import { type Mixer, openMixer } from '@/infra/mixer';
import { readModel } from '@/infra/model-file';
import {
  forgetKept,
  formatOf,
  keepDemo,
  keepForGood,
  keepModel,
  type KeptModel,
  keptDemoFile,
  keptFile,
  listKept,
  listKeptDemos,
  pruneKeptDemos
} from '@/infra/model-store';
import { cleanName, isValidName } from '@/infra/names';
import { centredRect, cutPicture, SCENE_PICTURE, THUMB_PICTURE } from '@/infra/picture';
import { type Box, connectRelay, type Fit, isVideoLayer, SCREEN_SLOTS, type SlotInfo, viewersOf, waitForIceGathering } from '@/infra/relay';
import { reportPeerFailure } from '@/infra/report';
import {
  arrangedAfterAdd,
  arrangedAfterRemove,
  AVATAR_ID,
  FULL,
  imageBox,
  isVideoSource,
  movedBox,
  presetOf,
  ratioOf,
  resizedBox,
  roleOf,
  sceneOf,
  type Source,
  validPreset
} from '@/infra/scene';
import { type StreamStats, startSampler } from '@/infra/stream-stats';
import { store } from '@/infra/store';
import type { Tone } from '@/shared-components/StatusLine';

export type PublishPhase =
  | 'camera-off'
  | 'camera-blocked'
  | 'no-camera'
  | 'camera-ready'
  | 'mic-ready'
  | 'mic-blocked'
  | 'no-mic'
  | 'starting'
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'stopped'
  | 'failed';

const HEARTBEAT_MS = 15000;
const VIDEO_MAX_BITRATE = 2_500_000;
const CAMERA_SHARING_BITRATE = 500_000;
const SCREENS_BITRATE = 3_000_000;
const BUSY_PHASES: readonly PublishPhase[] = ['starting', 'connecting', 'live', 'reconnecting'];
const BAD_PHASES: readonly PublishPhase[] = ['camera-blocked', 'no-camera', 'mic-blocked', 'no-mic', 'failed'];
const CAMERA_VIDEO: MediaTrackConstraints = { width: { ideal: 1280 }, height: { ideal: 720 } };
const SCREEN_CAP: MediaTrackConstraints = { width: { max: 1920 }, height: { max: 1080 }, frameRate: { max: 30 } };
interface DisplayHints extends DisplayMediaStreamOptions {
  selfBrowserSurface?: 'include' | 'exclude';
  surfaceSwitching?: 'include' | 'exclude';
}
const SCREEN_HINTS: DisplayHints = { video: SCREEN_CAP, audio: false, selfBrowserSurface: 'exclude', surfaceSwitching: 'include' };
const SCENE_SEND_MS = 150;
const TUNE_MS = 500;
const SIDE_SCREEN_BITRATE = 500_000;
const SIDE_SCREEN_FPS = 15;
const CAMERA_BPS_PER_WIDTH = 1_200_000;
const CAMERA_MIN_BITRATE = 150_000;
const CAMERA_SCALES = [1, 1.33, 2, 2.67, 4];

export const cameraAtom = atom<MediaStream | null>(null);
export const hasCameraAtom = atom((get) => (get(cameraAtom)?.getVideoTracks().length ?? 0) > 0);
export const hasMicAtom = atom((get) => (get(cameraAtom)?.getAudioTracks().length ?? 0) > 0);
const storedMicOnlyAtom = atomWithStorage<unknown>('settings.micOnly', false, undefined, { getOnInit: true });
export const micOnlyAtom = atom((get) => get(storedMicOnlyAtom) === true);
export interface SharedScreen {
  slot: number;
  label: string;
}
export const screensAtom = atom<SharedScreen[]>([]);
const screenPickingAtom = atom(false);
export const screenMaySeePageAtom = atom((get) => get(screenPickingAtom) || get(screensAtom).length > 0);
const screenStreamAtoms = Array.from({ length: SCREEN_SLOTS }, () => atom<MediaStream | null>(null));
const spareStreamAtom = atom<MediaStream | null>(null);
export const screenStreamAtom = (slot: number) => screenStreamAtoms[slot] ?? spareStreamAtom;
export const sentStreamAtom = (slot: number) => (slot === 0 ? cameraAtom : screenStreamAtom(slot - 1));
export const screenShareSupported = typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function';

export const sourcesAtom = atom<Source[]>([]);
export const sceneAtom = atom((get) => sceneOf(get(sourcesAtom)));
export const previewSlotAtom = atom((get) => get(sceneAtom).layers.find(isVideoLayer)?.slot ?? null);
export const previewStreamAtom = atom((get) => {
  const slot = get(previewSlotAtom);
  return slot === null || slot === 0 ? get(cameraAtom) : get(screenStreamAtom(slot - 1));
});
export const selectedSourceAtom = atom<string | null>(null);
export const libraryAtom = atom<{ id: number; mime: string }[]>([]);
export const sourceStatusAtom = atom('');
export const hasAvatarAtom = atom((get) => get(sourcesAtom).some((s) => s.kind === 'avatar'));
const storedLastAtom = atomWithStorage<unknown>('settings.lastArrangement', null, undefined, { getOnInit: true });
const lastArrangementAtom = atom((get) => validPreset(get(storedLastAtom)));
export interface LivePanels {
  sources: boolean;
  rig: boolean;
  sound: boolean;
}
const storedPanelsAtom = atomWithStorage<unknown>('settings.livePanels', { sources: true, rig: true, sound: true }, undefined, { getOnInit: true });
export const livePanelsAtom = atom<LivePanels>((get) => {
  const raw = get(storedPanelsAtom);
  const p = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return { sources: p.sources !== false, rig: p.rig !== false, sound: p.sound !== false };
});

export interface MixRow {
  id: string;
  label: string;
  level: number;
  muted: boolean;
}
export const MASTER = 'master';
export const mixRowsAtom = atom<MixRow[]>([]);
export const masterRowAtom = atom<MixRow>({ id: MASTER, label: 'everyone hears', level: 1, muted: false });
const storedMixAtom = atomWithStorage<unknown>('settings.mixer', null, undefined, { getOnInit: true });
export const mixerOpenAtom = atom(false);
export const mixerRunningAtom = atom(true);

export type ModelChoice = { kind: 'demo'; id: string; v: string; name: string } | { kind: 'kept'; id: number; name: string };
export const modelAtom = atom<ModelChoice | null>(null);
export interface ModelLoad {
  choice: ModelChoice;
  step: 'file' | LoadStep;
  loaded: number;
  total: number;
}
export const modelLoadAtom = atom<ModelLoad | null>(null);
export const modelLoadingAtom = atom((get) => get(modelLoadAtom) !== null);
export const readerLoadAtom = atom<{ loaded: number; total: number } | null>(null);
export const modelStatusAtom = atom('');
export type FaceReading = FaceState | 'idle' | 'no-camera' | 'camera-blocked';
export const faceAtom = atom<FaceReading>('idle');
export const faceStatsAtom = atom<ModelStats | null>(null);
export const modelRigAtom = atom<RigInfo | null>(null);
export const faceCamerasAtom = atom<{ id: string; label: string }[]>([]);
export const readerCameraAtom = atom<MediaStream | null>(null);
export const faceLinesAtom = atom<FaceLines | null>(null);
export const demoModelsAtom = atom<DemoModel[]>([]);
export const keptModelsAtom = atom<KeptModel[]>([]);
export const keptDemosAtom = atom<ReadonlyMap<string, string>>(new Map<string, string>());
const MODEL_BACKGROUND = '#181b22';
const storedModelAtom = atomWithStorage<unknown>('settings.model', null, undefined, { getOnInit: true });
const storedFaceCameraAtom = atomWithStorage<unknown>('settings.faceCamera', '', undefined, { getOnInit: true });
const storedFaceMirrorAtom = atomWithStorage<unknown>('settings.faceMirror', true, undefined, { getOnInit: true });
const storedFaceExpressionsAtom = atomWithStorage<unknown>('settings.faceExpressions', true, undefined, { getOnInit: true });
const storedModelBackgroundAtom = atomWithStorage<unknown>('settings.modelBackground', MODEL_BACKGROUND, undefined, { getOnInit: true });
const storedRigPictureAtom = atomWithStorage<unknown>('settings.rigPicture', true, undefined, { getOnInit: true });
export const faceCameraAtom = atom((get) => {
  const id = get(storedFaceCameraAtom);
  return typeof id === 'string' ? id : '';
});
export const faceMirrorAtom = atom((get) => get(storedFaceMirrorAtom) !== false);
export const faceExpressionsAtom = atom((get) => get(storedFaceExpressionsAtom) !== false);
export const rigPictureAtom = atom(() => true);
export const modelBackgroundAtom = atom((get) => {
  const colour = get(storedModelBackgroundAtom);
  return typeof colour === 'string' && /^#[0-9a-f]{6}$/i.test(colour) ? colour : MODEL_BACKGROUND;
});
function validModelChoice(raw: unknown): ModelChoice | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  if (typeof c.name !== 'string') return null;
  if (c.kind === 'demo' && typeof c.id === 'string' && /^[a-z0-9_-]{1,48}$/.test(c.id) && typeof c.v === 'string')
    return { kind: 'demo', id: c.id, v: c.v, name: c.name };
  if (c.kind === 'kept' && typeof c.id === 'number' && Number.isInteger(c.id) && c.id >= 0) return { kind: 'kept', id: c.id, name: c.name };
  return null;
}
export const publishPhaseAtom = atom<PublishPhase>('camera-off');
export const publishStatsAtom = atom<StreamStats | null>(null);
export const publishMessageAtom = atom('camera off');
export const streamNameAtom = atom('');
export const chatRoomAtom = atom('');
export const ownerAtom = atom<Owner | null>(null);
export const liveViewersAtom = atom<number | null>(null);
export const streamThumbsAtom = atom<number[]>([]);
export const thumbStatusAtom = atom('');

const MAX_THUMBS = 6;

export const isPublishingAtom = atom((get) => BUSY_PHASES.includes(get(publishPhaseAtom)));
export const canStartAtom = atom((get) => get(cameraAtom) !== null && isValidName(get(streamNameAtom)) && !get(isPublishingAtom));
export const canShareScreenAtom = atom((get) => screenShareSupported && get(screensAtom).length < SCREEN_SLOTS);
export const watchUrlAtom = atom((get) => {
  const owner = get(ownerAtom);
  return owner ? `${location.origin}/watch/${owner.name}?s=${owner.session}` : null;
});
export const publishToneAtom = atom<Tone>((get) => {
  const phase = get(publishPhaseAtom);
  if (phase === 'live') return 'live';
  return BAD_PHASES.includes(phase) ? 'bad' : 'neutral';
});

let pc: RTCPeerConnection | null = null;
let stopStats: (() => void) | null = null;
let ws: WebSocket | null = null;
let abort: AbortController | null = null;
let heartbeat: ReturnType<typeof setInterval> | null = null;
let sceneTimer: ReturnType<typeof setTimeout> | null = null;
let tuneTimer: ReturnType<typeof setTimeout> | null = null;
let cameraSender: RTCRtpSender | null = null;
let screenSenders: RTCRtpSender[] = [];
let mixer: Mixer | null = null;
let modelSession: ModelSession | null = null;
let faceCamera: MediaStreamTrack | null = null;
const marksListeners = new Set<(marks: FaceMarks) => void>();
let modelToken = 0;
let cameraCap = VIDEO_MAX_BITRATE;
let imageCount = 0;
let liveGeneration = 0;
let profileName = '';

function labelOfPublishTrack(trackId: string): string | undefined {
  for (const screen of store.get(screensAtom)) {
    if (store.get(screenStreamAtom(screen.slot))?.getVideoTracks()[0]?.id === trackId) return screen.label;
  }
  return undefined;
}

function startPublishStats() {
  stopPublishStats();
  stopStats = startSampler({
    role: 'publish',
    pc: () => pc,
    videoTrackId: () => store.get(cameraAtom)?.getVideoTracks()[0]?.id,
    audioMuted: () => {
      if (mixer) return store.get(masterRowAtom).muted;
      const track = store.get(cameraAtom)?.getAudioTracks()[0];
      return !!track && (track.muted || !track.enabled);
    },
    capBps: () => cameraCap,
    labelOf: labelOfPublishTrack,
    write: (stats) => store.set(publishStatsAtom, stats)
  });
}

function stopPublishStats() {
  stopStats?.();
  stopStats = null;
}

function setPhase(phase: PublishPhase, message: string) {
  store.set(publishPhaseAtom, phase);
  store.set(publishMessageAtom, message);
}

export function setStreamName(raw: string) {
  store.set(streamNameAtom, cleanName(raw));
}

export function commitStreamName(): Promise<void> {
  const name = store.get(streamNameAtom);
  store.set(chatRoomAtom, isValidName(name) ? name : '');
  return loadProfile();
}

export async function enterLivePage(): Promise<void> {
  warmModelFiles();
  if (store.get(isPublishingAtom)) return;
  const generation = liveGeneration;
  await loadMe();
  if (generation !== liveGeneration) return;
  const me = store.get(meAtom);
  setStreamName(me ?? store.get(nickAtom));
  await commitStreamName();
}

export async function startCamera(): Promise<void> {
  if (store.get(cameraAtom)) return;
  const kept = validModelChoice(store.get(storedModelAtom));
  if (kept) return startWithModel(kept);
  if (store.get(micOnlyAtom)) return startMic();
  const generation = liveGeneration;
  let camera: MediaStream;
  try {
    camera = await navigator.mediaDevices.getUserMedia({ video: CAMERA_VIDEO, audio: true });
  } catch (err) {
    if (generation !== liveGeneration) return;
    if (err instanceof DOMException && err.name === 'NotAllowedError') {
      setPhase('camera-blocked', 'camera blocked');
      return;
    }
    try {
      camera = await navigator.mediaDevices.getUserMedia({ video: CAMERA_VIDEO, audio: false });
    } catch {
      if (generation === liveGeneration) setPhase('no-camera', 'no camera');
      return;
    }
  }
  if (generation !== liveGeneration) {
    camera.getTracks().forEach((track) => track.stop());
    return;
  }
  store.set(cameraAtom, camera);
  ensureCameraSource();
  setPhase('camera-ready', camera.getAudioTracks().length ? 'camera ready' : 'camera ready, no mic');
}

export async function startMic(): Promise<void> {
  if (store.get(cameraAtom)) return;
  const generation = liveGeneration;
  let mic: MediaStream;
  try {
    mic = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    if (generation !== liveGeneration) return;
    const blocked = err instanceof DOMException && err.name === 'NotAllowedError';
    setPhase(blocked ? 'mic-blocked' : 'no-mic', blocked ? 'mic blocked' : 'no mic');
    return;
  }
  if (generation !== liveGeneration) {
    mic.getTracks().forEach((track) => track.stop());
    return;
  }
  store.set(storedMicOnlyAtom, true);
  store.set(cameraAtom, mic);
  ensureAvatarSource();
  setPhase('mic-ready', 'mic ready');
}

export function cameraOff() {
  const camera = store.get(cameraAtom);
  if (!camera || !store.get(hasCameraAtom) || !store.get(hasMicAtom)) return;
  if (modelSession) {
    dropModel();
    store.set(storedModelAtom, null);
  }
  camera.getVideoTracks().forEach((track) => track.stop());
  store.set(cameraAtom, new MediaStream(camera.getAudioTracks()));
  cameraSender?.replaceTrack(null).catch(() => undefined);
  store.set(storedMicOnlyAtom, true);
  dropSource('cam');
  ensureAvatarSource();
  if (!store.get(isPublishingAtom)) setPhase('mic-ready', 'mic ready');
  slotsChanged();
}

export async function cameraOn(): Promise<void> {
  const had = store.get(cameraAtom);
  if (store.get(hasCameraAtom)) return;
  store.set(storedMicOnlyAtom, false);
  store.set(storedModelAtom, null);
  if (!had) return startCamera();
  const generation = liveGeneration;
  let picture: MediaStream;
  try {
    picture = await navigator.mediaDevices.getUserMedia({ video: CAMERA_VIDEO });
  } catch (err) {
    if (generation !== liveGeneration) return;
    store.set(storedMicOnlyAtom, true);
    store.set(sourceStatusAtom, err instanceof DOMException && err.name === 'NotAllowedError' ? 'camera blocked' : 'no camera');
    return;
  }
  if (generation !== liveGeneration || store.get(cameraAtom) !== had) {
    picture.getTracks().forEach((track) => track.stop());
    return;
  }
  const track = picture.getVideoTracks()[0]!;
  track.contentHint = 'motion';
  store.set(cameraAtom, new MediaStream([...had.getAudioTracks(), track]));
  cameraSender?.replaceTrack(track).catch(() => undefined);
  setSources(store.get(sourcesAtom).map((s) => (s.kind === 'avatar' ? { ...s, shown: false } : s)));
  ensureCameraSource();
  store.set(sourceStatusAtom, '');
  if (!store.get(isPublishingAtom)) setPhase('camera-ready', store.get(hasMicAtom) ? 'camera ready' : 'camera ready, no mic');
  slotsChanged();
}

function ensureCameraSource() {
  const sources = store.get(sourcesAtom);
  if (sources.some((s) => s.kind === 'camera')) return;
  const camera: Source = { id: 'cam', kind: 'camera', label: 'camera', slot: 0, box: FULL, shown: true };
  setSources(arrangedAfterAdd([camera, ...sources], camera, store.get(lastArrangementAtom)));
}

function ensureAvatarSource() {
  const sources = store.get(sourcesAtom);
  const there = sources.find((s) => s.kind === 'avatar');
  if (there) {
    if (!there.shown) withSource(there.id, (s) => ({ ...s, shown: true }));
    return;
  }
  const avatar: Source = { id: AVATAR_ID, kind: 'avatar', label: 'avatar', box: FULL, shown: true };
  const face = !sources.some((s) => s.kind === 'camera');
  setSources(arrangedAfterAdd(face ? [avatar, ...sources] : [...sources, avatar], avatar, store.get(lastArrangementAtom)));
}

export function addAvatar() {
  ensureAvatarSource();
  store.set(selectedSourceAtom, AVATAR_ID);
}

class ModelGone extends Error {}

const faceVideo = (deviceId: string): MediaTrackConstraints => ({
  width: { ideal: 640 },
  height: { ideal: 480 },
  frameRate: { ideal: 30 },
  ...(deviceId && { deviceId: { exact: deviceId } })
});

async function openFaceCamera(): Promise<MediaStreamTrack | null> {
  const picked = store.get(faceCameraAtom);
  for (const deviceId of picked ? [picked, ''] : ['']) {
    try {
      return (await navigator.mediaDevices.getUserMedia({ video: faceVideo(deviceId) })).getVideoTracks()[0] ?? null;
    } catch (err) {
      const name = err instanceof DOMException ? err.name : '';
      if (deviceId && (name === 'OverconstrainedError' || name === 'NotFoundError')) continue;
      store.set(faceAtom, name === 'NotAllowedError' ? 'camera-blocked' : 'no-camera');
      return null;
    }
  }
  store.set(faceAtom, 'no-camera');
  return null;
}

async function refreshFaceCameras() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    store.set(
      faceCamerasAtom,
      devices.filter((d) => d.kind === 'videoinput' && d.deviceId).map((d, i) => ({ id: d.deviceId, label: d.label || `camera ${i + 1}` }))
    );
  } catch {
  }
}

function loadStep(choice: ModelChoice, step: ModelLoad['step'], loaded = 0, total = 0) {
  if (store.get(modelLoadAtom)?.choice === choice) store.set(modelLoadAtom, { choice, step, loaded, total });
}

function endLoad(choice: ModelChoice) {
  if (store.get(modelLoadAtom)?.choice === choice) store.set(modelLoadAtom, null);
}

async function refreshKeptDemos() {
  store.set(keptDemosAtom, new Map((await listKeptDemos()).map((demo) => [demo.id, demo.v])));
}

const DOWNLOAD_TELL_MS = 80;

async function downloadDemo(choice: ModelChoice & { kind: 'demo' }, bytes: number): Promise<ArrayBuffer> {
  let res: Response;
  try {
    res = await fetch(api.demoModelUrl(choice));
  } catch {
    throw new Error('could not reach the server for that model');
  }
  if (res.status === 404) throw new ModelGone('that demo model is gone. pick another');
  if (!res.ok) throw new Error(`could not load that model (http ${res.status})`);
  const total = Number(res.headers.get('content-length')) || bytes;
  loadStep(choice, 'file', 0, total);
  if (!res.body) return res.arrayBuffer();
  const reader = res.body.getReader();
  const pieces: Uint8Array[] = [];
  let loaded = 0;
  let toldAt = 0;
  for (;;) {
    let piece: ReadableStreamReadResult<Uint8Array>;
    try {
      piece = await reader.read();
    } catch {
      throw new Error('the download of that model broke off. pick it again');
    }
    if (piece.done) break;
    pieces.push(piece.value);
    loaded += piece.value.length;
    const now = performance.now();
    if (now - toldAt >= DOWNLOAD_TELL_MS) {
      toldAt = now;
      loadStep(choice, 'file', loaded, total);
    }
  }
  loadStep(choice, 'file', loaded, total || loaded);
  const file = new Uint8Array(loaded);
  let at = 0;
  for (const piece of pieces) {
    file.set(piece, at);
    at += piece.length;
  }
  return file.buffer;
}

async function modelFile(choice: ModelChoice, bytes = 0): Promise<ArrayBuffer> {
  if (choice.kind === 'kept') {
    const file = await keptFile(choice.id);
    if (!file) throw new ModelGone('that model is not kept in this browser any more. pick the file again');
    return file;
  }
  const kept = await keptDemoFile(choice.id, choice.v);
  if (kept) return kept;
  const file = await downloadDemo(choice, bytes);
  try {
    readModel(file);
  } catch {
    return file;
  }
  void keepDemo(choice.id, choice.v, new Blob([file])).then((ok) => (ok ? refreshKeptDemos() : undefined));
  return file;
}

function dropModel() {
  modelToken++;
  modelSession?.stop();
  modelSession = null;
  faceCamera?.stop();
  faceCamera = null;
  store.set(readerCameraAtom, null);
  store.set(modelAtom, null);
  store.set(modelRigAtom, null);
  store.set(readerLoadAtom, null);
  store.set(faceAtom, 'idle');
  store.set(faceStatsAtom, null);
}

function modelStopped(why: string) {
  if (store.get(hasMicAtom)) {
    cameraOff();
  } else {
    const had = store.get(cameraAtom);
    dropModel();
    store.set(storedModelAtom, null);
    store.set(storedMicOnlyAtom, true);
    had?.getTracks().forEach((track) => track.stop());
    store.set(cameraAtom, null);
    dropSource('cam');
    if (store.get(isPublishingAtom)) stopLive('the model stopped, and there is no mic', 'failed', { report: false });
    else setPhase('no-mic', 'no mic');
  }
  store.set(sourceStatusAtom, `the model stopped: ${why}`);
}

async function putModelOn(choice: ModelChoice, file: ArrayBuffer, opened: OpenedForModel | null = null): Promise<boolean> {
  const generation = liveGeneration;
  try {
    readModel(file);
  } catch (err) {
    store.set(modelStatusAtom, messageOf(err));
    return false;
  }
  const before = store.get(cameraAtom);
  const old = modelSession;
  const faceWas = store.get(faceAtom);
  const live = (track: MediaStreamTrack | null | undefined) => (track && track.readyState === 'live' ? track : null);
  const own = old ? null : live(before?.getVideoTracks()[0]);
  const camera = opened ? live(opened.camera) : (live(faceCamera) ?? own ?? (await openFaceCamera()));
  const ours = !opened && camera !== null && camera !== faceCamera && camera !== own;
  const token = ++modelToken;
  const mine = () => token === modelToken;
  if (camera) store.set(faceAtom, 'starting');
  else if (store.get(faceAtom) === 'idle') store.set(faceAtom, 'no-camera');

  let session: ModelSession;
  try {
    session = await startModel({
      model: file,
      camera,
      mirror: store.get(faceMirrorAtom),
      expressions: store.get(faceExpressionsAtom),
      background: store.get(modelBackgroundAtom),
      onLoading: (step, loaded, total) => {
        if (!mine()) return;
        loadStep(choice, step, loaded, total);
        store.set(readerLoadAtom, step === 'reader' ? { loaded, total } : null);
      },
      onState: (face) => {
        if (!mine()) return;
        if (face !== 'starting') store.set(readerLoadAtom, null);
        if (camera || faceCamera) store.set(faceAtom, face);
      },
      onStats: (stats) => mine() && store.set(faceStatsAtom, stats),
      onLines: (lines) => store.set(faceLinesAtom, lines),
      onMarks: (marks) => {
        if (mine()) for (const listener of marksListeners) listener(marks);
      },
      onFailed: (why) => mine() && modelStopped(why)
    });
  } catch (err) {
    if (ours) camera.stop();
    if (mine()) {
      store.set(modelStatusAtom, messageOf(err));
      store.set(faceAtom, faceWas);
      store.set(readerLoadAtom, null);
    }
    return false;
  }
  const stale = () => generation !== liveGeneration || !mine() || store.get(cameraAtom) !== before;
  const giveUp = () => {
    session.stop();
    if (ours) camera.stop();
    if (mine()) {
      store.set(faceAtom, faceWas);
      store.set(readerLoadAtom, null);
    }
    return false;
  };
  if (stale()) return giveUp();
  session.track.contentHint = 'motion';
  if (cameraSender) await cameraSender.replaceTrack(session.track).catch(() => undefined);
  if (stale()) return giveUp();
  const sound = before?.getAudioTracks() ?? opened?.mic?.getAudioTracks() ?? [];
  store.set(cameraAtom, new MediaStream([...sound, session.track]));
  old?.stop();
  modelSession = session;
  faceCamera = camera;
  store.set(readerCameraAtom, camera ? new MediaStream([camera]) : null);
  if (marksListeners.size > 0) session.setMarks(true);
  session.setMirror(store.get(faceMirrorAtom));
  session.setExpressions(store.get(faceExpressionsAtom));
  session.setBackground(store.get(modelBackgroundAtom));
  store.set(modelAtom, choice);
  store.set(modelRigAtom, session.rig);
  store.set(storedModelAtom, choice.kind === 'kept' && choice.id < 0 ? null : choice);
  store.set(storedMicOnlyAtom, false);
  store.set(modelStatusAtom, '');
  store.set(sourceStatusAtom, '');
  setSources(store.get(sourcesAtom).map((s) => (s.kind === 'avatar' ? { ...s, shown: false } : s)));
  ensureCameraSource();
  if (!store.get(isPublishingAtom)) setPhase('camera-ready', sound.length ? 'model ready' : 'model ready, no mic');
  slotsChanged();
  void refreshFaceCameras();
  return true;
}

interface OpenedForModel {
  mic: MediaStream | null;
  camera: MediaStreamTrack | null;
}

async function openForModel(): Promise<OpenedForModel> {
  try {
    const both = await navigator.mediaDevices.getUserMedia({ video: faceVideo(store.get(faceCameraAtom)), audio: true });
    return { mic: new MediaStream(both.getAudioTracks()), camera: both.getVideoTracks()[0] ?? null };
  } catch {
    const mic = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null);
    return { mic, camera: await openFaceCamera() };
  }
}

function letGoOf(opened: OpenedForModel) {
  opened.camera?.stop();
  opened.mic?.getTracks().forEach((track) => track.stop());
}

async function startWithModel(choice: ModelChoice): Promise<void> {
  const generation = liveGeneration;
  store.set(modelLoadAtom, { choice, step: 'file', loaded: 0, total: 0 });
  store.set(publishMessageAtom, 'getting your model');
  if (choice.kind === 'kept') void listKept().then((kept) => store.set(keptModelsAtom, kept));
  const [file, opened] = await Promise.all([modelFile(choice).catch((err: unknown) => (err instanceof Error ? err : new Error(String(err)))), openForModel()]);
  const overtaken = () => generation !== liveGeneration || store.get(cameraAtom) !== null;
  const abandon = () => {
    letGoOf(opened);
    if (generation !== liveGeneration) return;
    endLoad(choice);
    if (!modelSession) store.set(faceAtom, 'idle');
  };
  if (overtaken()) return abandon();
  loadStep(choice, 'model');
  const on = !(file instanceof Error) && (await putModelOn(choice, file, opened));
  if (on) {
    endLoad(choice);
    return;
  }
  if (overtaken()) return abandon();
  const why = file instanceof Error ? file.message : store.get(modelStatusAtom);
  opened.camera?.stop();
  endLoad(choice);
  store.set(faceAtom, 'idle');
  if (file instanceof ModelGone) store.set(storedModelAtom, null);
  store.set(modelStatusAtom, '');
  if (!opened.mic || opened.mic.getAudioTracks().length === 0) {
    setPhase('no-mic', 'no mic');
  } else {
    store.set(storedMicOnlyAtom, true);
    store.set(cameraAtom, opened.mic);
    ensureAvatarSource();
    setPhase('mic-ready', 'mic ready');
  }
  store.set(sourceStatusAtom, `no model: ${why}`);
}

async function smallThumb(picture: Blob): Promise<Blob | null> {
  try {
    const bitmap = await createImageBitmap(picture);
    try {
      return await cutPicture(bitmap, centredRect(bitmap.width, bitmap.height, 1), 128, 128, 'image/jpeg', 0.8);
    } finally {
      bitmap.close();
    }
  } catch {
    return null;
  }
}

async function pickModel(first: ModelChoice, fetchIt: () => Promise<{ choice: ModelChoice; file: ArrayBuffer }>): Promise<boolean> {
  if (store.get(modelLoadAtom)) return false;
  const generation = liveGeneration;
  let choice = first;
  store.set(modelLoadAtom, { choice, step: 'file', loaded: 0, total: 0 });
  store.set(modelStatusAtom, '');
  const ours = () => generation === liveGeneration && store.get(modelLoadAtom)?.choice === choice;
  try {
    const picked = await fetchIt();
    if (!ours()) return false;
    choice = picked.choice;
    store.set(modelLoadAtom, { choice, step: 'model', loaded: 0, total: 0 });
    if (store.get(cameraAtom)) return await putModelOn(choice, picked.file);
    readModel(picked.file);
    const opened = await openForModel();
    const on = ours() && store.get(cameraAtom) === null && (await putModelOn(choice, picked.file, opened));
    if (!on) {
      letGoOf(opened);
      if (generation === liveGeneration && !modelSession) store.set(faceAtom, 'idle');
    }
    return on;
  } catch (err) {
    if (generation === liveGeneration) store.set(modelStatusAtom, messageOf(err));
    return false;
  } finally {
    endLoad(choice);
  }
}

export async function loadModelLibrary(): Promise<void> {
  void listKept().then((kept) => store.set(keptModelsAtom, kept));
  void refreshKeptDemos();
  let models: DemoModel[];
  try {
    models = (await api.demoModels()).models ?? [];
  } catch {
    store.set(demoModelsAtom, []);
    return;
  }
  store.set(demoModelsAtom, models);
  const worn = validModelChoice(store.get(storedModelAtom));
  const listed = worn?.kind === 'demo' ? models.find((model) => model.id === worn.id) : undefined;
  if (worn?.kind === 'demo' && listed && listed.v !== worn.v) store.set(storedModelAtom, { kind: 'demo', id: listed.id, v: listed.v, name: listed.name });
  store.set(keptDemosAtom, new Map((await pruneKeptDemos(models)).map((demo) => [demo.id, demo.v])));
}

export function pickDemoModel(model: DemoModel): Promise<boolean> {
  const choice: ModelChoice = { kind: 'demo', id: model.id, v: model.v, name: model.name };
  return pickModel(choice, async () => ({ choice, file: await modelFile(choice, model.bytes) }));
}

export function pickKeptModel(model: KeptModel): Promise<boolean> {
  const choice: ModelChoice = { kind: 'kept', id: model.id, name: model.name };
  return pickModel(choice, async () => ({ choice, file: await modelFile(choice) }));
}

const UNSAVED_MODEL = "couldn't save it, it'll only last this session";

export async function pickModelFile(picked: File): Promise<{ on: boolean; saved: boolean }> {
  const named = picked.name.replace(/\.[^.]+$/, '') || 'model';
  let saved = true;
  const on = await pickModel({ kind: 'kept', id: -1, name: named }, async () => {
    const file = await picked.arrayBuffer();
    const info = readModel(file);
    const name = info.name || named;
    const keeping = await keepModel(picked, { name, author: info.author, format: formatOf(picked.name) }, info.thumbnail ? await smallThumb(info.thumbnail) : null);
    if ('kept' in keeping) {
      store.set(keptModelsAtom, await listKept());
      void keepForGood();
    } else {
      saved = false;
      console.warn('model not saved:', keeping.failed);
    }
    return { choice: { kind: 'kept', id: 'kept' in keeping ? keeping.kept.id : -1, name }, file };
  });
  if (on && !saved) store.set(modelStatusAtom, UNSAVED_MODEL);
  return { on, saved };
}

export async function forgetKeptModel(id: number): Promise<void> {
  await forgetKept(id);
  store.set(keptModelsAtom, await listKept());
  const kept = validModelChoice(store.get(storedModelAtom));
  if (kept?.kind === 'kept' && kept.id === id) store.set(storedModelAtom, null);
}

export async function backToCamera(): Promise<void> {
  const had = store.get(cameraAtom);
  const session = modelSession;
  if (!session || !had) return;
  const generation = liveGeneration;
  let picture: MediaStream;
  try {
    picture = await navigator.mediaDevices.getUserMedia({ video: CAMERA_VIDEO });
  } catch (err) {
    if (generation === liveGeneration) store.set(sourceStatusAtom, err instanceof DOMException && err.name === 'NotAllowedError' ? 'camera blocked' : 'no camera');
    return;
  }
  if (generation !== liveGeneration || modelSession !== session || store.get(cameraAtom) !== had) {
    picture.getTracks().forEach((track) => track.stop());
    return;
  }
  const track = picture.getVideoTracks()[0]!;
  track.contentHint = 'motion';
  if (cameraSender) await cameraSender.replaceTrack(track).catch(() => undefined);
  store.set(cameraAtom, new MediaStream([...had.getAudioTracks(), track]));
  dropModel();
  store.set(storedModelAtom, null);
  store.set(sourceStatusAtom, '');
  if (!store.get(isPublishingAtom)) setPhase('camera-ready', store.get(hasMicAtom) ? 'camera ready' : 'camera ready, no mic');
  slotsChanged();
}

export function setFaceMirror(mirror: boolean) {
  store.set(storedFaceMirrorAtom, mirror);
  modelSession?.setMirror(mirror);
}

export function setFaceExpressions(on: boolean) {
  store.set(storedFaceExpressionsAtom, on);
  modelSession?.setExpressions(on);
}

export function setModelBackground(colour: string) {
  if (!/^#[0-9a-f]{6}$/i.test(colour)) return;
  store.set(storedModelBackgroundAtom, colour);
  modelSession?.setBackground(colour);
}

export function restFace() {
  modelSession?.rest();
}

export function watchFaceMarks(listener: (marks: FaceMarks) => void): () => void {
  marksListeners.add(listener);
  modelSession?.setMarks(true);
  return () => {
    marksListeners.delete(listener);
    if (marksListeners.size === 0) modelSession?.setMarks(false);
  };
}

export function setRigPicture(on: boolean) {
  store.set(storedRigPictureAtom, on);
}

export async function setFaceCamera(deviceId: string): Promise<void> {
  store.set(storedFaceCameraAtom, deviceId);
  const session = modelSession;
  if (!session) return;
  const was = store.get(faceAtom);
  const next = await openFaceCamera();
  if (modelSession !== session) {
    next?.stop();
    return;
  }
  if (!next) {
    store.set(faceAtom, was);
    store.set(sourceStatusAtom, 'that camera would not open');
    return;
  }
  const old = faceCamera;
  faceCamera = next;
  store.set(readerCameraAtom, new MediaStream([next]));
  session.setCamera(next);
  old?.stop();
  store.set(faceAtom, was === 'on' ? 'on' : 'lost');
  store.set(sourceStatusAtom, '');
  void refreshFaceCameras();
}

export async function goLive(): Promise<void> {
  const camera = store.get(cameraAtom);
  const name = store.get(streamNameAtom);
  if (!camera || !isValidName(name) || pc) return;
  if (store.get(pipAtom)) endWatch();
  store.set(chatRoomAtom, name);

  const mic = camera.getAudioTracks()[0];
  if (!mixer) {
    mixer = openMixer();
    const kept = keptMix(MASTER);
    if (kept) store.set(masterRowAtom, { ...store.get(masterRowAtom), ...kept });
    const master = store.get(masterRowAtom);
    mixer?.setMaster(master.level, master.muted);
    store.set(mixerOpenAtom, mixer !== null);
  }
  if (mixer && mic && !mixer.has('mic')) addMixRow('mic', 'mic', mic);
  watchMixer();
  setPhase('starting', 'starting');

  const myPc = new RTCPeerConnection();
  const myAbort = new AbortController();
  const gone = () => pc !== myPc;
  pc = myPc;
  abort = myAbort;
  addEventListener('pagehide', stopOnLeave);
  myPc.onconnectionstatechange = () => {
    if (!gone()) onConnection(myPc.connectionState);
  };

  const cameraInit: RTCRtpTransceiverInit = { direction: 'sendonly', streams: [camera], sendEncodings: [{ maxBitrate: VIDEO_MAX_BITRATE }] };
  const picture = camera.getVideoTracks()[0];
  if (picture) picture.contentHint = 'motion';
  cameraSender = (picture ? myPc.addTransceiver(picture, cameraInit) : myPc.addTransceiver('video', cameraInit)).sender;
  const sound = mixer?.outputTrack ?? mic;
  if (sound) myPc.addTransceiver(sound, { direction: 'sendonly', streams: [camera] });
  else myPc.addTransceiver('audio', { direction: 'sendonly' });
  screenSenders = Array.from({ length: SCREEN_SLOTS }, (_, i) => {
    const init: RTCRtpTransceiverInit = { direction: 'sendonly', sendEncodings: [{ maxBitrate: SCREENS_BITRATE }] };
    const track = store.get(screenStreamAtom(i))?.getVideoTracks()[0];
    return (track ? myPc.addTransceiver(track, init) : myPc.addTransceiver('video', init)).sender;
  });

  try {
    await myPc.setLocalDescription(await myPc.createOffer());
    await waitForIceGathering(myPc, 1000);
    if (gone()) return;
    const grant = await api.goLive(name);
    const owner: Owner = { name, session: grant.session, token: grant.token };
    if (gone()) {
      api.stop(owner).catch(() => undefined);
      return;
    }
    store.set(ownerAtom, owner);
    ws = await connectRelay({
      role: 'publish',
      name,
      pc: myPc,
      session: owner.session,
      token: owner.token,
      url: grant.url,
      signal: myAbort.signal,
      onMessage: (msg) => {
        if (msg.event === 'viewers') store.set(liveViewersAtom, viewersOf(msg));
      }
    });
  } catch (err) {
    if (gone()) return;
    const taken = statusOf(err) === 409 || messageOf(err) === 'someone is already live';
    stopLive(taken ? 'someone is already live with that name' : `failed: ${messageOf(err)}`, 'failed', { report: !taken && !(err instanceof ApiError) });
    return;
  }

  ws.onclose = () => stopLive('connection lost', 'failed');
  heartbeat = setInterval(sendHeartbeat, HEARTBEAT_MS);
  setPhase('connecting', 'connecting');
  if (gone()) return;
  startPublishStats();
  announceSlots();
  void tuneSenders();
}

function sendHeartbeat() {
  const owner = store.get(ownerAtom);
  if (!owner) return;
  api.heartbeat(owner).catch((err: unknown) => {
    if (store.get(ownerAtom) !== owner) return;
    const status = statusOf(err);
    if (status !== 403 && status !== 404 && status !== 409) return;
    store.set(ownerAtom, null);
    stopLive('session lost. press start again', 'failed');
  });
}

function onConnection(state: RTCPeerConnectionState) {
  if (state === 'connected') setPhase('live', 'live');
  else if (state === 'disconnected') setPhase('reconnecting', 'reconnecting');
  else if (state === 'failed') stopLive('connection failed. udp blocked?', 'failed');
}

async function pickDisplay(): Promise<MediaStream | null> {
  try {
    return await navigator.mediaDevices.getDisplayMedia(SCREEN_HINTS);
  } catch (err) {
    const rejectedHints = err instanceof TypeError || (err instanceof DOMException && err.name === 'OverconstrainedError');
    if (!rejectedHints) return null;
  }
  try {
    return await navigator.mediaDevices.getDisplayMedia({ video: SCREEN_CAP, audio: false });
  } catch {
    return null;
  }
}

let screenPicks = 0;

export async function shareScreen(): Promise<void> {
  if (!store.get(canShareScreenAtom)) return;
  store.set(screenPickingAtom, ++screenPicks > 0);
  try {
    await sharePicked();
  } finally {
    store.set(screenPickingAtom, --screenPicks > 0);
  }
}

async function sharePicked(): Promise<void> {
  const generation = liveGeneration;
  const display = await pickDisplay();
  if (!display) return;
  const track = display.getVideoTracks()[0];
  const slot = screenStreamAtoms.findIndex((streamAtom) => store.get(streamAtom) === null);
  if (generation !== liveGeneration || !track || slot < 0) {
    display.getTracks().forEach((t) => t.stop());
    return;
  }
  track.contentHint = 'detail';
  const sender = screenSenders[slot];
  if (sender) {
    try {
      await sender.replaceTrack(track);
    } catch {
      display.getTracks().forEach((t) => t.stop());
      return;
    }
  }
  track.addEventListener('ended', () => stopScreen(slot));
  const surface = track.getSettings().displaySurface;
  const base = surface === 'window' ? 'window' : surface === 'browser' ? 'tab' : 'screen';
  const alike = store.get(screensAtom).filter((s) => s.label.startsWith(base)).length;
  const label = alike ? `${base} ${alike + 1}` : base;
  store.set(screenStreamAtom(slot), display);
  store.set(screensAtom, [...store.get(screensAtom), { slot, label }]);
  const id = `s${slot + 1}`;
  const source: Source = { id, kind: 'screen', label, slot: slot + 1, box: FULL, shown: true };
  setSources(arrangedAfterAdd([...store.get(sourcesAtom), source], source, store.get(lastArrangementAtom)));
  store.set(selectedSourceAtom, id);
  slotsChanged();
}

export function stopScreen(slot: number) {
  const screens = store.get(screensAtom);
  if (!screens.some((s) => s.slot === slot)) return;
  store
    .get(screenStreamAtom(slot))
    ?.getTracks()
    .forEach((t) => t.stop());
  store.set(screenStreamAtom(slot), null);
  store.set(
    screensAtom,
    screens.filter((s) => s.slot !== slot)
  );
  screenSenders[slot]?.replaceTrack(null).catch(() => undefined);
  dropSource(`s${slot + 1}`);
  slotsChanged();
}

function slotsChanged() {
  announceSlots();
  void tuneSenders();
}

function setSources(next: Source[]) {
  store.set(sourcesAtom, next);
  if (!sceneTimer) {
    sceneTimer = setTimeout(() => {
      sceneTimer = null;
      announceSlots();
      rememberArrangement();
    }, SCENE_SEND_MS);
  }
  if (!tuneTimer) {
    tuneTimer = setTimeout(() => {
      tuneTimer = null;
      void tuneSenders();
    }, TUNE_MS);
  }
}

function dropSource(id: string) {
  const sources = store.get(sourcesAtom);
  if (!sources.some((s) => s.id === id)) return;
  setSources(arrangedAfterRemove(sources.filter((s) => s.id !== id)));
  if (store.get(selectedSourceAtom) === id) store.set(selectedSourceAtom, null);
}

function rememberArrangement() {
  const sources = store.get(sourcesAtom);
  const roles = new Set(sources.filter((s) => s.shown).map((s) => roleOf(s, sources)));
  if (!roles.has('camera') || !roles.has('screen1')) return;
  store.set(storedLastAtom, presetOf('last', sources));
}

export function selectSource(id: string | null) {
  store.set(selectedSourceAtom, id);
}

function withSource(id: string, change: (s: Source) => Source) {
  setSources(store.get(sourcesAtom).map((s) => (s.id === id ? change(s) : s)));
}

export function moveSource(id: string, from: Box, dx: number, dy: number) {
  withSource(id, (s) => ({ ...s, box: movedBox(from, dx, dy) }));
}

export function resizeSource(id: string, from: Box, sx: number, sy: number, dx: number, dy: number, free: boolean) {
  withSource(id, (s) => ({ ...s, box: resizedBox(from, sx, sy, dx, dy, s.ratio ?? (free ? null : from.w / from.h)) }));
}

export function nudgeSource(id: string, dx: number, dy: number) {
  withSource(id, (s) => ({ ...s, box: movedBox(s.box, dx, dy) }));
}

export function toggleSource(id: string) {
  withSource(id, (s) => ({ ...s, shown: !s.shown }));
}

export function reorderSource(id: string, dir: 'up' | 'down') {
  const sources = [...store.get(sourcesAtom)];
  const i = sources.findIndex((s) => s.id === id);
  const j = dir === 'up' ? i + 1 : i - 1;
  if (i < 0 || j < 0 || j >= sources.length) return;
  [sources[i], sources[j]] = [sources[j]!, sources[i]!];
  setSources(sources);
}

export function moveSourceTo(id: string, to: number) {
  const sources = store.get(sourcesAtom);
  const from = sources.findIndex((s) => s.id === id);
  const source = sources[from];
  const at = Math.max(0, Math.min(sources.length - 1, to));
  if (!source || at === from) return;
  const next = sources.filter((s) => s.id !== id);
  next.splice(at, 0, source);
  setSources(next);
}

export function setSourceFit(id: string, fit: Fit) {
  withSource(id, (s) => ({ ...s, fit }));
}

export function fitSourceTo(id: string, targetId: string) {
  const sources = store.get(sourcesAtom).filter((s) => s.id !== id);
  const source = store.get(sourcesAtom).find((s) => s.id === id);
  const at = sources.findIndex((s) => s.id === targetId);
  const target = sources[at];
  if (!source || !target) return;
  sources.splice(at + 1, 0, { ...source, box: { ...target.box }, shown: true });
  setSources(sources);
}

export function removeSource(id: string) {
  const source = store.get(sourcesAtom).find((s) => s.id === id);
  if (!source) return;
  if (source.kind === 'screen' && source.slot !== undefined) stopScreen(source.slot - 1);
  else if (source.kind === 'camera') cameraOff();
  else dropSource(id);
}

export function setLivePanel(name: keyof LivePanels, open: boolean) {
  store.set(storedPanelsAtom, { ...store.get(livePanelsAtom), [name]: open });
}

async function imageRatio(url: string): Promise<number> {
  const img = new Image();
  img.src = url;
  await img.decode();
  return ratioOf(img.naturalWidth, img.naturalHeight);
}

export async function addImage(file: File): Promise<void> {
  const name = store.get(streamNameAtom);
  if (!isValidName(name)) {
    store.set(sourceStatusAtom, 'pick a name first');
    return;
  }
  if (store.get(sourceStatusAtom) === 'uploading') return;
  const picture = file.type === 'image/gif' ? file : await cropPicture(file, SCENE_PICTURE);
  if (!picture || store.get(streamNameAtom) !== name) return;
  store.set(sourceStatusAtom, 'uploading');
  try {
    const saved = await api.saveAsset(name, picture);
    if (store.get(streamNameAtom) !== name) return;
    store.set(libraryAtom, [...store.get(libraryAtom).filter((a) => a.id !== saved.id), { id: saved.id, mime: saved.mime }]);
    store.set(sourceStatusAtom, '');
    await placeImage(saved.id, file.name.replace(/\.[^.]+$/, '') || 'picture');
  } catch (err) {
    if (store.get(streamNameAtom) !== name) return;
    store.set(sourceStatusAtom, `not added: ${messageOf(err)}`);
  }
}

export async function placeImage(asset: number, label: string): Promise<void> {
  const name = store.get(streamNameAtom);
  let ratio: number;
  try {
    ratio = await imageRatio(api.assetUrl(name, asset));
  } catch {
    store.set(sourceStatusAtom, 'that picture does not load');
    return;
  }
  if (store.get(streamNameAtom) !== name) return;
  const id = `i${++imageCount}`;
  setSources([...store.get(sourcesAtom), { id, kind: 'image', label, asset, ratio, box: imageBox(ratio), shown: true }]);
  store.set(selectedSourceAtom, id);
}

export async function deleteImage(asset: number): Promise<void> {
  const name = store.get(streamNameAtom);
  if (!isValidName(name)) return;
  try {
    await api.deleteAsset(name, asset);
  } catch (err) {
    store.set(sourceStatusAtom, `not removed: ${messageOf(err)}`);
    return;
  }
  if (store.get(streamNameAtom) !== name) return;
  store.set(
    libraryAtom,
    store.get(libraryAtom).filter((a) => a.id !== asset)
  );
  for (const s of store.get(sourcesAtom)) if (s.asset === asset) dropSource(s.id);
}

function keptMix(id: string): { level: number; muted: boolean } | null {
  const raw = store.get(storedMixAtom);
  const row = raw && typeof raw === 'object' ? (raw as Record<string, unknown>)[id] : null;
  if (!row || typeof row !== 'object') return null;
  const { level, muted } = row as Record<string, unknown>;
  return typeof level === 'number' && Number.isFinite(level) ? { level: Math.min(1, Math.max(0, level)), muted: muted === true } : null;
}

function rememberMix(row: MixRow) {
  if (row.id !== 'mic' && row.id !== MASTER) return;
  const raw = store.get(storedMixAtom);
  store.set(storedMixAtom, { ...(raw && typeof raw === 'object' ? raw : {}), [row.id]: { level: row.level, muted: row.muted } });
}

function addMixRow(id: string, label: string, track: MediaStreamTrack) {
  if (!mixer) return;
  const kept = keptMix(id);
  const row: MixRow = { id, label, level: kept?.level ?? 1, muted: kept?.muted ?? false };
  mixer.add(id, track, row.level, row.muted);
  store.set(mixRowsAtom, [...store.get(mixRowsAtom).filter((r) => r.id !== id), row]);
}

function setMixRow(id: string, change: (row: MixRow) => MixRow) {
  if (id === MASTER) {
    const row = change(store.get(masterRowAtom));
    store.set(masterRowAtom, row);
    mixer?.setMaster(row.level, row.muted);
    rememberMix(row);
    return;
  }
  const rows = store.get(mixRowsAtom);
  const row = rows.find((r) => r.id === id);
  if (!row) return;
  const next = change(row);
  store.set(
    mixRowsAtom,
    rows.map((r) => (r.id === id ? next : r))
  );
  const source = mixer?.source(id);
  source?.setLevel(next.level);
  source?.setMuted(next.muted);
  rememberMix(next);
}

export function setMixLevel(id: string, level: number) {
  setMixRow(id, (row) => ({ ...row, level: Math.min(1, Math.max(0, level)) }));
}

export function setMixMuted(id: string, muted: boolean) {
  setMixRow(id, (row) => ({ ...row, muted }));
}

export function readMixLevel(id: string, now: number): number {
  if (!mixer) return 0;
  return id === MASTER ? mixer.master.read(now) : (mixer.source(id)?.level.read(now) ?? 0);
}

export function mixClipping(now: number): boolean {
  return mixer?.clipping(now) ?? false;
}

export const micLevelReader = (now: number) => readMixLevel('mic', now);

export async function resumeMixer(): Promise<void> {
  await mixer?.resume().catch(() => undefined);
  store.set(mixerRunningAtom, mixer?.running ?? true);
}

const checkMixer = () => store.set(mixerRunningAtom, mixer?.running ?? true);
let mixerWatched = false;

function watchMixer() {
  checkMixer();
  if (!mixer || mixerWatched) return;
  mixerWatched = true;
  document.addEventListener('visibilitychange', checkMixer);
  setTimeout(checkMixer, 500);
}

function unwatchMixer() {
  if (!mixerWatched) return;
  mixerWatched = false;
  document.removeEventListener('visibilitychange', checkMixer);
}

function announceSlots() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const screens: SlotInfo[] = store.get(screensAtom).map((s) => ({ slot: s.slot + 1, kind: 'screen', label: s.label }));
  const slots: SlotInfo[] = store.get(hasCameraAtom) ? [{ slot: 0, kind: 'camera' }, ...screens] : screens;
  const scene = store.get(sceneAtom);
  record('/ws', 'out', { slots, scene });
  ws.send(JSON.stringify({ slots, scene }));
}

function cameraScale(w: number): number {
  const want = Math.min(4, Math.max(1, 0.667 / Math.max(w, 0.05)));
  return CAMERA_SCALES.filter((s) => s <= want + 1e-6).pop() ?? 1;
}

async function tuneSenders() {
  const sources = store.get(sourcesAtom);
  const screens = store.get(screensAtom);
  const shown = sources.filter((s) => isVideoSource(s) && s.shown);
  const stage = shown.reduce<Source | null>((best, s) => (!best || s.box.w * s.box.h > best.box.w * best.box.h ? s : best), null);
  const camera = sources.find((s) => s.kind === 'camera');
  if (!screens.length || stage?.kind === 'camera') {
    cameraCap = VIDEO_MAX_BITRATE;
    await tune(cameraSender, { maxBitrate: VIDEO_MAX_BITRATE });
  } else {
    const w = camera?.shown ? camera.box.w : 0.5;
    cameraCap = Math.round(Math.min(CAMERA_SHARING_BITRATE, Math.max(CAMERA_MIN_BITRATE, CAMERA_BPS_PER_WIDTH * w)));
    await tune(cameraSender, { maxBitrate: cameraCap, scale: cameraScale(w) });
  }
  const stageScreen = stage?.kind === 'screen' ? stage.slot : screens.length ? screens[0]!.slot + 1 : null;
  for (const [i, sender] of screenSenders.entries()) {
    if (!sender.track) {
      await tune(sender, { maxBitrate: SCREENS_BITRATE });
      continue;
    }
    if (i + 1 === stageScreen) await tune(sender, { maxBitrate: SCREENS_BITRATE - SIDE_SCREEN_BITRATE * (screens.length - 1) }, 'maintain-resolution');
    else await tune(sender, { maxBitrate: SIDE_SCREEN_BITRATE, maxFramerate: SIDE_SCREEN_FPS }, 'maintain-resolution');
  }
}

interface Encoding {
  maxBitrate: number;
  scale?: number;
  maxFramerate?: number;
}

async function tune(sender: RTCRtpSender | null, { maxBitrate, scale = 1, maxFramerate }: Encoding, degradation?: RTCDegradationPreference) {
  if (!sender) return;
  const params = sender.getParameters();
  const encoding = params.encodings?.[0];
  if (!encoding) return;
  encoding.maxBitrate = maxBitrate;
  encoding.scaleResolutionDownBy = scale;
  if (maxFramerate) encoding.maxFramerate = maxFramerate;
  else delete encoding.maxFramerate;
  if (degradation) params.degradationPreference = degradation;
  else delete params.degradationPreference;
  await sender.setParameters(params).catch(() => undefined);
}

export function stopLive(message = 'stopped', phase: PublishPhase = 'stopped', { report = phase === 'failed' }: { report?: boolean } = {}) {
  stopPublishStats();
  if (report) void reportPeerFailure('publish', store.get(streamNameAtom), message, pc);
  removeEventListener('pagehide', stopOnLeave);
  if (heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
  if (sceneTimer) {
    clearTimeout(sceneTimer);
    sceneTimer = null;
  }
  if (tuneTimer) {
    clearTimeout(tuneTimer);
    tuneTimer = null;
  }
  if (abort) {
    abort.abort();
    abort = null;
  }
  if (ws) {
    ws.onclose = null;
    ws.close();
    ws = null;
  }
  if (pc) {
    pc.onconnectionstatechange = null;
    pc.close();
    pc = null;
  }
  for (const streamAtom of screenStreamAtoms) {
    store
      .get(streamAtom)
      ?.getTracks()
      .forEach((track) => track.stop());
    store.set(streamAtom, null);
  }
  store.set(screensAtom, []);
  const sources = store.get(sourcesAtom);
  if (sources.some((s) => s.kind === 'screen')) {
    store.set(sourcesAtom, arrangedAfterRemove(sources.filter((s) => s.kind !== 'screen')));
    if (store.get(selectedSourceAtom)?.startsWith('s')) store.set(selectedSourceAtom, null);
  }
  cameraCap = VIDEO_MAX_BITRATE;
  cameraSender = null;
  screenSenders = [];
  store.set(liveViewersAtom, null);
  const owner = store.get(ownerAtom);
  if (owner) {
    api.stop(owner).catch(() => undefined);
    store.set(ownerAtom, null);
  }
  setPhase(phase, message);
}

export function stopOnLeave(event?: Event) {
  if (event && event.target !== document) return;
  const owner = store.get(ownerAtom);
  if (!owner) return;
  api.stopBeacon(owner);
  store.set(ownerAtom, null);
  stopLive();
}

export function startPublishPip() {
  store.set(publishPipAtom, true);
}

export function leaveLivePage() {
  if (store.get(isPublishingAtom) || pc !== null || store.get(ownerAtom) !== null) {
    store.set(publishPipAtom, true);
    return;
  }
  endLive();
}

export function endLive() {
  store.set(publishPipAtom, false);
  liveGeneration++;
  stopLive();
  dropModel();
  store.set(modelLoadAtom, null);
  store.set(modelStatusAtom, '');
  unwatchMixer();
  mixer?.close();
  mixer = null;
  store.set(mixerOpenAtom, false);
  store.set(mixerRunningAtom, true);
  store.set(mixRowsAtom, []);
  store
    .get(cameraAtom)
    ?.getTracks()
    .forEach((track) => track.stop());
  store.set(cameraAtom, null);
  store.set(sourcesAtom, []);
  store.set(selectedSourceAtom, null);
  store.set(sourceStatusAtom, '');
  setPhase('camera-off', 'camera off');
  profileName = '';
  store.set(streamThumbsAtom, []);
  store.set(thumbStatusAtom, '');
}

export async function loadProfile(): Promise<void> {
  const name = store.get(streamNameAtom);
  if (!isValidName(name)) return;
  if (profileName !== name) {
    if (profileName) {
      store.set(streamThumbsAtom, []);
      store.set(thumbStatusAtom, '');
      store.set(libraryAtom, []);
    }
    profileName = name;
  }
  const generation = liveGeneration;
  try {
    const me = await api.streamer(name);
    if (store.get(streamNameAtom) !== name || generation !== liveGeneration) return;
    store.set(streamThumbsAtom, me.thumbs ?? []);
  } catch {
  }
  try {
    const { assets } = await api.listAssets(name);
    if (store.get(streamNameAtom) !== name || generation !== liveGeneration) return;
    store.set(libraryAtom, assets);
  } catch {
  }
}

export function followIdentityOnLivePage() {
  if (location.pathname.replace(/\/$/, '') !== '/live' || store.get(isPublishingAtom)) return;
  const name = store.get(meAtom) ?? cleanName(store.get(nickAtom));
  if (name === store.get(streamNameAtom)) return;
  setStreamName(name);
  void commitStreamName();
}

export async function addStreamThumb(file: File): Promise<void> {
  const name = store.get(streamNameAtom);
  if (!isValidName(name)) {
    store.set(thumbStatusAtom, 'pick a name first');
    return;
  }
  if (store.get(thumbStatusAtom) === 'saving') return;
  if (store.get(streamThumbsAtom).length >= MAX_THUMBS) {
    store.set(thumbStatusAtom, '6 pictures at most. remove one first');
    return;
  }
  const jpeg = await cropPicture(file, THUMB_PICTURE);
  if (!jpeg || store.get(streamNameAtom) !== name) return;
  store.set(thumbStatusAtom, 'saving');
  try {
    const saved = await api.saveStreamThumb(name, jpeg);
    if (store.get(streamNameAtom) !== name) return;
    store.set(streamThumbsAtom, [...store.get(streamThumbsAtom), saved.id]);
    store.set(thumbStatusAtom, 'saved');
  } catch (err) {
    if (store.get(streamNameAtom) !== name) return;
    store.set(thumbStatusAtom, `not saved: ${messageOf(err)}`);
  }
}

export async function removeStreamThumb(id: number): Promise<void> {
  const name = store.get(streamNameAtom);
  if (!isValidName(name)) return;
  try {
    await api.deleteStreamThumb(name, id);
    if (store.get(streamNameAtom) !== name) return;
    store.set(
      streamThumbsAtom,
      store.get(streamThumbsAtom).filter((thumb) => thumb !== id)
    );
    store.set(thumbStatusAtom, 'removed');
  } catch (err) {
    if (store.get(streamNameAtom) !== name) return;
    store.set(thumbStatusAtom, `not removed: ${messageOf(err)}`);
  }
}

export function copyWatchUrl() {
  const url = store.get(watchUrlAtom);
  if (url) navigator.clipboard?.writeText(url).catch(() => undefined);
}
