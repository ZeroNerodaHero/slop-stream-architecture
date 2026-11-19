/**
 * Going live from the browser camera. State lives in atoms; the peer connection, socket and
 * timers are plain module handles because nothing renders from them. Every state change goes
 * through an action function here, so cause and effect sit in one place (no reactive effects).
 */

import { atom } from 'jotai';
import { atomWithStorage } from 'jotai/utils';

import { ApiError, api, type DemoModel, type Owner, messageOf, statusOf } from '@/infra/api';
import { loadMe, meAtom } from '@/infra/atoms/auth-atoms';
import { nickAtom } from '@/infra/atoms/chat-atoms';
import { cropPicture } from '@/infra/atoms/crop-atoms';
import { record } from '@/infra/atoms/inspector-atoms';
import { endWatch, pipAtom } from '@/infra/atoms/watch-atoms';
import { type FaceLines, type FaceMarks, type FaceState, type LoadStep, type ModelSession, type ModelStats, type RigInfo, startModel } from '@/infra/face';
import { type Mixer, openMixer } from '@/infra/mixer';
import { readModel } from '@/infra/model-file';
import { forgetKept, keepDemo, keepForGood, keepModel, type KeptModel, keptDemoFile, keptFile, listKept, listKeptDemos, pruneKeptDemos } from '@/infra/model-store';
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

/** `mic-ready`, `mic-blocked` and `no-mic` are the mic-only start's (docs/screen.md): the mic alone, with the avatar for a face. */
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
/** The camera while a screen is shared too: the screen is what people look at. */
const CAMERA_SHARING_BITRATE = 500_000;
/** All the shared screens together. One alone gets it all, three get a third each. */
const SCREENS_BITRATE = 3_000_000;
const BUSY_PHASES: readonly PublishPhase[] = ['starting', 'connecting', 'live', 'reconnecting'];
const BAD_PHASES: readonly PublishPhase[] = ['camera-blocked', 'no-camera', 'mic-blocked', 'no-mic', 'failed'];
/** The camera's picture: 720p, the size the home card and the watchers get (docs/bitrates.md). */
const CAMERA_VIDEO: MediaTrackConstraints = { width: { ideal: 1280 }, height: { ideal: 720 } };
/**
 * A shared screen is at most this big: a retina display would hand over a picture too big for
 * the bitrate, and the bits go on pixels the cap cannot afford (docs/bitrates.md).
 */
const SCREEN_CAP: MediaTrackConstraints = { width: { max: 1920 }, height: { max: 1080 }, frameRate: { max: 30 } };
/** `DisplayMediaStreamOptions` with the picker hints the typings do not have yet. */
interface DisplayHints extends DisplayMediaStreamOptions {
  selfBrowserSurface?: 'include' | 'exclude';
  surfaceSwitching?: 'include' | 'exclude';
}
/**
 * The picker for a screen or a window: this site's own tab kept out of it (sharing it is a
 * mirror), switching which tab is shared without stopping. Hints: a browser that throws on
 * them is asked again with `SCREEN_CAP` alone. No sound (docs/audio.md).
 */
const SCREEN_HINTS: DisplayHints = { video: SCREEN_CAP, audio: false, selfBrowserSurface: 'exclude', surfaceSwitching: 'include' };
/** A drag moves a layer many times a second; the watchers are told at most this often, and within this long of the last move. */
const SCENE_SEND_MS = 150;
/** The encoders follow the scene (a small camera is sent small) this long after it settles: a new size costs a keyframe. */
const TUNE_MS = 500;
/** A screen that is not the stage: this many bits, at this many frames (text stays readable, a video in it stutters). */
const SIDE_SCREEN_BITRATE = 500_000;
const SIDE_SCREEN_FPS = 15;
/** The camera's bits over a screen: this much per unit of width, between these. */
const CAMERA_BPS_PER_WIDTH = 1_200_000;
const CAMERA_MIN_BITRATE = 150_000;
/** The camera's encode is shrunk to fit its box: the picture is 1280 wide, a watcher's frame at most 1920. Steps, so a drag does not cost a keyframe per pixel. */
const CAMERA_SCALES = [1, 1.33, 2, 2.67, 4];

/**
 * What `getUserMedia` gave: the camera and the mic, the camera alone (no mic), or the mic
 * alone (mic only, docs/screen.md). Replaced whole whenever a track comes or goes (the camera
 * turned off, or on again), so everything reading it follows; the mic track itself stays the
 * same object through that, so the mixer and the meters never rebind.
 */
export const cameraAtom = atom<MediaStream | null>(null);
/** The camera is on: its stream has a picture. Off (mic only), the stream is the mic alone. */
export const hasCameraAtom = atom((get) => (get(cameraAtom)?.getVideoTracks().length ?? 0) > 0);
/** There is a mic. Without one the camera cannot be turned off: nothing would be left to stream. */
export const hasMicAtom = atom((get) => (get(cameraAtom)?.getAudioTracks().length ?? 0) > 0);
/**
 * Mic only, kept: the next visit opens the mic alone and never asks for the camera (someone
 * who streams with their avatar should not have the camera's light come on every time).
 * Set by the camera's × (off) and the +'s `camera` (on).
 */
const storedMicOnlyAtom = atomWithStorage<unknown>('settings.micOnly', false, undefined, { getOnInit: true });
export const micOnlyAtom = atom((get) => get(storedMicOnlyAtom) === true);
/** A screen being shared: which screen slot (0 to SCREEN_SLOTS-1) and what the browser called it. Its stream is in `screenStreamAtoms`. */
export interface SharedScreen {
  slot: number;
  label: string;
}
export const screensAtom = atom<SharedScreen[]>([]);
/** The browser's picker for a screen is up, or its pick is on its way into a slot (`shareScreen`). */
const screenPickingAtom = atom(false);
/**
 * A screen is shared, or is about to be: on from before the browser's picker opens. What a
 * share of this page must not carry (the camera's own picture in the rigging panel, with a
 * model on) leaves the page by this and not by `screensAtom`: a screen is among those only
 * once its track is in a sender, and what it first saw of the page has gone out by then.
 */
export const screenMaySeePageAtom = atom((get) => get(screenPickingAtom) || get(screensAtom).length > 0);
/** The shared screens' streams by screen slot, for the previews. A stream is not render data, so they are bound imperatively (`VideoFrame`). */
const screenStreamAtoms = Array.from({ length: SCREEN_SLOTS }, () => atom<MediaStream | null>(null));
/** For a screen slot that does not exist (never: slots come from `screenSenders`, which has SCREEN_SLOTS): an atom that stays empty. */
const spareStreamAtom = atom<MediaStream | null>(null);
export const screenStreamAtom = (slot: number) => screenStreamAtoms[slot] ?? spareStreamAtom;
/** The stream this page sends on a video slot: the camera on 0, a screen's display stream on 1 to SCREEN_SLOTS. The preview's layers and the corner player's draw from these. */
export const sentStreamAtom = (slot: number) => (slot === 0 ? cameraAtom : screenStreamAtom(slot - 1));
/** Phones have no screen capture; there the button is not shown at all. */
export const screenShareSupported = typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function';

// ---- the scene (infra/scene.ts): what is on the stream, and where ---------------------------------

