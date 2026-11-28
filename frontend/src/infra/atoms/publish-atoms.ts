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
import type { MicProcessing, NativeMic } from '@/infra/desktop/native-audio';
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
import { myAvatarVersionAtom } from '@/infra/atoms/profile-atoms';
import { AVATAR_LOOK, type AvatarLook, lookOf, sameLook, SQUARE } from '@/infra/avatar-look';
import { type Mixer, openMixer } from '@/infra/mixer';
import { faderMaster, faderRows, keepLevel, keptLevel } from '@/infra/mix-levels';
import { startRestream, stopRestream } from '@/infra/restream';
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
import { type Box, connectRelay, type Fit, isVideoLayer, type Scene, SCREEN_SLOTS, type SlotInfo, viewersOf, waitForIceGathering } from '@/infra/relay';
import { sceneSendScheduler } from '@/infra/scene-send';
import { reportPeerFailure } from '@/infra/report';
import { cameraCodec, vp8Only, vp9First } from '@/infra/camera-codec';
import { applyCopy, applyLayers, type Codec, copyEncodings, MAX_FRAMERATE, sendEncodings, SINGLE_BITRATE, SINGLE_HEIGHT, type Top } from '@/infra/simulcast';
import {
  arrangedAfterAdd,
  arrangedAfterRemove,
  arrivedFrom,
  AVATAR_ID,
  FULL,
  imageBox,
  isVideoSource,
  type KeptScene,
  keptOf,
  movedBox,
  presetOf,
  ratioOf,
  readKept,
  resizedBox,
  restoredFrom,
  roleOf,
  sceneOf,
  soloed,
  squaredAvatars,
  type Source,
  type TextPatch,
  textPatched,
  textSource,
  validPreset
} from '@/infra/scene';
import { isSeeThrough, isStoredBacking, NO_BACKING, readModelBacking } from '@/infra/model-backing';
import { fittedModelBox, type ModelFrame, modelFrameOf, movedLoose, resizedLoose, sameFrame, WIDE_FRAME, wideModelBox } from '@/infra/model-frame';
import { clampBox } from '@/infra/box';
import { capOf, type ScreenCap, screenConstraints, stageScreenBitrate } from '@/infra/screen-cap';
import { askAfter, type PickOutcome, type ScreenAsk, type ScreenAsks, withAsk } from '@/infra/screen-ask';
import { readModelChoice, type Stage, type StageGap, stagedFrom, stageOf } from '@/infra/stage';
import { type StreamStats, startSampler } from '@/infra/stream-stats';
import { store } from '@/infra/store';
import { inTauri } from '@/infra/update-check';
import type { Tone } from '@/shared-components/StatusLine';
import { HERE } from '@/infra/here';

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
const CAMERA_SHARING_BITRATE = 500_000;
const SCREENS_BITRATE = 3_000_000;
const BUSY_PHASES: readonly PublishPhase[] = ['starting', 'connecting', 'live', 'reconnecting'];
const BAD_PHASES: readonly PublishPhase[] = ['camera-blocked', 'no-camera', 'mic-blocked', 'no-mic', 'failed'];
const CAMERA_VIDEO: MediaTrackConstraints = { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: MAX_FRAMERATE, max: MAX_FRAMERATE } };
interface DisplayHints extends DisplayMediaStreamOptions {
  selfBrowserSurface?: 'include' | 'exclude';
  surfaceSwitching?: 'include' | 'exclude';
}
const SCREENS_MOST_BITRATE = 6_000_000;
const CAP_SETTLE_MS = 1000;
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
export const screenAsksAtom = atom<ScreenAsks>({});
export const screenMaySeePageAtom = atom((get) => get(screenPickingAtom) || get(screensAtom).length > 0);
const screenStreamAtoms = Array.from({ length: SCREEN_SLOTS }, () => atom<MediaStream | null>(null));
const spareStreamAtom = atom<MediaStream | null>(null);
export const screenStreamAtom = (slot: number) => screenStreamAtoms[slot] ?? spareStreamAtom;
export const sentStreamAtom = (slot: number) => (slot === 0 ? cameraAtom : screenStreamAtom(slot - 1));
export const screenShareSupported = typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function';

