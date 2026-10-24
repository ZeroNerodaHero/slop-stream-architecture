/**
 * Watching one stream. Same shape as publish-atoms: atoms for what renders, module handles
 * for the peer connection and socket, action functions for every transition.
 */

import { atom } from 'jotai';

import { api, messageOf } from '@/infra/api';
import { isValidName } from '@/infra/names';
import { connectRelay, parseRelayMessage, waitForIceGathering } from '@/infra/relay';
import { reportPeerFailure } from '@/infra/report';
import { store } from '@/infra/store';
import type { Tone } from '@/shared-components/StatusLine';

export type WatchPhase = 'loading' | 'waiting' | 'connecting' | 'connected' | 'watching' | 'reconnecting' | 'failed' | 'bad-name';

const NOT_LIVE_RETRY_MS = 5000;
const NO_VIDEO_AFTER_MS = 10000;
const RETRY_PHASES: readonly WatchPhase[] = ['waiting', 'failed'];
/** The sound button stays through a blip: the frames come back on their own. */
const SOUND_PHASES: readonly WatchPhase[] = ['watching', 'reconnecting'];

export const watchNameAtom = atom('');
export const watchPhaseAtom = atom<WatchPhase>('loading');
export const watchMessageAtom = atom('loading');
export const bioAtom = atom('');
/** The name has an account, so this really is them. */
export const verifiedAtom = atom(false);
/** Their picture's upload time (the `?v=` of its url). `null`: none. */
export const avatarAtom = atom<number | null>(null);
export const remoteStreamAtom = atom<MediaStream | null>(null);
export const mutedAtom = atom(true);
/**
 * The level the sound plays at, and comes back at after a mute: always above zero (zero on the
 * dial is a mute, see `setVolume`). On whichever <video> is playing, the page's or the
 * MiniPlayer's, and kept across streams for the visit.
 */
export const volumeAtom = atom(1);
/** What the dial shows: 0 while muted, the level otherwise. So the mute button drops it to 0 and unmute brings it back. */
export const dialAtom = atom((get) => (get(mutedAtom) ? 0 : get(volumeAtom)));
/** Autoplay was refused (low power mode, strict settings). One tap fixes it. */
export const needsTapAtom = atom(false);
/**
 * Picture in picture: the watch page's button turns it on and goes home; from then on leaving
 * the watch page keeps the stream alive and the MiniPlayer shows it in a corner of every other
 * page. Off, leaving ends it. Stays on when another stream replaces this one; off again on
 * close, on a page load, and when the stream is ended by hand.
 */
export const pipAtom = atom(false);

export const canRetryAtom = atom((get) => RETRY_PHASES.includes(get(watchPhaseAtom)));
/** Frames are playing (a blip included), so there is sound to mute, unmute and turn up or down. */
export const canHearAtom = atom((get) => SOUND_PHASES.includes(get(watchPhaseAtom)));
export const showUnmuteAtom = atom((get) => get(needsTapAtom) || (get(canHearAtom) && get(mutedAtom)));
export const watchToneAtom = atom<Tone>((get) => {
  const phase = get(watchPhaseAtom);
  if (phase === 'watching') return 'live';
  return phase === 'failed' || phase === 'bad-name' ? 'bad' : 'neutral';
});

let pc: RTCPeerConnection | null = null;
let ws: WebSocket | null = null;
let connectTimer: ReturnType<typeof setTimeout> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * Which call of `watch` is the current one. Before the peer exists there is no `pc` to compare
 * against, so a grant landing after the page was left (or after a newer call) is told apart by this.
 */
let attempt = 0;
/** The <video> has played frames of this attempt: a reconnect goes straight back to `watching`. */
let played = false;

function setPhase(phase: WatchPhase, message: string) {
  store.set(watchPhaseAtom, phase);
  store.set(watchMessageAtom, message);
}

/**
 * A failure ends the attempt: one report, with the peer's stats, and the status stays on it
 * with the retry button (nothing retries from `failed` on its own). The handles are detached
 * first so nothing of this attempt fires again: the server dropping the socket after its own
 * ice timeout would otherwise read as `ended` and start the next attempt, and chrome's ice
 * going failed after our 10s would report a second time. The peer is closed once its stats
 * are read (300ms at most), unless a retry or leaving got there first.
 */
function fail(message: string, myPc: RTCPeerConnection) {
  if (pc !== myPc) return;
  if (connectTimer) clearTimeout(connectTimer);
  connectTimer = null;
  if (ws) ws.onmessage = ws.onclose = null;
  myPc.onconnectionstatechange = null;
  const reported = reportPeerFailure('watch', store.get(watchNameAtom), message, myPc);
  setPhase('failed', message);
  void reported.finally(() => {
    if (pc === myPc) teardown();
  });
}