/** The sources, bottom first: the camera, the shared screens, the pictures. Those on the stream are the scene. */
export const sourcesAtom = atom<Source[]>([]);
/** What the watchers get: the sources on the stream as layers, in this order. */
export const sceneAtom = atom((get) => sceneOf(get(sourcesAtom)));
/** The slot the preview's own `<video>` (`#preview`) stands in for: the bottom video layer on the stream. `null` with none (a picture alone). */
export const previewSlotAtom = atom((get) => get(sceneAtom).layers.find(isVideoLayer)?.slot ?? null);
/** What `#preview` plays: that slot's stream, and the camera when no video is on the stream (it hides as a dot then). */
export const previewStreamAtom = atom((get) => {
  const slot = get(previewSlotAtom);
  return slot === null || slot === 0 ? get(cameraAtom) : get(screenStreamAtom(slot - 1));
});
/** The source whose row and layer are lit: the one the keys move. */
export const selectedSourceAtom = atom<string | null>(null);
/** The pictures this name has put up (api assets), oldest first: the + menu offers them again. */
export const libraryAtom = atom<{ id: number; mime: string }[]>([]);
/** The sources panel's one line of words: a picture going up or refused, a camera asked for and refused. '' for nothing to say. */
export const sourceStatusAtom = atom('');
/** The avatar is a source already: one is all there is (it is the streamer's own picture). */
export const hasAvatarAtom = atom((get) => get(sourcesAtom).some((s) => s.kind === 'avatar'));
/** The arrangement of the camera and a screen this browser last had: what the first share makes again next time. */
const storedLastAtom = atomWithStorage<unknown>('settings.lastArrangement', null, undefined, { getOnInit: true });
const lastArrangementAtom = atom((get) => validPreset(get(storedLastAtom)));
/** Which of the page's panels are open: the sources, the rigging (under the preview while a model is on), the sound. Kept. */
export interface LivePanels {
  sources: boolean;
  rig: boolean;
  sound: boolean;
}
const storedPanelsAtom = atomWithStorage<unknown>('settings.livePanels', { sources: true, rig: true, sound: true }, undefined, { getOnInit: true });
/** Read: a boolean each, whatever localstorage holds. One it has never heard of is open. */
export const livePanelsAtom = atom<LivePanels>((get) => {
  const raw = get(storedPanelsAtom);
  const p = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return { sources: p.sources !== false, rig: p.rig !== false, sound: p.sound !== false };
});

// ---- the sound (infra/mixer.ts): what everyone hears, and what goes into it ---------------------

/** One row of the mixer: the fader's place (0..1) and the mute. `mic` (and any sound added later), and the master. */
export interface MixRow {
  id: string;
  label: string;
  level: number;
  muted: boolean;
}
export const MASTER = 'master';
export const mixRowsAtom = atom<MixRow[]>([]);
export const masterRowAtom = atom<MixRow>({ id: MASTER, label: 'everyone hears', level: 1, muted: false });
/** The mic's and the master's faders, kept for the next stream. */
const storedMixAtom = atomWithStorage<unknown>('settings.mixer', null, undefined, { getOnInit: true });
/** The mixer is up: the mic chip and the rows read their bars off it. */
export const mixerOpenAtom = atom(false);
/** The mixer is sending. False while its context is suspended (made outside a click, interrupted): the stream is silent then, and a click resumes it. */
export const mixerRunningAtom = atom(true);

// ---- the model (docs/vtuber.md): a 3d model in the camera's place, moved by the streamer's face -------

/** Which model: one of the site's demo models (the bucket's, by id), or one this browser keeps (the streamer's own file, by its id in `model-store.ts`; under 0 it could not be kept and is this visit's only). */
export type ModelChoice = { kind: 'demo'; id: string; v: string; name: string } | { kind: 'kept'; id: number; name: string };
/** The model whose picture is in the camera's slot. `null`: the camera's own picture, or none. */
export const modelAtom = atom<ModelChoice | null>(null);
/**
 * A model on its way on: whose, and how far along. One at a time. `file`: its bytes are coming,
 * down from the server (`loaded` of `total` bytes) or out of this browser. `model`: the file
 * is being made a model of. `reader`: the model stands and the face reader is coming down and
 * starting; it is waited for a few seconds, and joins on its own when it is the slower.
 * `total` 0: not known.
 */
export interface ModelLoad {
  choice: ModelChoice;
  step: 'file' | LoadStep;
  loaded: number;
  total: number;
}
export const modelLoadAtom = atom<ModelLoad | null>(null);
export const modelLoadingAtom = atom((get) => get(modelLoadAtom) !== null);
/** The face reader's own files, still coming with the model already on: bytes so far, of how many (0: not known). Null once it is up. */
export const readerLoadAtom = atom<{ loaded: number; total: number } | null>(null);
/** The picker's one line of words: why a file was refused. '' for nothing to say. */
export const modelStatusAtom = atom('');
/**
 * The face reader, as the streamer is told. `idle` with no model on. `no-camera` and
 * `camera-blocked`: there is nothing to read a face from, and the model breathes and blinks on
 * its own. The rest are the reader's own (`FaceState`).
 */
export type FaceReading = FaceState | 'idle' | 'no-camera' | 'camera-blocked';
export const faceAtom = atom<FaceReading>('idle');
/** How the model is doing, twice a second: frames drawn, faces read, where the head is asked to turn. Null with no model on. */
export const faceStatsAtom = atom<ModelStats | null>(null);
/** What of the model's face the reader can move (`model-rig.ts`). Null with no model on. */
export const modelRigAtom = atom<RigInfo | null>(null);
/** The cameras a face can be read from. The browser names them once one has been allowed. */
export const faceCamerasAtom = atom<{ id: string; label: string }[]>([]);
/**
 * The camera the face is read from, as a stream, for the rigging panel (`live/Rigging.tsx`)
 * and for nothing else: the one place its picture is shown, on the streamer's own page. It is
 * in no sender, so it is on no stream. Null with no model on, and with no camera to read.
 */
export const readerCameraAtom = atom<MediaStream | null>(null);
/** Which of the reader's points join into what, once a face worker has said (`face-wire.ts`). The same for every model. */
export const faceLinesAtom = atom<FaceLines | null>(null);
/** The site's demo models, as the api lists them. Empty until asked, and on an api from before them. */
export const demoModelsAtom = atom<DemoModel[]>([]);
/** The models this browser keeps, newest first. */
export const keptModelsAtom = atom<KeptModel[]>([]);
/** The demo models this browser keeps, and which version of each (the api's `v`): one that is here opens with nothing to download. */
export const keptDemosAtom = atom<ReadonlyMap<string, string>>(new Map<string, string>());
/** Behind the model when the streamer has picked no colour: the dark theme's panel. */
const MODEL_BACKGROUND = '#181b22';
/** The model worn last: the next visit opens it and never puts the camera's own picture in the preview. Cleared by the camera's ×, by the real camera, and by a file that is gone. */
const storedModelAtom = atomWithStorage<unknown>('settings.model', null, undefined, { getOnInit: true });
const storedFaceCameraAtom = atomWithStorage<unknown>('settings.faceCamera', '', undefined, { getOnInit: true });
const storedFaceMirrorAtom = atomWithStorage<unknown>('settings.faceMirror', true, undefined, { getOnInit: true });
const storedFaceExpressionsAtom = atomWithStorage<unknown>('settings.faceExpressions', true, undefined, { getOnInit: true });
const storedModelBackgroundAtom = atomWithStorage<unknown>('settings.modelBackground', MODEL_BACKGROUND, undefined, { getOnInit: true });
const storedRigPictureAtom = atomWithStorage<unknown>('settings.rigPicture', true, undefined, { getOnInit: true });
/** The camera picked to read the face from, by the browser's id for it. '': the browser's own choice. */
export const faceCameraAtom = atom((get) => {
  const id = get(storedFaceCameraAtom);
  return typeof id === 'string' ? id : '';
});
/** The model moves like a mirror: on unless turned off. */
export const faceMirrorAtom = atom((get) => get(storedFaceMirrorAtom) !== false);
/** The brows, the smile and the wide eyes move the model too, not only the mouth and the blinks: on unless turned off. */
export const faceExpressionsAtom = atom((get) => get(storedFaceExpressionsAtom) !== false);
/** The rigging panel always has the camera's picture under the reader's marks (the eye that turned it off is gone). */
export const rigPictureAtom = atom(() => true);
/** The flat colour behind the model, `#rrggbb`. */
export const modelBackgroundAtom = atom((get) => {
  const colour = get(storedModelBackgroundAtom);
  return typeof colour === 'string' && /^#[0-9a-f]{6}$/i.test(colour) ? colour : MODEL_BACKGROUND;
});
/** A `ModelChoice` from anything (localstorage), or `null`. One that could not be kept is not one to come back to. */
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
/** The upload, sampled from the peer once a second while a publish is up. Null once it stops. */
export const publishStatsAtom = atom<StreamStats | null>(null);
export const publishMessageAtom = atom('camera off');
/** Always clean: lowercase, trimmed. Set through `setStreamName`. */
export const streamNameAtom = atom('');
/** The room the streamer's own chat panel is in: the name as settled on arrival, on an identity change, or at start. */
export const chatRoomAtom = atom('');
export const ownerAtom = atom<Owner | null>(null);
/** How many are watching my stream, as video tells me. `null` while not live. */
export const liveViewersAtom = atom<number | null>(null);
/** Pictures on this name's home card, oldest first. Empty: home shows the camera. */
export const streamThumbsAtom = atom<number[]>([]);
export const thumbStatusAtom = atom('');