export const sourcesAtom = atom<Source[]>([]);
const storedSoloAtom = atomWithStorage<unknown>('settings.liveCameraOnly', null, undefined, { getOnInit: true });
export const cameraOnlyAtom = atom((get) => readKept(get(storedSoloAtom)) !== null);
const stagedSourcesAtom = atom((get) => (get(cameraOnlyAtom) ? soloed(get(sourcesAtom)) : get(sourcesAtom)));
const sentSourcesAtom = atom((get) => get(stagedSourcesAtom).filter((s) => !s.waiting));
export const sceneAtom = atom((get) => sceneOf(get(sentSourcesAtom)));
export const previewSceneAtom = atom((get) => sceneOf(get(stagedSourcesAtom)));
export const stageBlankAtom = atom((get) => get(sourcesAtom).length > 0 && get(previewSceneAtom).layers.length === 0);
export const waitingSourcesAtom = atom((get) => get(sourcesAtom).filter((s) => s.waiting));
export const previewSlotAtom = atom((get) => get(sceneAtom).layers.find(isVideoLayer)?.slot ?? null);
export const previewStreamAtom = atom((get) => {
  const slot = get(previewSlotAtom);
  return slot === null || slot === 0 ? get(cameraAtom) : get(screenStreamAtom(slot - 1));
});
export const selectedSourceAtom = atom<string | null>(null);
export const libraryAtom = atom<{ id: number; mime: string }[]>([]);
export const sourceStatusAtom = atom('');
export const hasAvatarAtom = atom((get) => get(sourcesAtom).some((s) => s.kind === 'avatar'));
export const avatarLookAtom = atom((get) => lookOf(get(sourcesAtom).find((s) => s.kind === 'avatar')?.look));
const storedLastAtom = atomWithStorage<unknown>('settings.lastArrangement', null, undefined, { getOnInit: true });
const lastArrangementAtom = atom((get) => validPreset(get(storedLastAtom)));

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
export const faderRowsAtom = atom((get) => faderRows(get(mixerOpenAtom), get(mixRowsAtom), get(storedMixAtom)));
export const faderMasterAtom = atom((get) => faderMaster(get(mixerOpenAtom), get(masterRowAtom), get(storedMixAtom)));
export const webAudio = typeof AudioContext !== 'undefined';

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
const storedModelAtom = atomWithStorage<unknown>('settings.model', null, undefined, { getOnInit: true });
const storedFaceCameraAtom = atomWithStorage<unknown>('settings.faceCamera', '', undefined, { getOnInit: true });
const storedMicAtom = atomWithStorage<unknown>('settings.mic', '', undefined, { getOnInit: true });
const storedFaceMirrorAtom = atomWithStorage<unknown>('settings.faceMirror', true, undefined, { getOnInit: true });
const storedFaceExpressionsAtom = atomWithStorage<unknown>('settings.faceExpressions', true, undefined, { getOnInit: true });
const storedModelBackgroundAtom = atomWithStorage<unknown>('settings.modelBackground', NO_BACKING, undefined, { getOnInit: true });
const storedRigPictureAtom = atomWithStorage<unknown>('settings.rigPicture', true, undefined, { getOnInit: true });
export const faceCameraAtom = atom((get) => {
  const id = get(storedFaceCameraAtom);
  return typeof id === 'string' ? id : '';
});
const micPickAtom = atom((get) => {
  const id = get(storedMicAtom);
  return typeof id === 'string' ? id : '';
});
export const faceMirrorAtom = atom((get) => get(storedFaceMirrorAtom) !== false);
export const faceExpressionsAtom = atom((get) => get(storedFaceExpressionsAtom) !== false);
export const rigPictureAtom = atom(() => true);
export const modelBackgroundAtom = atom((get) => readModelBacking(get(storedModelBackgroundAtom)));
export const modelSeeThroughAtom = atom((get) => get(modelAtom) !== null && isSeeThrough(get(modelBackgroundAtom)));
const validModelChoice = (raw: unknown): ModelChoice | null => readModelChoice(raw);
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
let dragScene: Scene | null = null;
const sceneSend = sceneSendScheduler(SCENE_SEND_MS, () => {
  const drag = dragScene;
  dragScene = null;
  if (drag) {
    announceSlots(drag);
    return;
  }
  announceSlots();
  rememberArrangement();
});
let tuneTimer: ReturnType<typeof setTimeout> | null = null;
let cameraSender: RTCRtpSender | null = null;
let copySender: RTCRtpSender | null = null;
let sendingCodec: Codec = 'vp8';
let copyUpper = false;
let screenSenders: RTCRtpSender[] = [];
let mixer: Mixer | null = null;
let mixedMic: MediaStreamTrack | null = null;
let modelSession: ModelSession | null = null;
let faceCamera: MediaStreamTrack | null = null;
const marksListeners = new Set<(marks: FaceMarks) => void>();
let modelToken = 0;
let modelFrame: ModelFrame | null = null;

const camOf = (sources: readonly Source[]) => sources.find((s) => s.kind === 'camera');
const isModelSource = (s: Source) => s.kind === 'camera' && modelSession !== null;

function stagedFrame(): ModelFrame {
  const cam = camOf(store.get(stagedSourcesAtom));
  return cam ? modelFrameOf(cam.box) : WIDE_FRAME;
}

function frameModel() {
  if (!modelSession) return;
  const frame = stagedFrame();
  if (modelFrame && sameFrame(modelFrame, frame)) return;
  modelFrame = frame;
  modelSession.setFrame(frame);
}

store.sub(stagedSourcesAtom, frameModel);

function fitModel(aspect: number) {
  const cam = camOf(store.get(sourcesAtom));
  if (cam) withSource(cam.id, (s) => ({ ...s, box: fittedModelBox(s.box, aspect) }));
}
let cameraCap = SINGLE_BITRATE;
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
  watchMicMix();
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
    camera = await openCamera(true);
  } catch (err) {
    if (generation !== liveGeneration) return;
    if (err instanceof DOMException && err.name === 'NotAllowedError') {
      setPhase('camera-blocked', 'camera blocked');
      return;
    }
    try {
      camera = await openCamera(false);
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
    mic = await openMedia(false, true);
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
  void setCameraTrack(null);
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
    picture = await openCamera(false);
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
  void setCameraTrack(track);
  setSources(store.get(sourcesAtom).map((s) => (s.kind === 'avatar' ? { ...s, shown: false } : s)));
  ensureCameraSource();
  store.set(sourceStatusAtom, '');
  if (!store.get(isPublishingAtom)) setPhase('camera-ready', store.get(hasMicAtom) ? 'camera ready' : 'camera ready, no mic');
  slotsChanged();
}

function ensureCameraSource() {
  const sources = store.get(sourcesAtom);
  if (sources.some((s) => s.kind === 'camera' && s.waiting)) {
    setSources(sources.map((s) => (s.kind === 'camera' && s.waiting ? { ...s, waiting: undefined } : s)));
    return;
  }
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

export function addText() {
  const source = textSource('lower third', store.get(sourcesAtom));
  setSources(arrangedAfterAdd([...store.get(sourcesAtom), source], source, null));
  store.set(selectedSourceAtom, source.id);
}

export function setText(id: string, patch: TextPatch) {
  withSource(id, (s) => textPatched(s, patch));
}

export function addAvatar() {
  ensureAvatarSource();
  store.set(selectedSourceAtom, AVATAR_ID);
}

class ModelGone extends Error {}

const faceVideo = (deviceId: string): MediaTrackConstraints => ({
  width: { ideal: 640 },
  height: { ideal: 480 },
  frameRate: { ideal: MAX_FRAMERATE, max: MAX_FRAMERATE },
  ...(deviceId && { deviceId: { exact: deviceId } })
});

const cameraVideo = (deviceId: string): MediaTrackConstraints => ({ ...CAMERA_VIDEO, ...(deviceId && { deviceId: { exact: deviceId } }) });

const deviceGone = (err: unknown) => err instanceof DOMException && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError');

async function openMedia(video: MediaTrackConstraints | false, audio: boolean): Promise<MediaStream> {
  const mic = audio ? store.get(micPickAtom) : '';
  if (mic) {
    try {
      return await navigator.mediaDevices.getUserMedia({ video, audio: { deviceId: { exact: mic } } });
    } catch (err) {
      if (!deviceGone(err)) throw err;
    }
  }
  return navigator.mediaDevices.getUserMedia({ video, audio });
}

async function openCamera(audio: boolean): Promise<MediaStream> {
  const picked = store.get(faceCameraAtom);
  if (picked) {
    try {
      return await openMedia(cameraVideo(picked), audio);
    } catch (err) {
      if (!deviceGone(err)) throw err;
    }
  }
  return openMedia(CAMERA_VIDEO, audio);
}

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

export async function refreshFaceCameras(): Promise<void> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    store.set(
      faceCamerasAtom,
      devices.filter((d) => d.kind === 'videoinput' && d.deviceId).map((d, i) => ({ id: d.deviceId, label: d.label || `camera ${i + 1}` }))
    );
  } catch {}
}

