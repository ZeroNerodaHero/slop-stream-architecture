/**
 * Going live from the browser camera. State lives in atoms; the peer connection, socket and
 * timers are plain module handles because nothing renders from them. Every state change goes
 * through an action function here, so cause and effect sit in one place (no reactive effects).
 */

import { atom } from 'jotai';

import { api, type Owner, messageOf, statusOf } from '@/infra/api';
import { cleanName, isValidName } from '@/infra/names';
import { connectRelay, waitForIceGathering } from '@/infra/relay';
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
export const ownerAtom = atom<Owner | null>(null);
export const bioDraftAtom = atom('');
export const bioStatusAtom = atom('');

export const hasMicAtom = atom((get) => (get(cameraAtom)?.getAudioTracks().length ?? 0) > 0);
export const isPublishingAtom = atom((get) => BUSY_PHASES.includes(get(publishPhaseAtom)));
export const canStartAtom = atom((get) => get(cameraAtom) !== null && isValidName(get(streamNameAtom)) && !get(isPublishingAtom));
export const watchUrlAtom = atom((get) => {
  const owner = get(ownerAtom);
  return owner ? `${location.origin}/watch/${owner.name}` : null;
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

function setPhase(phase: PublishPhase, message: string) {
  store.set(publishPhaseAtom, phase);
  store.set(publishMessageAtom, message);
}

export function setStreamName(raw: string) {
  store.set(streamNameAtom, cleanName(raw));
}

export async function startCamera(): Promise<void> {
  if (store.get(cameraAtom)) return;
  const video = { width: { ideal: 1280 }, height: { ideal: 720 } };
  let camera: MediaStream;
  try {
    camera = await navigator.mediaDevices.getUserMedia({ video, audio: true });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'NotAllowedError') {
      setPhase('camera-blocked', 'camera blocked');
      return;
    }
    // no mic, or the mic is busy. go without sound.
    try {
      camera = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    } catch {
      setPhase('no-camera', 'no camera');
      return;
    }
  }
  store.set(cameraAtom, camera);
  setPhase('camera-ready', camera.getAudioTracks().length ? 'camera ready' : 'camera ready, no mic');
}

export async function goLive(): Promise<void> {
  const camera = store.get(cameraAtom);
  const name = store.get(streamNameAtom);
  if (!camera || !isValidName(name) || pc) return;
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
    ws = await connectRelay({ role: 'publish', name, pc: myPc, url: grant.url, signal: myAbort.signal });
  } catch (err) {
    if (gone()) return;
    const taken = statusOf(err) === 409 || messageOf(err) === 'someone is already live';
    stopLive(taken ? 'someone is already live with that name' : `failed: ${messageOf(err)}`, 'failed');
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

/** Stop button, failures, leaving. The camera preview keeps running. */
export function stopLive(message = 'stopped', phase: PublishPhase = 'stopped') {
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
  stopLive();
  store
    .get(cameraAtom)
    ?.getTracks()
    .forEach((track) => track.stop());
  store.set(cameraAtom, null);
  setPhase('camera-off', 'camera off');
  store.set(bioDraftAtom, '');
  store.set(bioStatusAtom, '');
}

export async function loadBio(): Promise<void> {
  const name = store.get(streamNameAtom);
  if (!isValidName(name) || store.get(bioDraftAtom)) return;
  try {
    const me = await api.streamer(name);
    store.set(bioDraftAtom, me.bio ?? '');
  } catch {
    // no bio yet
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