const MAX_THUMBS = 6;

export const isPublishingAtom = atom((get) => BUSY_PHASES.includes(get(publishPhaseAtom)));
export const canStartAtom = atom((get) => get(cameraAtom) !== null && isValidName(get(streamNameAtom)) && !get(isPublishingAtom));
/** A screen can be shared before start too: it is laid out now and goes into its section when the stream begins. */
export const canShareScreenAtom = atom((get) => screenShareSupported && get(screensAtom).length < SCREEN_SLOTS);
/**
 * The link to share. `?s=<session>` makes it a new url every time you go live: chat apps
 * cache a link's preview card (discord for hours, x for days), so without it a card made
 * while you were offline would stay "offline". The watch page and the api ignore the query.
 */
export const watchUrlAtom = atom((get) => {
  const owner = get(ownerAtom);
  return owner ? `${location.origin}/watch/${owner.name}?s=${owner.session}` : null;
});
export const publishToneAtom = atom<Tone>((get) => {
  const phase = get(publishPhaseAtom);
  if (phase === 'live') return 'live';
  return BAD_PHASES.includes(phase) ? 'bad' : 'neutral';
});
/**
 * Picture in picture for the broadcast: on whenever the go live page is left with a stream up
 * (or on its way up). Leaving never ends a stream: the stream (and the camera it sends) stays
 * up, and the corner player shows it on every other page, watching someone else included.
 * The page's button is the same thing as a home click. Off again on the corner's ×, on a page
 * load, and when the page is left with nothing on air. A stream that fails out there stays in
 * the corner saying so, until × or a visit back to the page.
 */
export const publishPipAtom = atom(false);

let pc: RTCPeerConnection | null = null;
let stopStats: (() => void) | null = null;
let ws: WebSocket | null = null;
let abort: AbortController | null = null;
let heartbeat: ReturnType<typeof setInterval> | null = null;
/** A scene change waiting to be told to the watchers, and one waiting to reach the encoders (`setSources`). */
let sceneTimer: ReturnType<typeof setTimeout> | null = null;
let tuneTimer: ReturnType<typeof setTimeout> | null = null;
/** The camera's video sender, and the SCREEN_SLOTS senders offered empty for screens (`screenSenders[i]` is screen slot i). The audio sender needs no handle: its track is the mix's, for the whole stream. */
let cameraSender: RTCRtpSender | null = null;
let screenSenders: RTCRtpSender[] = [];
/** The mix, from the start click to the end of the camera (`endLive`); a stop in between keeps it, with the mic in it. */
let mixer: Mixer | null = null;
/** The model on the camera's slot: its worker, and the track whose picture it is (`cameraAtom`'s video track while it is on). */
let modelSession: ModelSession | null = null;
/**
 * The camera the face is read from while a model is on. Handed to the face reader, and shown
 * in one place, the rigging panel (`readerCameraAtom`): never in `cameraAtom`, never in a
 * sender. Its picture does not leave the page.
 */
let faceCamera: MediaStreamTrack | null = null;
/** Who draws the reader's marks (`watchFaceMarks`): the worker sends them while there is anyone. */
const marksListeners = new Set<(marks: FaceMarks) => void>();
/** Bumped whenever the model changes or goes: a word from an older model's worker is nobody's. */
let modelToken = 0;
/** The camera's cap right now, for the stats badge. */
let cameraCap = VIDEO_MAX_BITRATE;
/** Pictures added this visit, for their ids. */
let imageCount = 0;
/** Bumped on leaving /live: a camera granted after that belongs to nobody and is stopped. */
let liveGeneration = 0;
/** The name whose thumbnails and library are on the page. */
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
    // the mix is what leaves: its master mute, else (no web audio) the mic track itself
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

/** The name settled: the chat moves to that room and its thumbnails and pictures are loaded. */
export function commitStreamName(): Promise<void> {
  const name = store.get(streamNameAtom);
  store.set(chatRoomAtom, isValidName(name) ? name : '');
  return loadProfile();
}

/**
 * The name on arrival. There is no name box on the page: a login streams as itself, anyone
 * else as the nick in the corner panel (the profile tab is where a guest picks one). Back from
 * the corner with the stream still up there is nothing to settle: the name, its room and its
 * profile stayed.
 */
export async function enterLivePage(): Promise<void> {
  if (store.get(isPublishingAtom)) return;
  const generation = liveGeneration;
  await loadMe();
  if (generation !== liveGeneration) return; // left before the answer: nothing to fill in
  const me = store.get(meAtom);
  setStreamName(me ?? store.get(nickAtom));
  await commitStreamName();
}

/**
 * The page's arrival: the camera and the mic; or, kept from last time, the mic alone
 * (`settings.micOnly`) or a model (`settings.model`), whose camera goes to the face reader and
 * whose own picture is never in the preview.
 */
export async function startCamera(): Promise<void> {
  if (store.get(cameraAtom)) return;
  const kept = validModelChoice(store.get(storedModelAtom));
  if (kept) return startWithModel(kept);
  if (store.get(micOnlyAtom)) return startMic();
  // the permission prompt can outlive the page. an answer that comes after leaving is not ours to keep.
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
    // no mic, or the mic is busy. go without sound.
    try {
      camera = await navigator.mediaDevices.getUserMedia({ video: CAMERA_VIDEO, audio: false });
    } catch {
      if (generation === liveGeneration) setPhase('no-camera', 'no camera');
      return;
    }
  }
  if (generation !== liveGeneration) {
    // granted after leaving /live: nothing would ever stop these tracks, so stop them now
    camera.getTracks().forEach((track) => track.stop());
    return;
  }
  store.set(cameraAtom, camera);
  ensureCameraSource();
  setPhase('camera-ready', camera.getAudioTracks().length ? 'camera ready' : 'camera ready, no mic');
}

