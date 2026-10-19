/**
 * Going live from the browser camera. State lives in atoms; the peer connection, socket and
 * timers are plain module handles because nothing renders from them. Every state change goes
 * through an action function here, so cause and effect sit in one place (no reactive effects).
 */

import { atom } from 'jotai';

import { ApiError, api, type Owner, messageOf, statusOf } from '@/infra/api';
import { loadMe, meAtom } from '@/infra/atoms/auth-atoms';
import { nickAtom } from '@/infra/atoms/chat-atoms';
import { cleanName, isValidName } from '@/infra/names';
import { connectRelay, waitForIceGathering } from '@/infra/relay';
import { reportPeerFailure } from '@/infra/report';
import { store } from '@/infra/store';
import type { Tone } from '@/shared-components/StatusLine';

export type PublishPhase = 'camera-off' | 'camera-blocked' | 'no-camera' | 'camera-ready' | 'starting' | 'connecting' | 'live' | 'reconnecting' | 'stopped' | 'failed';

const HEARTBEAT_MS = 15000;
const VIDEO_MAX_BITRATE = 2_500_000;
const BUSY_PHASES: readonly PublishPhase[] = ['starting', 'connecting', 'live', 'reconnecting'];
const BAD_PHASES: readonly PublishPhase[] = ['camera-blocked', 'no-camera', 'failed'];

export const cameraAtom = atom<MediaStream | null>(null);
export const publishPhaseAtom = atom<PublishPhase>('camera-off');
export const publishMessageAtom = atom('camera off');
/** Always clean: lowercase, trimmed. Set through `setStreamName`. */
export const streamNameAtom = atom('');
/**
 * The room the streamer's own chat panel is in: the name box as last settled (blur, enter,
 * start), never the keystrokes. Following every keystroke would join a room per letter typed.
 */
export const chatRoomAtom = atom('');
export const ownerAtom = atom<Owner | null>(null);
export const bioDraftAtom = atom('');
export const bioStatusAtom = atom('');
/** The upload time of my picture (the `?v=` of its url). `null`: none. */
export const myAvatarAtom = atom<number | null>(null);
export const avatarStatusAtom = atom('');

/** The picture the page sends: this big, as a jpeg of this quality. A few tens of kb. */
const AVATAR_PX = 256;
const AVATAR_QUALITY = 0.85;

export const hasMicAtom = atom((get) => (get(cameraAtom)?.getAudioTracks().length ?? 0) > 0);
export const isPublishingAtom = atom((get) => BUSY_PHASES.includes(get(publishPhaseAtom)));
export const canStartAtom = atom((get) => get(cameraAtom) !== null && isValidName(get(streamNameAtom)) && !get(isPublishingAtom));
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

let pc: RTCPeerConnection | null = null;
let ws: WebSocket | null = null;
let abort: AbortController | null = null;
let heartbeat: ReturnType<typeof setInterval> | null = null;
/** Bumped on leaving /live: a camera granted after that belongs to nobody and is stopped. */
let liveGeneration = 0;
/** The name whose bio and picture are in the boxes, and the bio as it was loaded for it. */
let profileName = '';
let loadedBio = '';

function setPhase(phase: PublishPhase, message: string) {
  store.set(publishPhaseAtom, phase);
  store.set(publishMessageAtom, message);
}

export function setStreamName(raw: string) {
  store.set(streamNameAtom, cleanName(raw));
}

/** The name box settled (blur, enter): the chat moves to that room and its profile is loaded. */
export function commitStreamName(): Promise<void> {
  const name = store.get(streamNameAtom);
  store.set(chatRoomAtom, isValidName(name) ? name : '');
  return loadProfile();
}

/**
 * The name box on arrival: a login streams as itself, anyone else starts from
 * the name in the header (and can still type another).
 */
export async function enterLivePage(): Promise<void> {
  await loadMe();
  const me = store.get(meAtom);
  if (me) setStreamName(me);
  else if (!store.get(streamNameAtom)) setStreamName(store.get(nickAtom));
  await commitStreamName();
}