/** Nobody is live right now. Check again in a bit. */
function waitForStreamer(message: string) {
  setPhase('waiting', message);
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = setTimeout(() => void watch(store.get(watchNameAtom)), NOT_LIVE_RETRY_MS);
}

export async function watch(name: string): Promise<void> {
  // back on the page of the stream picture in picture kept alive: nothing to start, the page's
  // <video> binds to the same MediaStream. (a stream that is still being waited for counts too.)
  if (store.get(pipAtom) && name === store.get(watchNameAtom) && (pc || retryTimer)) return;
  teardown();
  const mine = ++attempt;
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
    if (mine === attempt) waitForStreamer('cannot reach the server. retrying');
    return;
  }
  // left the page, or a newer call took over, while the api was answering
  if (mine !== attempt) return;
  store.set(bioAtom, grant.bio ?? '');
  store.set(verifiedAtom, grant.verified === true);
  store.set(avatarAtom, grant.avatar ?? null);
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
      // back from a blip: the frames resume on their own, the <video> fires no second `playing`
      if (played) setPhase('watching', 'watching');
      else setPhase('connected', 'connected, waiting for video');
    } else if (state === 'disconnected') setPhase('reconnecting', 'reconnecting');
    else if (state === 'failed') fail('connection failed. udp blocked?', myPc);
  };

  try {
    await myPc.setLocalDescription(await myPc.createOffer());
    await waitForIceGathering(myPc, 1000);
    if (pc !== myPc) return;
    setPhase('connecting', 'connecting');
    ws = await connectRelay({ role: 'watch', name, pc: myPc, url: grant.url });
  } catch (err) {
    if (pc !== myPc) return; // retry or leaving happened meanwhile
    if (messageOf(err) === 'not live') {
      teardown();
      waitForStreamer('not live yet. checking');
    } else fail(`failed: ${messageOf(err)}`, myPc);
    return;
  }

  ws.onmessage = (e) => {
    if (parseRelayMessage(e.data)?.event === 'ended') ended();
  };
  ws.onclose = ended;

  connectTimer = setTimeout(() => {
    if (pc === myPc && myPc.connectionState !== 'connected') fail('no video. udp blocked?', myPc);
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
  played = true;
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

/** Inside the click, so the browser allows sound. The page's <video> and the MiniPlayer's both use it. */
export function unmuteVideo(el: HTMLVideoElement | null) {
  markUnmuted();
  if (el) {
    el.muted = false;
    el.play().catch(() => undefined);
  }
}

export function muteVideo(el: HTMLVideoElement | null) {
  store.set(mutedAtom, true);
  if (el) el.muted = true;
}

/**
 * The dial moved. Zero is a mute, the level kept for the way back; anything above it is the
 * level, with the sound on (up from zero while muted is an unmute: nobody turns a dial up to
 * hear nothing).
 */
export function setVolume(el: HTMLVideoElement | null, volume: number) {
  const level = Math.min(1, Math.max(0, volume));
  if (level === 0) {
    muteVideo(el);
    return;
  }
  store.set(volumeAtom, level);
  if (el) el.volume = level;
  if (store.get(mutedAtom)) unmuteVideo(el);
}

/**
 * The dial let go, `from` being where it was when it was taken. A drag that ended on zero went
 * through every level on the way down and the last hair above zero is what `volumeAtom` holds;
 * `from` is what unmute should bring back.
 */
export function settleDial(from: number) {
  if (store.get(mutedAtom) && from > 0) store.set(volumeAtom, from);
}

/** From here on, leaving the watch page keeps the stream in the corner. The only way back off is the MiniPlayer's ×. */
export function startPip() {
  store.set(pipAtom, true);
}

export function teardown() {
  if (connectTimer) clearTimeout(connectTimer);
  if (retryTimer) clearTimeout(retryTimer);
  connectTimer = retryTimer = null;
  played = false;
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

/**
 * Navigated away inside the app. With picture in picture on, the stream stays up and moves to
 * the MiniPlayer (a grant in flight lands as usual); otherwise everything ends.
 */
export function leaveWatchPage() {
  if (store.get(pipAtom) && store.get(watchNameAtom) && store.get(watchPhaseAtom) !== 'bad-name') return;
  endWatch();
}

/** Everything off and forgotten: leaving without picture in picture, or closing the MiniPlayer. A grant still in flight is dropped when it lands. */
export function endWatch() {
  attempt++;
  teardown();
  store.set(pipAtom, false);
  store.set(watchNameAtom, '');
  store.set(mutedAtom, true);
  store.set(bioAtom, '');
  store.set(verifiedAtom, false);
  store.set(avatarAtom, null);
  setPhase('loading', 'loading');
}