/**
 * Mic only (docs/screen.md): the mic alone, no camera prompt, and the avatar for a face. The
 * page's arrival with `settings.micOnly` kept, and the way out of `camera blocked` or `no
 * camera` (`#mic-only`). The stream's offer still carries the camera's section, empty, so the
 * camera can be turned on later without anyone renegotiating (`cameraOn`).
 */
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

/**
 * The camera's ×: mic only from here on. The picture's track is stopped (the light goes off),
 * the mic stays, and the camera leaves the scene; the avatar stands in for the face (added if
 * there is none, back on the stream if it was off), filling the frame when it is all there is.
 * Live, the camera's section goes quiet (`replaceTrack(null)`) and the watchers are told slot 0
 * is not live. Kept for the next visit. Not without a mic: nothing would be left to stream.
 * A model in the camera's place goes the same way, and its face reader's camera with it.
 */
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

/**
 * The +'s `camera`, with the camera off: on again, before start or live. The picture's track
 * joins the mic's stream and, live, goes into the camera's section (`replaceTrack`), and the
 * camera is laid out where a camera goes (`arrangedAfterAdd`: alone it fills the frame, beside
 * a screen it takes the corner). The avatar stood in for it: off the stream now, its box kept,
 * so the eye brings it back beside the camera. With nothing opened yet (the mic was refused),
 * this is the page's whole start over, camera and mic. Refused, the panel says so and mic only stays.
 */
export async function cameraOn(): Promise<void> {
  const had = store.get(cameraAtom);
  if (store.get(hasCameraAtom)) return;
  store.set(storedMicOnlyAtom, false);
  // the camera was asked for by name: a model kept from an earlier visit is not what starts
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
  // the page was left, or the mic went (endLive), while the prompt was up
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

/** The camera is a source from the moment it is on: the bottom of the scene, laid out by the rules (the whole frame alone, the corner beside a screen). */
function ensureCameraSource() {
  const sources = store.get(sourcesAtom);
  if (sources.some((s) => s.kind === 'camera')) return;
  const camera: Source = { id: 'cam', kind: 'camera', label: 'camera', slot: 0, box: FULL, shown: true };
  setSources(arrangedAfterAdd([camera, ...sources], camera, store.get(lastArrangementAtom)));
}

/**
 * The avatar is a source, on the stream. As the face (no camera) it goes to the bottom of the
 * scene and is laid out like the camera; beside a camera it goes on top, centred, like a
 * picture (`arrangedAfterAdd`). One already there is put back on the stream where it was.
 */
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

/** The +'s `avatar`: the streamer's picture, moving with their voice, as a source. */
export function addAvatar() {
  ensureAvatarSource();
  store.set(selectedSourceAtom, AVATAR_ID);
}

// ---- the model's actions (docs/vtuber.md) --------------------------------------------------------

/** A file that is not where it was said to be: the choice that named it is forgotten. Anything else (the server not answering) may be there next time. */
class ModelGone extends Error {}

/** What the reader's camera is asked for: small and steady. The reader looks at 256 pixels of face; the rest of a big frame is work for nothing. */
const faceVideo = (deviceId: string): MediaTrackConstraints => ({
  width: { ideal: 640 },
  height: { ideal: 480 },
  frameRate: { ideal: 30 },
  ...(deviceId && { deviceId: { exact: deviceId } })
});

/**
 * A camera for the face reader: the one picked, else the browser's own choice. `null`, with
 * the reason in `faceAtom`, when there is none to have.
 */
async function openFaceCamera(): Promise<MediaStreamTrack | null> {
  const picked = store.get(faceCameraAtom);
  for (const deviceId of picked ? [picked, ''] : ['']) {
    try {
      return (await navigator.mediaDevices.getUserMedia({ video: faceVideo(deviceId) })).getVideoTracks()[0] ?? null;
    } catch (err) {
      const name = err instanceof DOMException ? err.name : '';
      // the camera picked on an earlier visit is not plugged in today: the browser's choice instead
      if (deviceId && (name === 'OverconstrainedError' || name === 'NotFoundError')) continue;
      store.set(faceAtom, name === 'NotAllowedError' ? 'camera-blocked' : 'no-camera');
      return null;
    }
  }
  store.set(faceAtom, 'no-camera');
  return null;
}

/** The cameras by name, for the picker. The browser gives the names only after a camera was allowed. */
async function refreshFaceCameras() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    store.set(
      faceCamerasAtom,
      devices.filter((d) => d.kind === 'videoinput' && d.deviceId).map((d, i) => ({ id: d.deviceId, label: d.label || `camera ${i + 1}` }))
    );
  } catch {
    // the list stays as it was
  }
}

/** The load that is on moves along, when it is still `choice`'s: a word from one that was overtaken changes nothing. */
function loadStep(choice: ModelChoice, step: ModelLoad['step'], loaded = 0, total = 0) {
  if (store.get(modelLoadAtom)?.choice === choice) store.set(modelLoadAtom, { choice, step, loaded, total });
}

/** `choice`'s load is over, however it went. */
function endLoad(choice: ModelChoice) {
  if (store.get(modelLoadAtom)?.choice === choice) store.set(modelLoadAtom, null);
}

async function refreshKeptDemos() {
  store.set(keptDemosAtom, new Map((await listKeptDemos()).map((demo) => [demo.id, demo.v])));
}

/** The picker is told how a download is going at most this often: a megabyte is a few dozen pieces. */
const DOWNLOAD_TELL_MS = 80;

/**
 * A demo model's file from the server, counted as it comes (`modelLoadAtom`). `bytes`: its size
 * as the api's list has it, for when the answer does not say. Throws words.
 */
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

/**
 * The bytes of a model: one of their own out of this browser, or a demo model, out of this
 * browser when it was worn here before and down from the bucket when not. A demo that came
 * down is kept (`model-store.ts`), so the next time it opens at once and with the server away.
 * `bytes`: a demo's size as the api's list has it, when the caller knows. Throws words.
 */
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
    // not a model: `putModelOn` says why, and nothing of it is kept
    return file;
  }
  // a copy, made now: the bytes themselves are handed to the worker and are gone from here after that
  void keepDemo(choice.id, choice.v, new Blob([file])).then((ok) => (ok ? refreshKeptDemos() : undefined));
  return file;
}

/**
 * The model and its face reader go: the track with its picture ends, the worker closes, and
 * the camera the face was read from is let go (the light goes off). What the stream shows
 * instead is the caller's to settle.
 */
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

/**
 * A model that broke while it was on (the drawing was lost, its worker died). Never the
 * camera: what is left is the mic and the picture avatar, the way the camera's × leaves it,
 * and kept that way so the next visit does not open the camera's own picture unasked. With no
 * mic there is nothing left to stream, and a stream that is up ends.
 */
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

