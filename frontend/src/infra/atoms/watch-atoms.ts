/**
 * Watching one stream. Same shape as publish-atoms: atoms for what renders, module handles
 * for the peer connection and socket, action functions for every transition.
 */

import { atom } from 'jotai';

import { api, messageOf } from '@/infra/api';
import { isValidName } from '@/infra/names';
import { connectRelay, parseRelayMessage, waitForIceGathering } from '@/infra/relay';
import { store } from '@/infra/store';
import type { Tone } from '@/shared-components/StatusLine';

export type WatchPhase = 'loading' | 'waiting' | 'connecting' | 'connected' | 'watching' | 'reconnecting' | 'failed' | 'bad-name';

const NOT_LIVE_RETRY_MS = 5000;
const NO_VIDEO_AFTER_MS = 10000;
const RETRY_PHASES: readonly WatchPhase[] = ['waiting', 'failed'];

export const watchNameAtom = atom('');
export const watchPhaseAtom = atom<WatchPhase>('loading');
export const watchMessageAtom = atom('loading');
export const bioAtom = atom('');
export const remoteStreamAtom = atom<MediaStream | null>(null);
export const mutedAtom = atom(true);
/** Autoplay was refused (low power mode, strict settings). One tap fixes it. */
export const needsTapAtom = atom(false);

export const canRetryAtom = atom((get) => RETRY_PHASES.includes(get(watchPhaseAtom)));
export const showUnmuteAtom = atom((get) => get(needsTapAtom) || (get(watchPhaseAtom) === 'watching' && get(mutedAtom)));
export const watchToneAtom = atom<Tone>((get) => {
  const phase = get(watchPhaseAtom);
  if (phase === 'watching') return 'live';
  return phase === 'failed' || phase === 'bad-name' ? 'bad' : 'neutral';
});

let pc: RTCPeerConnection | null = null;
let ws: WebSocket | null = null;
let connectTimer: ReturnType<typeof setTimeout> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

function setPhase(phase: WatchPhase, message: string) {
  store.set(watchPhaseAtom, phase);
  store.set(watchMessageAtom, message);
}

/** Nobody is live right now. Check again in a bit. */
function waitForStreamer(message: string) {
  setPhase('waiting', message);
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = setTimeout(() => void watch(store.get(watchNameAtom)), NOT_LIVE_RETRY_MS);
}

export async function watch(name: string): Promise<void> {
  teardown();
  store.set(watchNameAtom, name);
  if (!isValidName(name)) {
    setPhase('bad-name', 'bad name');
    return;
  }
  setPhase('loading', 'loading');

  let grant;
  try {
    grant = await api.watch(name);
  } catch {
    waitForStreamer('cannot reach the server. retrying');
    return;
  }
  store.set(bioAtom, grant.bio ?? '');
  if (!grant.live) {
    waitForStreamer('not live yet. checking');
    return;
  }

  const myPc = new RTCPeerConnection();
  pc = myPc;
  myPc.addTransceiver('video', { direction: 'recvonly' });
  myPc.addTransceiver('audio', { direction: 'recvonly' });

  let remote: MediaStream | null = null;
  myPc.ontrack = (e) => {
    if (e.streams[0]) remote = e.streams[0];
    else (remote = remote ?? new MediaStream()).addTrack(e.track);
    if (store.get(remoteStreamAtom) !== remote) store.set(remoteStreamAtom, remote);
  };
  myPc.onconnectionstatechange = () => {
    if (pc !== myPc) return;
    const state = myPc.connectionState;
    if (state === 'connected') {
      if (connectTimer) clearTimeout(connectTimer);
      if (store.get(watchPhaseAtom) !== 'watching') setPhase('connected', 'connected, waiting for video');
    } else if (state === 'disconnected') setPhase('reconnecting', 'reconnecting');
    else if (state === 'failed') setPhase('failed', 'connection failed. udp blocked?');
  };

  try {
    await myPc.setLocalDescription(await myPc.createOffer());
    await waitForIceGathering(myPc, 1000);
    if (pc !== myPc) return;
    setPhase('connecting', 'connecting');
    ws = await connectRelay({ role: 'watch', name, pc: myPc, url: grant.url });
  } catch (err) {
    if (pc !== myPc) return; // retry or leaving happened meanwhile
    teardown();
    if (messageOf(err) === 'not live') waitForStreamer('not live yet. checking');
    else setPhase('failed', `failed: ${messageOf(err)}`);
    return;
  }

  ws.onmessage = (e) => {
    if (parseRelayMessage(e.data)?.event === 'ended') ended();
  };
  ws.onclose = ended;

  connectTimer = setTimeout(() => {
    if (pc === myPc && myPc.connectionState !== 'connected') setPhase('failed', 'no video. udp blocked?');
  }, NO_VIDEO_AFTER_MS);
}

/** The streamer left. Keep checking so a restart shows up on its own. */
function ended() {
  teardown();
  waitForStreamer('ended. checking for a restart');
}

export function retry() {
  void watch(store.get(watchNameAtom));
}

/** The <video> element started playing frames. */
export function markPlaying() {
  if (!pc) return;
  store.set(needsTapAtom, false);
  setPhase('watching', 'watching');
}

export function markAutoplayBlocked() {
  if (pc) store.set(needsTapAtom, true);
}

export function markUnmuted() {
  store.set(mutedAtom, false);
  store.set(needsTapAtom, false);
}

export function teardown() {
  if (connectTimer) clearTimeout(connectTimer);
  if (retryTimer) clearTimeout(retryTimer);
  connectTimer = retryTimer = null;
  store.set(needsTapAtom, false);
  if (ws) {
    ws.onmessage = ws.onclose = null;
    ws.close();
    ws = null;
  }
  if (pc) {
    pc.ontrack = pc.onconnectionstatechange = null;
    pc.close();
    pc = null;
  }
  store.set(remoteStreamAtom, null);
}

/** Navigated away inside the app. */
export function leaveWatchPage() {
  teardown();
  store.set(mutedAtom, true);
  store.set(bioAtom, '');
  setPhase('loading', 'loading');
}