export async function startCamera(): Promise<void> {
  if (store.get(cameraAtom)) return;
  // the permission prompt can outlive the page. an answer that comes after leaving is not ours to keep.
  const generation = liveGeneration;
  const video = { width: { ideal: 1280 }, height: { ideal: 720 } };
  let camera: MediaStream;
  try {
    camera = await navigator.mediaDevices.getUserMedia({ video, audio: true });
  } catch (err) {
    if (generation !== liveGeneration) return;
    if (err instanceof DOMException && err.name === 'NotAllowedError') {
      setPhase('camera-blocked', 'camera blocked');
      return;
    }
    // no mic, or the mic is busy. go without sound.
    try {
      camera = await navigator.mediaDevices.getUserMedia({ video, audio: false });
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
  setPhase('camera-ready', camera.getAudioTracks().length ? 'camera ready' : 'camera ready, no mic');
}

export async function goLive(): Promise<void> {
  const camera = store.get(cameraAtom);
  const name = store.get(streamNameAtom);
  if (!camera || !isValidName(name) || pc) return;
  store.set(chatRoomAtom, name); // the chat is the room of the name you go live as
  setPhase('starting', 'starting');

  // Everything below belongs to this attempt. If stop runs meanwhile, `pc` changes and the
  // attempt must quietly give up.
  const myPc = new RTCPeerConnection();
  const myAbort = new AbortController();
  const gone = () => pc !== myPc;
  pc = myPc;
  abort = myAbort;
  myPc.onconnectionstatechange = () => {
    if (!gone()) onConnection(myPc.connectionState);
  };

  for (const track of camera.getTracks()) {
    const init: RTCRtpTransceiverInit = { direction: 'sendonly', streams: [camera] };
    if (track.kind === 'video') {
      track.contentHint = 'motion';
      init.sendEncodings = [{ maxBitrate: VIDEO_MAX_BITRATE }];
    }
    myPc.addTransceiver(track, init);
  }

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
    ws = await connectRelay({ role: 'publish', name, pc: myPc, session: owner.session, token: owner.token, url: grant.url, signal: myAbort.signal });
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
 * Stop button, failures, leaving. The camera preview keeps running. A failure is reported,
 * with the peer's stats, before the peer is closed below; `report: false` for one that is
 * not ours (the api said no, the name is taken).
 */
export function stopLive(message = 'stopped', phase: PublishPhase = 'stopped', { report = phase === 'failed' }: { report?: boolean } = {}) {
  if (report) void reportPeerFailure('publish', store.get(streamNameAtom), message, pc);
  if (heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
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
  const owner = store.get(ownerAtom);
  if (owner) {
    api.stop(owner).catch(() => undefined);
    store.set(ownerAtom, null);
  }
  setPhase(phase, message);
}

/** Tab closed. sendBeacon survives page teardown, fetch may not. */
export function stopOnLeave() {
  const owner = store.get(ownerAtom);
  if (!owner) return;
  api.stopBeacon(owner);
  store.set(ownerAtom, null);
  stopLive();
}

/** Navigated away inside the app: end the stream and release the camera. */
export function leaveLivePage() {
  liveGeneration++;
  stopLive();
  store
    .get(cameraAtom)
    ?.getTracks()
    .forEach((track) => track.stop());
  store.set(cameraAtom, null);
  setPhase('camera-off', 'camera off');
  profileName = loadedBio = '';
  store.set(bioDraftAtom, '');
  store.set(bioStatusAtom, '');
  store.set(myAvatarAtom, null);
  store.set(avatarStatusAtom, '');
}

/**
 * The bio and picture saved under the name in the box. A bio being typed is left alone.
 * Another name than last time starts clean: the old name's saved bio and picture go, so
 * they cannot be saved under the new one. Text the person typed is theirs and stays.
 */
export async function loadProfile(): Promise<void> {
  const name = store.get(streamNameAtom);
  if (!isValidName(name)) return;
  if (profileName && profileName !== name) {
    if (store.get(bioDraftAtom) === loadedBio) store.set(bioDraftAtom, '');
    store.set(bioStatusAtom, '');
    store.set(myAvatarAtom, null);
  }
  profileName = name;
  loadedBio = '';
  try {
    const me = await api.streamer(name);
    if (store.get(streamNameAtom) !== name) return; // the box moved on while the api was answering
    if (!store.get(bioDraftAtom)) store.set(bioDraftAtom, (loadedBio = me.bio ?? ''));
    store.set(myAvatarAtom, me.avatar ?? null);
  } catch {
    // nothing saved yet
  }
}

/**
 * Any picture file to a square jpeg, in the browser, before it goes anywhere: the middle
 * square of it, scaled to AVATAR_PX. So the api never has to decode an image.
 */
async function squareJpeg(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = AVATAR_PX;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no canvas');
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, AVATAR_PX, AVATAR_PX);
  bitmap.close();
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('could not make a jpeg'))), 'image/jpeg', AVATAR_QUALITY);
  });
}

export async function saveAvatar(file: File): Promise<void> {
  const name = store.get(streamNameAtom);
  if (!isValidName(name)) {
    store.set(avatarStatusAtom, 'type a name first');
    return;
  }
  store.set(avatarStatusAtom, 'saving');
  try {
    const saved = await api.saveAvatar(name, await squareJpeg(file));
    store.set(myAvatarAtom, saved.avatar);
    store.set(avatarStatusAtom, 'saved');
  } catch (err) {
    store.set(avatarStatusAtom, `not saved: ${messageOf(err)}`);
  }
}

export async function removeAvatar(): Promise<void> {
  const name = store.get(streamNameAtom);
  if (!isValidName(name)) return;
  try {
    await api.deleteAvatar(name);
    store.set(myAvatarAtom, null);
    store.set(avatarStatusAtom, 'removed');
  } catch (err) {
    store.set(avatarStatusAtom, `not removed: ${messageOf(err)}`);
  }
}

export async function saveBio(): Promise<void> {
  const name = store.get(streamNameAtom);
  if (!isValidName(name)) {
    store.set(bioStatusAtom, 'type a name first');
    return;
  }
  try {
    await api.saveBio(name, store.get(bioDraftAtom).trim());
    store.set(bioStatusAtom, 'saved');
  } catch (err) {
    store.set(bioStatusAtom, `not saved: ${messageOf(err)}`);
  }
}

export function copyWatchUrl() {
  const url = store.get(watchUrlAtom);
  if (url) navigator.clipboard?.writeText(url).catch(() => undefined);
}