/**
 * `file` on the stream as `choice`: read, drawn in its worker, and its track put where the
 * camera's picture goes (the stream's own stream and, live, the camera's section, with
 * `replaceTrack`: nothing renegotiated). `cameraOn` with a different track, and the same
 * layout: the camera source by the rules, the picture avatar off the stream.
 *
 * The face is read from the camera that is on, when one is (it leaves the stream for the
 * reader and is not opened twice); from the one the last model had; else from one opened for
 * it. With none to have the model still goes on, and breathes and blinks on its own.
 *
 * False, with the reason in `modelStatusAtom`, when the file cannot be made a model of:
 * whatever the picture was before stays as it is. `opened`: the mic and the reader's camera
 * of a start with nothing open yet (`openForModel`). They are the caller's until this says
 * true, and no other camera is asked for, not even when that one is `null`.
 */
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
  // the real camera's own track, while no model is on yet: it is what the reader gets
  const own = old ? null : live(before?.getVideoTracks()[0]);
  const camera = opened ? live(opened.camera) : (live(faceCamera) ?? own ?? (await openFaceCamera()));
  // a camera this call opened is this call's to let go when the model does not come
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
        // the picker's bar while it waits for this model; the controls' once the model is on and its reader is still coming
        loadStep(choice, step, loaded, total);
        store.set(readerLoadAtom, step === 'reader' ? { loaded, total } : null);
      },
      onState: (face) => {
        if (!mine()) return;
        if (face !== 'starting') store.set(readerLoadAtom, null);
        // with no camera the reader has nothing to say and the word stays `no camera`, until the picker gives it one
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
      // whatever was on is still on, and its reader says what it said
      store.set(faceAtom, faceWas);
      store.set(readerLoadAtom, null);
    }
    return false;
  }
  // the page was left, or the picture changed under it (the camera's ×, another pick), while the model was loading
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
  // live: the camera's section carries the model from here. before the stream's own stream changes, so nothing of the camera follows it out
  if (cameraSender) await cameraSender.replaceTrack(session.track).catch(() => undefined);
  if (stale()) return giveUp();
  const sound = before?.getAudioTracks() ?? opened?.mic?.getAudioTracks() ?? [];
  store.set(cameraAtom, new MediaStream([...sound, session.track]));
  // the old model's picture ends; the real camera's track, if that is what was on, lives on as the reader's
  old?.stop();
  modelSession = session;
  faceCamera = camera;
  // the rigging panel's picture: the reader's camera, on this page and nowhere else
  store.set(readerCameraAtom, camera ? new MediaStream([camera]) : null);
  if (marksListeners.size > 0) session.setMarks(true);
  // what was set while it loaded went to the model it takes the place of: this one hears it now
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

/** What a model that starts with nothing open is given: the sound, and a camera for its reader. Either can be missing. */
interface OpenedForModel {
  mic: MediaStream | null;
  camera: MediaStreamTrack | null;
}

/**
 * The mic and the reader's camera, asked for together (one prompt). The pair refused, or the
 * camera picked last time gone: each on its own, so the other still comes. No camera leaves
 * the reason in `faceAtom`.
 */
async function openForModel(): Promise<OpenedForModel> {
  try {
    const both = await navigator.mediaDevices.getUserMedia({ video: faceVideo(store.get(faceCameraAtom)), audio: true });
    return { mic: new MediaStream(both.getAudioTracks()), camera: both.getVideoTracks()[0] ?? null };
  } catch {
    const mic = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null);
    return { mic, camera: await openFaceCamera() };
  }
}

/** What `openForModel` opened and no model took: the camera's light goes off, the mic closes. */
function letGoOf(opened: OpenedForModel) {
  opened.camera?.stop();
  opened.mic?.getTracks().forEach((track) => track.stop());
}

/**
 * The page's arrival with a model kept from last time: the mic and the reader's camera are
 * asked for together (one prompt), the camera's track goes to the reader, and what goes into
 * the stream's own stream is the mic and the model. The camera's own picture is never in the
 * preview, not for a frame. A model that cannot be had (the file is gone, it will not load)
 * leaves the mic alone with the picture avatar, kept that way.
 */