export const micDevicesAtom = atom<{ id: string; label: string }[]>([]);
const nativeMicAtom = atom<{ id: string; track: MediaStreamTrack } | null>(null);
export const nativeMicOnAtom = atom((get) => {
  const native = get(nativeMicAtom);
  return native !== null && get(cameraAtom)?.getAudioTracks()[0] === native.track;
});
export const micDeviceAtom = atom((get) => {
  const track = get(cameraAtom)?.getAudioTracks()[0];
  const native = get(nativeMicAtom);
  return native && track === native.track ? native.id : (track?.getSettings().deviceId ?? '');
});
const storedMicProcessingAtom = atomWithStorage<unknown>('settings.desktopMicProcessing', null, undefined, { getOnInit: true });
export const micProcessingAtom = atom<MicProcessing>((get) => {
  const raw = get(storedMicProcessingAtom);
  const kept = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return { suppress: kept.suppress !== false, gate: kept.gate !== false };
});
let nativeMic: NativeMic | null = null;

const textOf = (err: unknown) => (typeof err === 'string' && err ? err : err instanceof Error && err.message ? err.message : 'it did not start');

export async function refreshMicDevices(): Promise<void> {
  if (inTauri()) return refreshNativeMics();
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    store.set(
      micDevicesAtom,
      devices.filter((d) => d.kind === 'audioinput' && d.deviceId).map((d, i) => ({ id: d.deviceId, label: d.label || `mic ${i + 1}` }))
    );
  } catch {
    store.set(micDevicesAtom, []);
  }
}

async function refreshNativeMics(): Promise<void> {
  try {
    const { listNativeMics } = await import('@/infra/desktop/native-audio');
    const devices = await listNativeMics();
    store.set(
      micDevicesAtom,
      devices.map((d) => ({ id: d.id, label: d.default ? `${d.name} (default)` : d.name }))
    );
  } catch {
    store.set(micDevicesAtom, []);
  }
}

async function setNativeMic(id: string): Promise<void> {
  const had = store.get(cameraAtom);
  if (!had || (store.get(nativeMicOnAtom) && store.get(micDeviceAtom) === id)) return;
  const generation = liveGeneration;
  const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  void ctx.resume().catch(() => undefined);
  let opened: NativeMic;
  try {
    const { openNativeMic } = await import('@/infra/desktop/native-audio');
    opened = await openNativeMic(ctx, id, store.get(micProcessingAtom));
  } catch (err) {
    void ctx.close().catch(() => undefined);
    store.set(sourceStatusAtom, textOf(err));
    return;
  }
  if (generation !== liveGeneration || store.get(cameraAtom) !== had) {
    opened.stop();
    return;
  }
  nativeMic = opened;
  store.set(nativeMicAtom, { id, track: opened.track });
  await swapMicTrack(had, opened.track);
}

export async function setMicProcessing(change: Partial<MicProcessing>): Promise<void> {
  const next = { ...store.get(micProcessingAtom), ...change };
  store.set(storedMicProcessingAtom, next);
  if (!nativeMic) return;
  if (change.gate !== undefined) nativeMic.setGate(next.gate);
  if (change.suppress !== undefined && !(await nativeMic.setSuppress(next.suppress))) store.set(sourceStatusAtom, 'noise suppression did not load');
}

export async function setMicDevice(deviceId: string): Promise<void> {
  if (inTauri()) return setNativeMic(deviceId);
  store.set(storedMicAtom, deviceId);
  const had = store.get(cameraAtom);
  if (!had || had.getAudioTracks()[0]?.getSettings().deviceId === deviceId) return;
  const generation = liveGeneration;
  let fresh: MediaStream;
  try {
    fresh = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId } } });
  } catch {
    store.set(sourceStatusAtom, 'that mic did not open');
    return;
  }
  const track = fresh.getAudioTracks()[0];
  if (!track || generation !== liveGeneration || store.get(cameraAtom) !== had) {
    fresh.getTracks().forEach((t) => t.stop());
    return;
  }
  await swapMicTrack(had, track);
}