async function startWithModel(choice: ModelChoice): Promise<void> {
  const generation = liveGeneration;
  store.set(modelLoadAtom, { choice, step: 'file', loaded: 0, total: 0 });
  store.set(publishMessageAtom, 'getting your model');
  // one of their own has its picture on this browser's shelf: the preview shows it while the model loads
  if (choice.kind === 'kept') void listKept().then((kept) => store.set(keptModelsAtom, kept));
  const [file, opened] = await Promise.all([modelFile(choice).catch((err: unknown) => (err instanceof Error ? err : new Error(String(err)))), openForModel()]);
  // the page was left, or something else was opened (the +'s camera), while this was on its way: what was opened here is nobody's
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
  // no model: the mic alone, the way mic only starts, and no camera's picture
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

/** A small square jpeg of a model's own thumbnail, for the picker's shelf of kept models. */
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

/**
 * One pick at a time: fetched (or read), then put on. The picker and the preview show how far
 * along it is (`modelLoadAtom`) and, when it does not come, why (`modelStatusAtom`). `first`
 * is the model as it is known when the pick is made; `fetchIt` hands back its bytes, and the
 * choice as it stands by then (a file of their own has its place on the shelf only once it is
 * kept). With nothing open yet (the camera was refused, or there is none), the mic and a
 * camera for the reader are asked for here, after the file is known to be a model: so a model
 * picked there has a voice, and one that will not load leaves nothing open behind it.
 */
async function pickModel(first: ModelChoice, fetchIt: () => Promise<{ choice: ModelChoice; file: ArrayBuffer }>): Promise<boolean> {
  if (store.get(modelLoadAtom)) return false;
  const generation = liveGeneration;
  let choice = first;
  store.set(modelLoadAtom, { choice, step: 'file', loaded: 0, total: 0 });
  store.set(modelStatusAtom, '');
  /** This pick is still the one that is loading: the page was not left, and nothing took its place. */
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

/**
 * The picker opened: the site's demo models, and what this browser keeps of them and of the
 * streamer's own. An api from before the demo models has none, which is nothing to say. The
 * list is what there is: a kept file of a demo that left it, or that is another version there
 * now, goes, and the next pick brings the new one down.
 */
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
  // the model to come back to follows its file: a kept choice that named the old version would download the new one on every visit and keep it under the old name
  const worn = validModelChoice(store.get(storedModelAtom));
  const listed = worn?.kind === 'demo' ? models.find((model) => model.id === worn.id) : undefined;
  if (worn?.kind === 'demo' && listed && listed.v !== worn.v) store.set(storedModelAtom, { kind: 'demo', id: listed.id, v: listed.v, name: listed.name });
  store.set(keptDemosAtom, new Map((await pruneKeptDemos(models)).map((demo) => [demo.id, demo.v])));
}

/** One of the site's demo models: out of this browser when it was worn here before, else down from the bucket. */
export function pickDemoModel(model: DemoModel): Promise<boolean> {
  const choice: ModelChoice = { kind: 'demo', id: model.id, v: model.v, name: model.name };
  return pickModel(choice, async () => ({ choice, file: await modelFile(choice, model.bytes) }));
}

/** One of their own that this browser keeps. */
export function pickKeptModel(model: KeptModel): Promise<boolean> {
  const choice: ModelChoice = { kind: 'kept', id: model.id, name: model.name };
  return pickModel(choice, async () => ({ choice, file: await modelFile(choice) }));
}

/**
 * The streamer's own file. It is read here, kept in this browser for next time (a browser that
 * cannot keep it still wears it for the visit), and goes nowhere else: nothing is put up. The
 * browser is asked to keep what is kept here for good: this one cannot be downloaded again.
 */
export function pickModelFile(picked: File): Promise<boolean> {
  const named = picked.name.replace(/\.[^.]+$/, '') || 'model';
  return pickModel({ kind: 'kept', id: -1, name: named }, async () => {
    const file = await picked.arrayBuffer();
    const info = readModel(file);
    const name = info.name || named;
    const kept = await keepModel(picked, { name, author: info.author }, info.thumbnail ? await smallThumb(info.thumbnail) : null);
    if (kept) {
      store.set(keptModelsAtom, await listKept());
      void keepForGood();
    }
    return { choice: { kind: 'kept', id: kept?.id ?? -1, name }, file };
  });
}

/** The shelf's ×: the file goes from this browser. One that is on stays on for the visit. */
export async function forgetKeptModel(id: number): Promise<void> {
  await forgetKept(id);
  store.set(keptModelsAtom, await listKept());
  const kept = validModelChoice(store.get(storedModelAtom));
  if (kept?.kind === 'kept' && kept.id === id) store.set(storedModelAtom, null);
}

/**
 * The model's row: back to the camera's own picture. The camera is asked for first, so a
 * camera that says no leaves the model where it is; then its track takes the model's place
 * (live, with `replaceTrack`), the layer staying where it was. The page asks before it calls
 * this on a stream that is up: watchers see a face from here.
 */
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

/** The model moves like a mirror, or like the person a camera sees. Kept. */
export function setFaceMirror(mirror: boolean) {
  store.set(storedFaceMirrorAtom, mirror);
  modelSession?.setMirror(mirror);
}

/** The brows, the smile and the wide eyes move the model too, or only the mouth, the blinks and the eyes do. Kept. */
export function setFaceExpressions(on: boolean) {
  store.set(storedFaceExpressionsAtom, on);
  modelSession?.setExpressions(on);
}

/** The flat colour behind the model, `#rrggbb`. Kept. */
export function setModelBackground(colour: string) {
  if (!/^#[0-9a-f]{6}$/i.test(colour)) return;
  store.set(storedModelBackgroundAtom, colour);
  modelSession?.setBackground(colour);
}

/** `rest face`: the face as it is now is the resting one, from the next readings. */
export function restFace() {
  modelSession?.rest();
}

/**
 * The reader's marks, one call a reading, for as long as someone listens: the rigging panel
 * while it is open. The worker sends them only then. Not an atom: thirty a second is a
 * canvas's to draw, not react's to render. Returns the way to stop listening.
 */
export function watchFaceMarks(listener: (marks: FaceMarks) => void): () => void {
  marksListeners.add(listener);
  modelSession?.setMarks(true);
  return () => {
    marksListeners.delete(listener);
    if (marksListeners.size === 0) modelSession?.setMarks(false);
  };
}

/** The rigging panel's eye: the camera's picture under the marks, or the marks alone. Kept. */
export function setRigPicture(on: boolean) {
  store.set(storedRigPictureAtom, on);
}

/** Another camera to read the face from. Kept; one that will not open leaves the reader on the camera it has. */
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
  // a model that had no camera to read (`no camera`, `camera blocked`) has one now: the reader's next word says what it sees
  store.set(faceAtom, was === 'on' ? 'on' : 'lost');
  store.set(sourceStatusAtom, '');
  void refreshFaceCameras();
}

export async function goLive(): Promise<void> {
  const camera = store.get(cameraAtom);
  const name = store.get(streamNameAtom);
  if (!camera || !isValidName(name) || pc) return;
  // a stream kept in the corner while you looked around (watch-atoms' picture in picture) goes
  // when you go live, as its × would: not hidden, ended, so nothing of it plays or polls on
  if (store.get(pipAtom)) endWatch();
  store.set(chatRoomAtom, name); // the chat is the room of the name you go live as

  // The sound: one track for the whole stream, mixed in the page (infra/mixer.ts), so a source
  // can join or leave the mix later without anyone renegotiating. Made here, in the click, so it
  // runs, and before the phase changes, so the mic chip finds it when it mounts.
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

  // Everything below belongs to this attempt. If stop runs meanwhile, `pc` changes and the
  // attempt must quietly give up.
  const myPc = new RTCPeerConnection();
  const myAbort = new AbortController();
  const gone = () => pc !== myPc;
  pc = myPc;
  abort = myAbort;
  // the tab closing ends the stream wherever in the app it is kept (picture in picture takes it
  // off its page), so the listener is the stream's, from here to `stopLive`, not the page's.
  // `pagehide` alone, never `beforeunload`: that one fires for leaves that never happen (a
  // `mailto:` or an app's link, a leave another listener cancels), and the stream stopped then
  addEventListener('pagehide', stopOnLeave);
  myPc.onconnectionstatechange = () => {
    if (!gone()) onConnection(myPc.connectionState);
  };

  // The camera's section, video slot 0 to everyone: with the camera's track in it, or empty
  // (mic only) and filled later by `cameraOn` with `replaceTrack`, the way a screen's is. Always
  // offered, so the screens keep their slot numbers and a camera turned on later renegotiates nothing.
  const cameraInit: RTCRtpTransceiverInit = { direction: 'sendonly', streams: [camera], sendEncodings: [{ maxBitrate: VIDEO_MAX_BITRATE }] };
  const picture = camera.getVideoTracks()[0];
  if (picture) picture.contentHint = 'motion';
  cameraSender = (picture ? myPc.addTransceiver(picture, cameraInit) : myPc.addTransceiver('video', cameraInit)).sender;
  // One opus, always: the mix, else (no web audio) the mic, else a section with nothing in it.
  // A silent section beats no section: video makes the room's slots from the offer, so a
  // stream started without a mic could never carry a sound added later otherwise.
  const sound = mixer?.outputTrack ?? mic;
  if (sound) myPc.addTransceiver(sound, { direction: 'sendonly', streams: [camera] });
  else myPc.addTransceiver('audio', { direction: 'sendonly' });
  // The screens' sections, offered now: a screen shared before start is in its section from the
  // first frame, the rest are empty, and a screen shared later goes into one with `replaceTrack`.
  // Nothing is renegotiated either way, with video or with anyone watching. The camera is video
  // slot 0 to everyone, these are 1 to SCREEN_SLOTS.
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
      // stop was pressed while the api was answering. give the name back.
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
    // not reported: a name that is simply taken, and anything the api answered (a 4xx is the
    // person's, a 5xx request() reported already). the relay and ice failures are.
    stopLive(taken ? 'someone is already live with that name' : `failed: ${messageOf(err)}`, 'failed', { report: !taken && !(err instanceof ApiError) });
    return;
  }

  ws.onclose = () => stopLive('connection lost', 'failed');
  heartbeat = setInterval(sendHeartbeat, HEARTBEAT_MS);
  setPhase('connecting', 'connecting');
  if (gone()) return;
  startPublishStats();
  // what was laid out before start (a screen, a picture, the camera's box), to the first watcher
  // too, and the upload divided for it
  announceSlots();
  void tuneSenders();
}

function sendHeartbeat() {
  const owner = store.get(ownerAtom);
  if (!owner) return;
  api.heartbeat(owner).catch((err: unknown) => {
    // answered after a stop (ours or a lost session): nothing left to end
    if (store.get(ownerAtom) !== owner) return;
    // 403/404/409: the api no longer thinks this session is the live one.
    const status = statusOf(err);
    if (status !== 403 && status !== 404 && status !== 409) return;
    store.set(ownerAtom, null); // not ours any more, so do not stop whoever has it now
    stopLive('session lost. press start again', 'failed');
  });
}

function onConnection(state: RTCPeerConnectionState) {
  if (state === 'connected') setPhase('live', 'live');
  else if (state === 'disconnected') setPhase('reconnecting', 'reconnecting');
  else if (state === 'failed') stopLive('connection failed. udp blocked?', 'failed');
}

/**
 * The picker, with the hints first. A browser that rejects a hint (a `TypeError` on the
 * options, an `OverconstrainedError`) is asked again with the size cap alone, and the share
 * still happens. The picker closed without a choice (`NotAllowedError`), or anything else, is
 * `null`: nothing to share, and no second picker.
 */
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

/** The pickers that are up: one, unless the button was pressed again under the first. */
let screenPicks = 0;

/**
 * The share button and the + menu: the browser's picker, one screen (or window, or tab) per
 * press, into the first free screen slot. The picker closed without a choice is nothing. Sharp
 * text over smooth motion (`contentHint`), and no more than 1080p (`SCREEN_CAP`). The browser's
 * own "stop sharing" bar ends the track, which is a stop here. Live, the track goes into the
 * slot's section now; before start it waits in the slot and the section is offered with it
 * (`goLive`). Either way the new screen is a source, put into the scene by the rules
 * (`arrangedAfterAdd`), so the frame can be laid out before anyone sees it.
 *
 * `screenMaySeePageAtom` is on from here, before the picker opens, until the pick is among
 * the screens or came to nothing: the share may be of this very page, and what it must not
 * carry has to be off the page before there is a share to see it.
 */
export async function shareScreen(): Promise<void> {
  if (!store.get(canShareScreenAtom)) return;
  store.set(screenPickingAtom, ++screenPicks > 0);
  try {
    await sharePicked();
  } finally {
    store.set(screenPickingAtom, --screenPicks > 0);
  }
}

/** `shareScreen`'s work: the picker, and its pick into a slot. */
async function sharePicked(): Promise<void> {
  const generation = liveGeneration;
  const display = await pickDisplay();
  if (!display) return;
  const track = display.getVideoTracks()[0];
  const slot = screenStreamAtoms.findIndex((streamAtom) => store.get(streamAtom) === null);
  // the page was left, or every slot filled, while the picker was up
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

/** The tile's stop, the row's ×, or the browser's "stop sharing" bar. The slot is emptied and free again. */
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
  // a closed peer refuses this; nothing is lost then, the stream is over. before start there is no sender yet
  screenSenders[slot]?.replaceTrack(null).catch(() => undefined);
  dropSource(`s${slot + 1}`);
  slotsChanged();
}

/** A video slot came up or went quiet (a screen, the camera): the watchers are told now, and the upload divided again. */
function slotsChanged() {
  announceSlots();
  void tuneSenders();
}

// ---- the scene's actions: the sidebar and the preview both come through here ----------------------

/**
 * The sources changed: the preview follows at once; the watchers are told within SCENE_SEND_MS
 * with the latest by then (a drag is many changes a second, the box and every watcher get a
 * few); the encoders follow once it has settled for TUNE_MS.
 */
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

/** A source went (a screen stopped, a picture removed): out of the list, and one picture left fills the frame. */
function dropSource(id: string) {
  const sources = store.get(sourcesAtom);
  if (!sources.some((s) => s.id === id)) return;
  setSources(arrangedAfterRemove(sources.filter((s) => s.id !== id)));
  if (store.get(selectedSourceAtom) === id) store.set(selectedSourceAtom, null);
}

/** The face (the camera, or the avatar standing in for it) and a screen both on the stream: this arrangement is the one the next first share makes. */
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

/** A drag: the box as it was when the press began, slid by `dx`,`dy` of the frame. */
export function moveSource(id: string, from: Box, dx: number, dy: number) {
  withSource(id, (s) => ({ ...s, box: movedBox(from, dx, dy) }));
}

/** A corner pulled. A picture keeps its shape; a video keeps its box's shape unless `free` (shift). */
export function resizeSource(id: string, from: Box, sx: number, sy: number, dx: number, dy: number, free: boolean) {
  withSource(id, (s) => ({ ...s, box: resizedBox(from, sx, sy, dx, dy, s.ratio ?? (free ? null : from.w / from.h)) }));
}

/** The arrow keys: by `dx`,`dy` of the frame. */
export function nudgeSource(id: string, dx: number, dy: number) {
  withSource(id, (s) => ({ ...s, box: movedBox(s.box, dx, dy) }));
}

/** The eye: on the stream, or off it (a video source is a tile for watchers then). The box is kept for the way back. */
export function toggleSource(id: string) {
  withSource(id, (s) => ({ ...s, shown: !s.shown }));
}

/** The `[` and `]` keys on a layer of the preview: one step up (towards the front) or down the stack. */
export function reorderSource(id: string, dir: 'up' | 'down') {
  const sources = [...store.get(sourcesAtom)];
  const i = sources.findIndex((s) => s.id === id);
  const j = dir === 'up' ? i + 1 : i - 1;
  if (i < 0 || j < 0 || j >= sources.length) return;
  [sources[i], sources[j]] = [sources[j]!, sources[i]!];
  setSources(sources);
}

/**
 * The row's handle, dragged or stepped with its arrow keys: the source put at `to` in the stack
 * (0 is the bottom), stopped at the stack's two ends. Already there, nothing changes: a drag
 * asks for the same place many times a second.
 */
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

/** `fill` or `whole`, on a video source. */
export function setSourceFit(id: string, fit: Fit) {
  withSource(id, (s) => ({ ...s, fit }));
}

/** A picture laid exactly over another source (a border over the camera), just above it in the stack. */
export function fitSourceTo(id: string, targetId: string) {
  const sources = store.get(sourcesAtom).filter((s) => s.id !== id);
  const source = store.get(sourcesAtom).find((s) => s.id === id);
  const at = sources.findIndex((s) => s.id === targetId);
  const target = sources[at];
  if (!source || !target) return;
  sources.splice(at + 1, 0, { ...source, box: { ...target.box }, shown: true });
  setSources(sources);
}

/** The row's ×: a screen stops sharing, a picture or the avatar leaves the scene (an upload stays in the library), the camera is turned off (mic only). */
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

// ---- pictures: cut in the dialog, up to the api, then a source with their own shape ------------------

/** A picture's shape, from the bytes the api serves: decoded once, so the box is right before the layer shows anywhere. */
async function imageRatio(url: string): Promise<number> {
  const img = new Image();
  img.src = url;
  await img.decode();
  return ratioOf(img.naturalWidth, img.naturalHeight);
}

/**
 * The + menu's `image or gif`: the part of the file picked in the crop dialog, up to the api at
 * its own pixels (the whole of it is the file itself: a png keeps its holes), then onto the
 * stream. A gif skips the dialog and goes up whole: a cut would be one frame of it.
 */
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

/** A picture of the library (one put up now, or on an earlier visit) as a new source, centred, on top. */
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

/** The library's ×: the upload goes from the api, and from the scene with it. */
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

// ---- the mixer's actions -----------------------------------------------------------------------

/** The faders this browser kept: the mic's and the master's. */
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

/** A fader moved: `level` is the slider's place, 0..1 (the gain is its cube, `mixer.ts`). */
export function setMixLevel(id: string, level: number) {
  setMixRow(id, (row) => ({ ...row, level: Math.min(1, Math.max(0, level)) }));
}

export function setMixMuted(id: string, muted: boolean) {
  setMixRow(id, (row) => ({ ...row, muted }));
}

/** A row's bar right now, 0..1: the mixer's reading for the mic, a tab or the master. 0 with no mixer. */
export function readMixLevel(id: string, now: number): number {
  if (!mixer) return 0;
  return id === MASTER ? mixer.master.read(now) : (mixer.source(id)?.level.read(now) ?? 0);
}

/** The master clipped in the last second: the mix is too hot. */
export function mixClipping(now: number): boolean {
  return mixer?.clipping(now) ?? false;
}

/** The mic chip's reader while the mixer is up. */
export const micLevelReader = (now: number) => readMixLevel('mic', now);