async function swapMicTrack(had: MediaStream, track: MediaStreamTrack): Promise<void> {
  had.getAudioTracks().forEach((t) => t.stop());
  store.set(cameraAtom, new MediaStream([track, ...had.getVideoTracks()]));
  store.set(sourceStatusAtom, '');
  if (mixer) {
    syncMicMix();
  } else if (pc) {
    const sender = pc.getSenders().find((s) => s.track?.kind === 'audio');
    await sender?.replaceTrack(track).catch(() => undefined);
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
    if (!file) throw new ModelGone(`that model is not kept in ${HERE} any more. pick the file again`);
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
  const had = modelSession;
  modelSession?.stop();
  modelSession = null;
  modelFrame = null;
  const cam = camOf(store.get(sourcesAtom));
  if (had && cam) withSource(cam.id, (s) => ({ ...s, box: clampBox(wideModelBox(s.box)) }));
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
      frame: stagedFrame(),
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
  session.wireTrack.contentHint = 'motion';
  await setCameraTrack(session.wireTrack);
  void tuneSenders();
  if (stale()) return giveUp();
  const sound = before?.getAudioTracks() ?? opened?.mic?.getAudioTracks() ?? [];
  store.set(cameraAtom, new MediaStream([...sound, session.track]));
  old?.stop();
  modelSession = session;
  modelFrame = null;
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
  fitModel(session.fitAspect);
  frameModel();
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
    const both = await openMedia(faceVideo(store.get(faceCameraAtom)), true);
    return { mic: new MediaStream(both.getAudioTracks()), camera: both.getVideoTracks()[0] ?? null };
  } catch {
    const mic = await openMedia(false, true).catch(() => null);
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
    picture = await openCamera(false);
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
  await setCameraTrack(track);
  void tuneSenders();
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
  if (!isStoredBacking(colour)) return;
  const backing = readModelBacking(colour);
  store.set(storedModelBackgroundAtom, backing);
  modelSession?.setBackground(backing);
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

export const cameraDeviceAtom = atom((get) => {
  const track = (get(modelAtom) ? get(readerCameraAtom) : get(cameraAtom))?.getVideoTracks()[0];
  return track?.getSettings().deviceId || get(faceCameraAtom);
});

export async function setCamera(deviceId: string): Promise<void> {
  if (modelSession) return setFaceCamera(deviceId);
  store.set(storedFaceCameraAtom, deviceId);
  const had = store.get(cameraAtom);
  const old = had?.getVideoTracks()[0];
  if (!had || !old || old.getSettings().deviceId === deviceId) return;
  const generation = liveGeneration;
  let picture: MediaStream;
  try {
    picture = await navigator.mediaDevices.getUserMedia({ video: cameraVideo(deviceId) });
  } catch {
    store.set(sourceStatusAtom, 'that camera would not open');
    return;
  }
  const track = picture.getVideoTracks()[0];
  if (!track || generation !== liveGeneration || store.get(cameraAtom) !== had || modelSession) {
    picture.getTracks().forEach((t) => t.stop());
    return;
  }
  track.contentHint = 'motion';
  await setCameraTrack(track);
  store.set(cameraAtom, new MediaStream([...had.getAudioTracks(), track]));
  old.stop();
  store.set(sourceStatusAtom, '');
  void tuneSenders();
  void refreshFaceCameras();
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
  const codec = await cameraCodec();
  if (pc || store.get(cameraAtom) !== camera) return;
  if (store.get(pipAtom)) endWatch();
  store.set(chatRoomAtom, name);

  const mic = camera.getAudioTracks()[0];
  openLocalMixer();
  void resumeMixer();
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

  const picture = wireOf(camera.getVideoTracks()[0]);
  if (picture) picture.contentHint = 'motion';
  const added = addCamera(myPc, camera, picture, codec);
  cameraSender = added.sender;
  sendingCodec = added.codec;
  const sound = mixer?.outputTrack ?? mic;
  if (sound) myPc.addTransceiver(sound, { direction: 'sendonly', streams: [camera] });
  else myPc.addTransceiver('audio', { direction: 'sendonly' });
  screenSenders = Array.from({ length: SCREEN_SLOTS }, (_, i) => {
    const init: RTCRtpTransceiverInit = { direction: 'sendonly', sendEncodings: [{ maxBitrate: SCREENS_BITRATE, maxFramerate: MAX_FRAMERATE }] };
    const track = store.get(screenStreamAtom(i))?.getVideoTracks()[0];
    return (track ? myPc.addTransceiver(track, init) : myPc.addTransceiver('video', init)).sender;
  });
  copySender = sendingCodec === 'vp9' ? addCopy(myPc, camera, picture) : null;
  if (!copySender) sendingCodec = 'vp8';

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
        if (msg.event === 'copy') {
          copyUpper = msg.full === true;
          void tuneSenders();
        }
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
  settleCodec();
  void tuneSenders();
  const owner = store.get(ownerAtom);
  if (owner) restreamFor(owner, sound ?? null);
}

function restreamFor(owner: Owner, sound: MediaStreamTrack | null) {
  try {
    startRestream({
      name: owner.name,
      owner: { session: owner.session, token: owner.token },
      sound,
      scene: () => store.get(sceneAtom),
      streamFor: (slot) => store.get(sentStreamAtom(slot)),
      imageUrl: (asset) => api.assetUrl(owner.name, asset),
      avatar: () => ({ name: owner.name, version: store.get(myAvatarVersionAtom), look: store.get(avatarLookAtom) }),
      voice: micLevelReader,
      avatarUrl: (name, version) => api.avatarUrl(name, version)
    });
  } catch {
    stopRestream({ quiet: true });
  }
}

function steer(transceiver: RTCRtpTransceiver, order: (codecs: RTCRtpCodec[]) => RTCRtpCodec[]): boolean {
  try {
    const codecs = RTCRtpSender.getCapabilities('video')?.codecs;
    if (!codecs?.length) return false;
    transceiver.setCodecPreferences(order(codecs));
    return true;
  } catch {
    return false;
  }
}

function addCamera(myPc: RTCPeerConnection, camera: MediaStream, picture: MediaStreamTrack | undefined, codec: Codec): { sender: RTCRtpSender; codec: Codec } {
  const add = (encodings: RTCRtpEncodingParameters[]) => {
    const init: RTCRtpTransceiverInit = { direction: 'sendonly', streams: [camera], sendEncodings: encodings };
    return picture ? myPc.addTransceiver(picture, init) : myPc.addTransceiver('video', init);
  };
  const height = picture?.getSettings().height;
  for (const tried of codec === 'vp9' ? (['vp9', 'vp8'] as const) : (['vp8'] as const)) {
    try {
      const transceiver = add(sendEncodings(height, tried));
      return { sender: transceiver.sender, codec: tried === 'vp9' && steer(transceiver, vp9First) ? 'vp9' : 'vp8' };
    } catch {
      continue;
    }
  }
  return { sender: add([{ maxBitrate: SINGLE_BITRATE, maxFramerate: MAX_FRAMERATE }]).sender, codec: 'vp8' };
}

function addCopy(myPc: RTCPeerConnection, camera: MediaStream, picture: MediaStreamTrack | undefined): RTCRtpSender | null {
  let transceiver: RTCRtpTransceiver;
  try {
    const init: RTCRtpTransceiverInit = { direction: 'sendonly', streams: [camera], sendEncodings: copyEncodings(picture?.getSettings().height) };
    transceiver = picture ? myPc.addTransceiver(picture, init) : myPc.addTransceiver('video', init);
  } catch {
    return null;
  }
  if (steer(transceiver, vp8Only)) return transceiver.sender;
  transceiver.direction = 'inactive';
  return null;
}

function answeredCodec(sender: RTCRtpSender | null): Codec | null {
  const mime = sender?.getParameters().codecs?.[0]?.mimeType.toLowerCase();
  return mime === 'video/vp9' ? 'vp9' : mime === 'video/vp8' ? 'vp8' : null;
}

function settleCodec() {
  if (sendingCodec !== 'vp9' || answeredCodec(cameraSender) === 'vp9') return;
  sendingCodec = 'vp8';
  const copy = copySender;
  copySender = null;
  if (!copy) return;
  const params = copy.getParameters();
  for (const encoding of params.encodings ?? []) encoding.active = false;
  copy.setParameters(params).catch(() => undefined);
}

function wireOf(track: MediaStreamTrack | undefined): MediaStreamTrack | undefined {
  return modelSession && track === modelSession.track ? modelSession.wireTrack : track;
}

async function setCameraTrack(track: MediaStreamTrack | null): Promise<void> {
  await Promise.all([cameraSender, copySender].map((sender) => sender?.replaceTrack(track).catch(() => undefined)));
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
  else if (state === 'failed') stopLive('connection failed', 'failed');
}

const nativeSurfaces = new WeakMap<MediaStreamTrack, string>();
const nativeResizers = new WeakMap<MediaStreamTrack, (cap: ScreenCap) => Promise<void>>();
const appliedCaps = new WeakMap<MediaStreamTrack, ScreenCap>();

async function pickNativeDisplay(cap: ScreenCap): Promise<MediaStream | null | string> {
  try {
    const { pickNativeScreen } = await import('@/infra/desktop/native-screen');
    const picked = await pickNativeScreen(cap);
    if (!picked) return null;
    const track = picked.stream.getVideoTracks()[0];
    if (track) {
      nativeSurfaces.set(track, picked.surface);
      nativeResizers.set(track, picked.resize);
    }
    return picked.stream;
  } catch (err) {
    if (err instanceof Error && err.name === 'ListFailed') return err.message;
    store.set(sourceStatusAtom, textOf(err));
    return null;
  }
}

async function pickDisplay(cap: ScreenCap): Promise<MediaStream | null> {
  if (!inTauri() || !navigator.userAgent.includes('Mac')) return pickBrowserDisplay(cap);
  const native = await pickNativeDisplay(cap);
  if (typeof native !== 'string') return native;
  const display = await pickBrowserDisplay(cap);
  if (!display) store.set(sourceStatusAtom, native);
  return display;
}

async function pickBrowserDisplay(cap: ScreenCap): Promise<MediaStream | null> {
  const video = screenConstraints(cap);
  const hints: DisplayHints = { video, audio: false, selfBrowserSurface: 'exclude', surfaceSwitching: 'include' };
  try {
    return await navigator.mediaDevices.getDisplayMedia(hints);
  } catch (err) {
    const rejectedHints = err instanceof TypeError || (err instanceof DOMException && err.name === 'OverconstrainedError');
    if (!rejectedHints) return null;
  }
  try {
    return await navigator.mediaDevices.getDisplayMedia({ video, audio: false });
  } catch {
    return null;
  }
}

async function capScreen(track: MediaStreamTrack, cap: ScreenCap) {
  if (appliedCaps.get(track) === cap) return;
  appliedCaps.set(track, cap);
  const resize = nativeResizers.get(track);
  try {
    if (resize) await resize(cap);
    else await track.applyConstraints(screenConstraints(cap));
  } catch {
    appliedCaps.delete(track);
  }
  if (track.readyState !== 'live') return;
  setTimeout(() => void tuneSenders(), CAP_SETTLE_MS);
}

function capScreens() {
  for (const source of store.get(sourcesAtom)) {
    if (source.kind !== 'screen' || !source.slot || source.waiting) continue;
    const track = store.get(screenStreamAtom(source.slot - 1))?.getVideoTracks()[0];
    if (track && track.readyState === 'live') void capScreen(track, capOf(source.cap));
  }
}

store.sub(sourcesAtom, capScreens);

export function setScreenCap(id: string, cap: ScreenCap) {
  withSource(id, (s) => (s.kind === 'screen' ? { ...s, cap } : s));
}

let screenPicks = 0;
const screenTurns: number[] = [];

function setScreenAsk(slot: number, ask: ScreenAsk | null) {
  store.set(screenAsksAtom, withAsk(store.get(screenAsksAtom), slot, ask));
}

export function cancelScreenPick(slot: number) {
  screenTurns[slot] = (screenTurns[slot] ?? 0) + 1;
  setScreenAsk(slot, null);
}

export async function shareScreen(into?: number): Promise<void> {
  if (!store.get(canShareScreenAtom)) return;
  const turn = into === undefined ? 0 : (screenTurns[into] = (screenTurns[into] ?? 0) + 1);
  const current = () => into === undefined || screenTurns[into] === turn;
  if (into !== undefined) setScreenAsk(into, 'picking');
  store.set(screenPickingAtom, ++screenPicks > 0);
  let outcome: PickOutcome = 'none';
  try {
    outcome = await sharePicked(into, current);
  } finally {
    if (into !== undefined && current()) setScreenAsk(into, askAfter(outcome));
    store.set(screenPickingAtom, --screenPicks > 0);
  }
}

async function sharePicked(into: number | undefined, current: () => boolean): Promise<PickOutcome> {
  const generation = liveGeneration;
  const asked = into === undefined ? undefined : store.get(sourcesAtom).find((s) => s.id === `s${into + 1}`)?.cap;
  const cap = capOf(asked);
  const display = await pickDisplay(cap);
  if (!display) return 'none';
  const track = display.getVideoTracks()[0];
  const free = (i: number) => i >= 0 && i < screenStreamAtoms.length && store.get(screenStreamAtoms[i]!) === null;
  const slot = into !== undefined && free(into) ? into : screenStreamAtoms.findIndex((streamAtom) => store.get(streamAtom) === null);
  if (!current() || generation !== liveGeneration || !track || slot < 0) {
    display.getTracks().forEach((t) => t.stop());
    return 'dropped';
  }
  track.contentHint = 'detail';
  appliedCaps.set(track, cap);
  const sender = screenSenders[slot];
  if (sender) {
    try {
      await sender.replaceTrack(track);
    } catch {
      display.getTracks().forEach((t) => t.stop());
      return 'dropped';
    }
  }
  track.addEventListener('ended', () => stopScreen(slot));
  const surface = nativeSurfaces.get(track) ?? track.getSettings().displaySurface;
  const base = surface === 'window' ? 'window' : surface === 'browser' ? 'tab' : 'screen';
  const alike = store.get(screensAtom).filter((s) => s.label.startsWith(base)).length;
  const label = alike ? `${base} ${alike + 1}` : base;
  store.set(screenStreamAtom(slot), display);
  store.set(screensAtom, [...store.get(screensAtom), { slot, label }]);
  const id = `s${slot + 1}`;
  const sources = store.get(sourcesAtom);
  if (sources.some((s) => s.id === id && s.waiting)) setSources(sources.map((s) => (s.id === id ? { ...s, label, slot: slot + 1, waiting: undefined } : s)));
  else {
    const source: Source = { id, kind: 'screen', label, slot: slot + 1, box: FULL, shown: true };
    setSources(arrangedAfterAdd([...sources, source], source, store.get(lastArrangementAtom)));
  }
  store.set(selectedSourceAtom, id);
  setScreenAsk(slot, null);
  slotsChanged();
  return 'shared';
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
  const arriving = arrivals?.();
  if (arriving) next = arrivedFrom(arriving, store.get(sourcesAtom), next);
  const kept = readKept(store.get(storedSoloAtom));
  if (kept) {
    next = squaredAvatars(restoredFrom(kept, store.get(sourcesAtom), next));
    store.set(storedSoloAtom, { ...kept, ...keptOf(next) });
  } else next = squaredAvatars(next);
  store.set(sourcesAtom, next);
  dragScene = null;
  sceneSend.schedule();
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

export function setCameraOnly(on: boolean) {
  const kept = readKept(store.get(storedSoloAtom));
  if (on === (kept !== null)) return;
  store.set(selectedSourceAtom, null);
  if (on) store.set(storedSoloAtom, keptOf(store.get(sourcesAtom)));
  else {
    store.set(storedSoloAtom, null);
    const sources = store.get(sourcesAtom);
    if (Object.keys(kept!).some((id) => !sources.some((s) => s.id === id))) setSources(arrangedAfterRemove(sources));
  }
  slotsChanged();
}

export function selectSource(id: string | null) {
  store.set(selectedSourceAtom, id);
}

function withSource(id: string, change: (s: Source) => Source) {
  setSources(store.get(sourcesAtom).map((s) => (s.id === id ? change(s) : s)));
}

export function moveSource(id: string, from: Box, dx: number, dy: number) {
  withSource(id, (s) => ({ ...s, box: isModelSource(s) ? movedLoose(from, dx, dy) : movedBox(from, dx, dy) }));
}

export function previewMoveSource(_id: string, from: Box, dx: number, dy: number): Box {
  return movedBox(from, dx, dy);
}

export function streamSourceBox(id: string, box: Box) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  dragScene = sceneOf(store.get(sentSourcesAtom).map((s) => (s.id === id ? { ...s, box } : s)));
  sceneSend.schedule();
}

function resizeRatio(id: string, from: Box, free: boolean): number | null {
  const s = store.get(sourcesAtom).find((x) => x.id === id);
  if (s?.kind === 'avatar') return SQUARE;
  if (s?.kind === 'text') return null;
  return s?.ratio ?? (free ? null : from.w / from.h);
}

export function resizeSource(id: string, from: Box, sx: number, sy: number, dx: number, dy: number, free: boolean) {
  withSource(id, (s) => {
    if (!isModelSource(s)) return { ...s, box: resizedBox(from, sx, sy, dx, dy, resizeRatio(id, from, free)) };
    return { ...s, box: resizedLoose(from, sx, sy, dx, dy, from.w / from.h) };
  });
}

export function previewResizeSource(id: string, from: Box, sx: number, sy: number, dx: number, dy: number, free: boolean): Box {
  return resizedBox(from, sx, sy, dx, dy, resizeRatio(id, from, free));
}

export function nudgeSource(id: string, dx: number, dy: number) {
  withSource(id, (s) => ({ ...s, box: isModelSource(s) ? movedLoose(s.box, dx, dy) : movedBox(s.box, dx, dy) }));
}

export function setAvatarLook(id: string, patch: Partial<AvatarLook>) {
  withSource(id, (s) => {
    if (s.kind !== 'avatar') return s;
    const look = { ...lookOf(s.look), ...patch };
    return sameLook(look, AVATAR_LOOK) ? { ...s, look: undefined } : { ...s, look };
  });
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

export function wakeSource(id: string) {
  const source = store.get(sourcesAtom).find((s) => s.id === id && s.waiting);
  if (source?.kind === 'camera') void cameraOn();
  else if (source?.kind === 'screen') void shareScreen((source.slot ?? 1) - 1);
}

export function removeSource(id: string) {
  const source = store.get(sourcesAtom).find((s) => s.id === id);
  if (!source) return;
  if (source.waiting) {
    if (source.kind === 'screen' && source.slot !== undefined) cancelScreenPick(source.slot - 1);
    dropSource(id);
  } else if (source.kind === 'screen' && source.slot !== undefined) stopScreen(source.slot - 1);
  else if (source.kind === 'camera') cameraOff();
  else dropSource(id);
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
  return keptLevel(store.get(storedMixAtom), id);
}

function rememberMix(row: MixRow) {
  if (row.id !== 'mic' && row.id !== MASTER) return;
  store.set(storedMixAtom, keepLevel(store.get(storedMixAtom), row.id, row));
}

function openLocalMixer() {
  if (!mixer) {
    mixer = openMixer();
    const kept = keptMix(MASTER);
    if (kept) store.set(masterRowAtom, { ...store.get(masterRowAtom), ...kept });
    const master = store.get(masterRowAtom);
    mixer?.setMaster(master.level, master.muted);
    store.set(mixerOpenAtom, mixer !== null);
  }
  syncMicMix();
  watchMixer();
}

function syncMicMix() {
  if (!mixer) return;
  const mic = store.get(cameraAtom)?.getAudioTracks()[0] ?? null;
  if (mic === mixedMic && (!mic || mixer.has('mic'))) return;
  mixedMic = mic;
  if (!mic) {
    unmixSound('mic');
    return;
  }
  const row = store.get(mixRowsAtom).find((r) => r.id === 'mic');
  if (row) mixer.add('mic', mic, row.level, row.muted);
  else addMixRow('mic', 'mic', mic);
}

let micMixWatched = false;

function watchMicMix() {
  if (micMixWatched) return;
  micMixWatched = true;
  const sync = () => {
    if (mixer) syncMicMix();
    else if (store.get(hasMicAtom)) openLocalMixer();
  };
  store.sub(cameraAtom, sync);
  sync();
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
  if (!row) {
    rememberMix(change({ id, label: id, level: 1, muted: false, ...keptMix(id) }));
    return;
  }
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

export function mixSound(id: string, label: string, track: MediaStreamTrack) {
  addMixRow(id, label, track);
}

export function unmixSound(id: string) {
  mixer?.remove(id);
  store.set(
    mixRowsAtom,
    store.get(mixRowsAtom).filter((r) => r.id !== id)
  );
}

export function relabelMix(id: string, label: string) {
  store.set(
    mixRowsAtom,
    store.get(mixRowsAtom).map((r) => (r.id === id ? { ...r, label } : r))
  );
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

const wakeMixer = () => {
  if (mixer && !mixer.running) void resumeMixer();
};

function watchMixer() {
  checkMixer();
  if (!mixer || mixerWatched) return;
  mixerWatched = true;
  document.addEventListener('visibilitychange', checkMixer);
  document.addEventListener('pointerdown', wakeMixer, true);
  document.addEventListener('keydown', wakeMixer, true);
  setTimeout(checkMixer, 500);
}

function unwatchMixer() {
  if (!mixerWatched) return;
  mixerWatched = false;
  document.removeEventListener('visibilitychange', checkMixer);
  document.removeEventListener('pointerdown', wakeMixer, true);
  document.removeEventListener('keydown', wakeMixer, true);
}

function announceSlots(scene: Scene = store.get(sceneAtom)) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const screens: SlotInfo[] = store.get(screensAtom).map((s) => ({ slot: s.slot + 1, kind: 'screen', label: s.label }));
  const slots: SlotInfo[] = store.get(hasCameraAtom) ? [{ slot: 0, kind: 'camera' }, ...screens] : screens;
  record('/ws', 'out', { slots, scene });
  ws.send(JSON.stringify({ slots, scene }));
}

function cameraScale(w: number): number {
  const want = Math.min(4, Math.max(1, 0.667 / Math.max(w, 0.05)));
  return CAMERA_SCALES.filter((s) => s <= want + 1e-6).pop() ?? 1;
}

async function tuneSenders() {
  const sources = store.get(sentSourcesAtom);
  const screens = store.get(screensAtom);
  const shown = sources.filter((s) => isVideoSource(s) && s.shown);
  const stage = shown.reduce<Source | null>((best, s) => (!best || s.box.w * s.box.h >= best.box.w * best.box.h ? s : best), null);
  const camera = sources.find((s) => s.kind === 'camera');
  const height = cameraSender?.track?.getSettings().height;
  let top: Top | undefined;
  if (screens.length && stage?.kind !== 'camera') {
    const w = camera?.shown ? camera.box.w : 0.5;
    const cap = Math.round(Math.min(CAMERA_SHARING_BITRATE, Math.max(CAMERA_MIN_BITRATE, CAMERA_BPS_PER_WIDTH * w)));
    top = { height: Math.min(height || SINGLE_HEIGHT, SINGLE_HEIGHT) / cameraScale(w), maxBitrate: cap };
  }
  const main = await tuneCamera(cameraSender, height, top);
  cameraCap = main + (await tuneCopy(copySender, height, top));
  const stageScreen = stage?.kind === 'screen' ? stage.slot : screens.length ? screens[0]!.slot + 1 : null;
  for (const [i, sender] of screenSenders.entries()) {
    if (!sender.track) {
      await tune(sender, { maxBitrate: SCREENS_BITRATE });
      continue;
    }
    const { width, height } = sender.track.getSettings();
    const budget = stageScreenBitrate(SCREENS_BITRATE, width, height, SCREENS_MOST_BITRATE);
    if (i + 1 === stageScreen) await tune(sender, { maxBitrate: budget - SIDE_SCREEN_BITRATE * (screens.length - 1) }, 'maintain-resolution');
    else await tune(sender, { maxBitrate: SIDE_SCREEN_BITRATE, maxFramerate: SIDE_SCREEN_FPS }, 'maintain-resolution');
  }
}

async function tuneCamera(sender: RTCRtpSender | null, height: number | undefined, top?: Top): Promise<number> {
  if (!sender) return cameraCap;
  const params = sender.getParameters();
  if (!params.encodings?.length) return cameraCap;
  const total = applyLayers(params.encodings, height, top, sendingCodec);
  delete params.degradationPreference;
  await sender.setParameters(params).catch(() => undefined);
  return total;
}

async function tuneCopy(sender: RTCRtpSender | null, height: number | undefined, top?: Top): Promise<number> {
  if (!sender) return 0;
  const params = sender.getParameters();
  if (!params.encodings?.length) return 0;
  const total = applyCopy(params.encodings, height, top, copyUpper);
  delete params.degradationPreference;
  await sender.setParameters(params).catch(() => undefined);
  return total;
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
  encoding.maxFramerate = Math.min(maxFramerate ?? MAX_FRAMERATE, MAX_FRAMERATE);
  if (degradation) params.degradationPreference = degradation;
  else delete params.degradationPreference;
  await sender.setParameters(params).catch(() => undefined);
}

export function stopLive(message = 'stopped', phase: PublishPhase = 'stopped', { report = phase === 'failed' }: { report?: boolean } = {}) {
  stopPublishStats();
  stopRestream();
  if (report) void reportPeerFailure('publish', store.get(streamNameAtom), message, pc);
  removeEventListener('pagehide', stopOnLeave);
  if (heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
  sceneSend.cancel();
  dragScene = null;
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
  cameraCap = SINGLE_BITRATE;
  cameraSender = null;
  copySender = null;
  sendingCodec = 'vp8';
  copyUpper = false;
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
  mixedMic = null;
  store.set(mixerOpenAtom, false);
  store.set(mixerRunningAtom, true);
  store.set(mixRowsAtom, []);
  store
    .get(cameraAtom)
    ?.getTracks()
    .forEach((track) => track.stop());
  store.set(cameraAtom, null);
  nativeMic = null;
  store.set(nativeMicAtom, null);
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
  } catch {}
  try {
    const { assets } = await api.listAssets(name);
    if (store.get(streamNameAtom) !== name || generation !== liveGeneration) return;
    store.set(libraryAtom, assets);
  } catch {}
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

const KEPT_LEVELS = ['mic', MASTER] as const;

function levelsNow(): Stage['levels'] {
  const levels: Stage['levels'] = {};
  for (const id of KEPT_LEVELS) {
    const kept = keptMix(id);
    if (kept) levels[id] = kept;
  }
  if (mixer) {
    const master = store.get(masterRowAtom);
    levels[MASTER] = { level: master.level, muted: master.muted };
    for (const row of store.get(mixRowsAtom)) levels[row.id] = { level: row.level, muted: row.muted };
  }
  return levels;
}

export function sceneStageNow(): Stage {
  return stageOf(store.get(sourcesAtom), {
    levels: levelsNow(),
    sounds: {},
    names: {},
    camera: store.get(cameraDeviceAtom),
    mic: store.get(micDeviceAtom) || store.get(micPickAtom),
    mirror: store.get(faceMirrorAtom),
    expressions: store.get(faceExpressionsAtom),
    background: store.get(modelBackgroundAtom),
    model: validModelChoice(store.get(storedModelAtom)),
    solo: store.get(cameraOnlyAtom)
  });
}

async function hasDevice(kind: MediaDeviceKind, deviceId: string): Promise<boolean> {
  try {
    return (await navigator.mediaDevices.enumerateDevices()).some((d) => d.kind === kind && d.deviceId === deviceId);
  } catch {
    return false;
  }
}

async function cameraAllowed(): Promise<boolean> {
  try {
    return (await navigator.permissions.query({ name: 'camera' as PermissionName })).state === 'granted';
  } catch {
    return false;
  }
}

function sameModel(a: ModelChoice | null, b: ModelChoice | null): boolean {
  return a === null || b === null ? a === b : a.kind === b.kind && a.id === b.id;
}

async function stageModel(want: ModelChoice | null, gaps: StageGap[]): Promise<void> {
  const worn = modelSession ? validModelChoice(store.get(storedModelAtom)) : null;
  if (sameModel(want, worn)) return;
  if (!want) {
    await backToCamera();
    return;
  }
  if (!store.get(hasCameraAtom) && !modelSession) return;
  if (!store.get(demoModelsAtom).length && !store.get(keptModelsAtom).length) await loadModelLibrary();
  const kept = want.kind === 'kept' ? store.get(keptModelsAtom).find((m) => m.id === want.id) : undefined;
  const demo = want.kind === 'demo' ? store.get(demoModelsAtom).find((m) => m.id === want.id) : undefined;
  const on = kept ? await pickKeptModel(kept) : demo ? await pickDemoModel(demo) : false;
  if (!on) gaps.push({ kind: 'model', name: want.name });
}

async function tried(work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch {
    return;
  }
}

function stageScene(stage: Stage, gaps: StageGap[]) {
  if (!stage.solo) setCameraOnly(false);
  const library = store.get(libraryAtom).map((a) => a.id);
  const staged = stagedFrom(stage, store.get(sourcesAtom), library, () => `i${++imageCount}`);
  gaps.push(...staged.gaps);
  store.set(selectedSourceAtom, null);
  setSources(staged.sources);
  if (stage.solo) setCameraOnly(true);
  slotsChanged();
}

function stageLevels(stage: Stage) {
  for (const [id, row] of Object.entries(stage.levels)) {
    const live = id === MASTER || store.get(mixRowsAtom).some((r) => r.id === id);
    if (live) setMixRow(id, (r) => ({ ...r, level: row.level, muted: row.muted }));
    else if ((KEPT_LEVELS as readonly string[]).includes(id)) {
      const raw = store.get(storedMixAtom);
      store.set(storedMixAtom, { ...(raw && typeof raw === 'object' ? raw : {}), [id]: row });
    }
  }
}

export async function applySceneStage(stage: Stage): Promise<StageGap[]> {
  const gaps: StageGap[] = [];
  const generation = liveGeneration;
  const wantCamera = stage.scene.cam?.shown === true;
  if (wantCamera && !store.get(hasCameraAtom)) {
    if (await cameraAllowed()) await tried(cameraOn);
  }
  if (generation !== liveGeneration) return gaps;
  if (stage.scene[AVATAR_ID]?.shown && !store.get(sourcesAtom).some((s) => s.kind === 'avatar')) ensureAvatarSource();
  stageScene(stage, gaps);
  stageLevels(stage);
  setFaceMirror(stage.mirror);
  setFaceExpressions(stage.expressions);
  if (stage.background) setModelBackground(stage.background);
  if (stage.camera && stage.camera !== store.get(cameraDeviceAtom)) {
    if (await hasDevice('videoinput', stage.camera)) await tried(() => setCamera(stage.camera));
    else if (wantCamera) gaps.push({ kind: 'device', what: 'camera' });
  }
  const micNow = store.get(micDeviceAtom) || store.get(micPickAtom);
  if (stage.mic && stage.mic !== micNow && store.get(hasMicAtom)) {
    if (inTauri() || (await hasDevice('audioinput', stage.mic))) await tried(() => setMicDevice(stage.mic));
    else gaps.push({ kind: 'device', what: 'mic' });
  }
  if (generation !== liveGeneration) return gaps;
  const worn = modelSession ? validModelChoice(store.get(storedModelAtom)) : null;
  if (!sameModel(stage.model, worn)) {
    await tried(() => stageModel(stage.model, gaps));
    if (generation === liveGeneration) stageScene(stage, []);
  }
  if (modelSession && generation === liveGeneration) fitModel(modelSession.fitAspect);
  return gaps;
}

let arrivals: (() => KeptScene | null) | null = null;

export function placeArrivalsFrom(read: (() => KeptScene | null) | null) {
  arrivals = read;
}