/** The `sound paused` button: a click, so the context may run again. */
export async function resumeMixer(): Promise<void> {
  await mixer?.resume().catch(() => undefined);
  store.set(mixerRunningAtom, mixer?.running ?? true);
}

const checkMixer = () => store.set(mixerRunningAtom, mixer?.running ?? true);
let mixerWatched = false;

/** The context's state, now and when it may have changed: a stream gone silent because the browser paused the mix says so. */
function watchMixer() {
  checkMixer();
  if (!mixer || mixerWatched) return;
  // the moments it changes are a tab shown again and a click; one listener for the life of the mixer (`endLive` takes it off)
  mixerWatched = true;
  document.addEventListener('visibilitychange', checkMixer);
  setTimeout(checkMixer, 500);
}

function unwatchMixer() {
  if (!mixerWatched) return;
  mixerWatched = false;
  document.removeEventListener('visibilitychange', checkMixer);
}

/** Tell video what is live where, for the watchers: the camera (while it is on; mic only leaves slot 0 out), then each shared screen, and the scene they are laid out in. */
function announceSlots() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const screens: SlotInfo[] = store.get(screensAtom).map((s) => ({ slot: s.slot + 1, kind: 'screen', label: s.label }));
  const slots: SlotInfo[] = store.get(hasCameraAtom) ? [{ slot: 0, kind: 'camera' }, ...screens] : screens;
  const scene = store.get(sceneAtom);
  record('/ws', 'out', { slots, scene });
  ws.send(JSON.stringify({ slots, scene }));
}

/** The camera's encode shrunk to its box: 1280 wide, over a frame at most 1920 wide, so `0.667 / w` is enough, in steps and never past 4. */
function cameraScale(w: number): number {
  const want = Math.min(4, Math.max(1, 0.667 / Math.max(w, 0.05)));
  return CAMERA_SCALES.filter((s) => s <= want + 1e-6).pop() ?? 1;
}

/**
 * The upload, divided by the scene. The stage, the biggest picture on the stream, gets the
 * budget: a screen there has the screens' 3 Mbps less a little for each other screen, the
 * camera there its full 2.5. The camera in a corner is sent as small as its box, with the bits
 * that is worth; off the stream (a tile) it is sent small too. Other screens get a little each
 * at half the frames. A screen is letters and ui: when the uplink or the cpu gets tight its
 * encoder keeps the pixels and drops frames (`maintain-resolution`) for as long as the slot has
 * a track, and the preference goes when the slot is emptied. The camera is left to the browser's
 * default, so a face keeps its frames.
 */
async function tuneSenders() {
  const sources = store.get(sourcesAtom);
  const screens = store.get(screensAtom);
  // the pictures that cost bits: a picture and the avatar are drawn by the watcher, not sent
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
  // the stage screen, else the first one shared, carries the budget
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
  /** `scaleResolutionDownBy`: 1 is the capture's own size. */
  scale?: number;
  maxFramerate?: number;
}

async function tune(sender: RTCRtpSender | null, { maxBitrate, scale = 1, maxFramerate }: Encoding, degradation?: RTCDegradationPreference) {
  if (!sender) return;
  const params = sender.getParameters();
  const encoding = params.encodings?.[0];
  if (!encoding) return; // not negotiated yet: the offer's cap holds
  encoding.maxBitrate = maxBitrate;
  encoding.scaleResolutionDownBy = scale;
  if (maxFramerate) encoding.maxFramerate = maxFramerate;
  else delete encoding.maxFramerate;
  if (degradation) params.degradationPreference = degradation;
  else delete params.degradationPreference;
  await sender.setParameters(params).catch(() => undefined);
}

/**
 * Stop button, failures, leaving. The camera preview keeps running. A failure is reported,
 * with the peer's stats, before the peer is closed below; `report: false` for one that is
 * not ours (the api said no, the name is taken).
 */
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
  // the shared screens go with the stream (the camera preview stays)
  for (const streamAtom of screenStreamAtoms) {
    store
      .get(streamAtom)
      ?.getTracks()
      .forEach((track) => track.stop());
    store.set(streamAtom, null);
  }
  store.set(screensAtom, []);
  // the screens go from the scene; the camera and the pictures stay, for the next start
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

/**
 * Tab closed. sendBeacon survives page teardown, fetch may not. Only this page's own document
 * going counts: the popped out player's window (infra/popout.ts) hides and closes on its own,
 * and that is never a stop.
 */
export function stopOnLeave(event?: Event) {
  if (event && event.target !== document) return;
  const owner = store.get(ownerAtom);
  if (!owner) return;
  api.stopBeacon(owner);
  store.set(ownerAtom, null);
  stopLive();
}

/**
 * The page's button, before its home click: the corner is on by the time home shows. Leaving
 * any other way (`leaveLivePage`) turns it on just the same; the way back off is the corner's ×.
 */
export function startPublishPip() {
  store.set(publishPipAtom, true);
}

/**
 * Navigated away inside the app. With a stream up (or on its way up), everything stays as it
 * is and the corner player takes over: going home to look around, or to watch someone else,
 * is not a stop. With nothing on air the camera is released and the page's boxes forgotten.
 * On air is the stream's own handles (the peer, the owner), not only the phase's word: a
 * stream that is up is never ended by a page going away.
 */
export function leaveLivePage() {
  if (store.get(isPublishingAtom) || pc !== null || store.get(ownerAtom) !== null) {
    store.set(publishPipAtom, true);
    return;
  }
  endLive();
}

/**
 * The corner's ×, and leaving the page with nothing on air: the stream ends, the camera goes,
 * the page's boxes are forgotten.
 */
export function endLive() {
  store.set(publishPipAtom, false);
  liveGeneration++;
  stopLive();
  // the model's worker and the camera its face was read from: the kept choice stays, for the next visit
  dropModel();
  store.set(modelLoadAtom, null);
  store.set(modelStatusAtom, '');
  // the mix goes before the mic it was reading; the source tracks are the camera's to stop, below
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

/**
 * The thumbnails and the picture library saved under the name in the box. Another name than
 * last time starts clean: the old name's go, so nothing of theirs can be saved under the new
 * one. The status and the picture are not here: the profile tab sets them.
 */
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
    // the box moved on, or the page was left, while the api was answering
    if (store.get(streamNameAtom) !== name || generation !== liveGeneration) return;
    store.set(streamThumbsAtom, me.thumbs ?? []);
  } catch {
    // nothing saved yet
  }
  try {
    const { assets } = await api.listAssets(name);
    if (store.get(streamNameAtom) !== name || generation !== liveGeneration) return;
    store.set(libraryAtom, assets);
  } catch {
    // an older api, or nothing put up yet: the + menu offers the upload alone
  }
}

/**
 * The name follows the identity when the user modal or the corner panel changes it (a login,
 * a logout, a new nick) while this page is open and nothing is on air: the page settles the
 * name once, on arrival, and would otherwise go live under the old name while the chat speaks
 * as the new.
 */
export function followIdentityOnLivePage() {
  if (location.pathname.replace(/\/$/, '') !== '/live' || store.get(isPublishingAtom)) return;
  const name = store.get(meAtom) ?? cleanName(store.get(nickAtom));
  if (name === store.get(streamNameAtom)) return;
  setStreamName(name);
  void commitStreamName();
}

/**
 * A thumbnail: the 16:9 of the file picked in the crop dialog, as a 960x540 jpeg (infra/picture.ts),
 * so the api never has to decode an image. Nothing is said while the dialog is open; closed
 * without, nothing happens.
 */
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
