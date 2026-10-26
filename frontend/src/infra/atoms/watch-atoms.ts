/**
 * Watching one stream. Same shape as publish-atoms: atoms for what renders, module handles
 * for the peer connection and socket, action functions for every transition.
 */

import { atom } from 'jotai';

import { api, messageOf } from '@/infra/api';
import { presenceChanged } from '@/infra/atoms/presence-atoms';
import { eventsPhaseAtom, onEvents, unwatchPresence, watchPresence } from '@/infra/events';
import { isValidName } from '@/infra/names';
import { connectRelay, type RelayReply, SCREEN_SLOTS, type SlotInfo, slotsOf, viewersOf, waitForIceGathering } from '@/infra/relay';
import { reportPeerFailure } from '@/infra/report';
import { type StreamStats, startSampler } from '@/infra/stream-stats';
import { store } from '@/infra/store';
import type { Tone } from '@/shared-components/StatusLine';

export type WatchPhase = 'loading' | 'waiting' | 'connecting' | 'connected' | 'watching' | 'reconnecting' | 'failed' | 'bad-name';

const NOT_LIVE_RETRY_MS = 5000;
/**
 * The retry while the events socket is open and watching this name: `live` arrives pushed, so
 * the poll is only the fallback behind it (docs/transition.md: slowed, never removed. an api that
 * was unreachable is only ever recovered by a pull).
 */
const LINKED_RETRY_MS = 60_000;
const NO_VIDEO_AFTER_MS = 10000;
/** Only a real failure offers the button: not live is the profile, and the page asks again on its own. */
const RETRY_PHASES: readonly WatchPhase[] = ['failed'];
/** The sound button stays through a blip: the frames come back on their own. */
const SOUND_PHASES: readonly WatchPhase[] = ['watching', 'reconnecting'];
/** The video sections asked for: the camera and the screens, the same count the publisher offers. */
const VIDEO_SLOTS = 1 + SCREEN_SLOTS;

export const watchNameAtom = atom('');
/**
 * The name this page should be on instead: the one asked for was renamed (the grant said so,
 * or a `renamed` frame did). The page navigates there and clears it; this module has no router.
 * See docs/ids.md.
 */
export const watchRenamedToAtom = atom<string | null>(null);
export const watchPhaseAtom = atom<WatchPhase>('loading');
export const watchMessageAtom = atom('loading');
export const bioAtom = atom('');
/** The name has an account, so this really is them. */
export const verifiedAtom = atom(false);
/** Their picture's upload time (the `?v=` of its url). `null`: none. */
export const avatarAtom = atom<number | null>(null);
/** How many follow them (docs/follows.md). `null` until the grant says, or on an older api. */
export const followersAtom = atom<number | null>(null);
/**
 * The main <video>'s stream: the sound and the big picture. One MediaStream for the attempt
 * whose video track is swapped as the big slot changes, so the element never rebinds and the
 * sound never skips.
 */
export const remoteStreamAtom = atom<MediaStream | null>(null);
/** The video slots the streamer says are live, as video tells us. Empty until it has. */
export const slotsAtom = atom<SlotInfo[]>([]);
/** How many are watching, as video tells this peer. `null` until it has, and after it ends. */
export const watchViewersAtom = atom<number | null>(null);
/** The slot the watcher clicked to see big, if any. `null`: the rule below. */
export const chosenSlotAtom = atom<number | null>(null);
/** Which slot is big: the one chosen while it is live, else the first screen, else the camera. */
export const primarySlotAtom = atom((get) => primaryOf(get(slotsAtom), get(chosenSlotAtom)));
/** The other live slots, the small tiles under the video. */
export const tilesAtom = atom((get) => {
  const primary = get(primarySlotAtom);
  return get(slotsAtom).filter((s) => s.slot !== primary);
});
/** Each slot's own stream, picture only, for its tile. Bound imperatively (`VideoFrame`). */
const slotStreamAtoms = Array.from({ length: VIDEO_SLOTS }, () => atom<MediaStream | null>(null));
/** For a slot there is no section for (never, every slot number is checked against VIDEO_SLOTS first): an atom that stays empty. */
const spareStreamAtom = atom<MediaStream | null>(null);
export const slotStreamAtom = (slot: number) => slotStreamAtoms[slot] ?? spareStreamAtom;
export const mutedAtom = atom(true);
/** The arriving picture, sampled from the peer once a second while a watch is up. Null with no peer. */
export const watchStatsAtom = atom<StreamStats | null>(null);

function primaryOf(slots: SlotInfo[], chosen: number | null): number {
  if (chosen !== null && slots.some((s) => s.slot === chosen)) return chosen;
  return slots.find((s) => s.kind === 'screen')?.slot ?? 0;
}

/** What a tile says: the streamer's label, else the kind, and the camera is "camera". */
export function slotLabel(slot: SlotInfo): string {
  return slot.label || slot.kind;
}
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
export const watchToneAtom = atom<Tone>((get) => {
  const phase = get(watchPhaseAtom);
  if (phase === 'watching') return 'live';
  return phase === 'failed' || phase === 'bad-name' ? 'bad' : 'neutral';
});

let pc: RTCPeerConnection | null = null;
let stopStats: (() => void) | null = null;
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
/** The attempt's tracks by video slot, and the stream the main <video> plays (see `remoteStreamAtom`). */
let videoTracks: (MediaStreamTrack | undefined)[] = [];
let primary: MediaStream | null = null;

/** The big picture's track, named the way the tiles are, so a shared screen is not just "video". */
function labelOfWatchTrack(trackId: string): string | undefined {
  for (const slot of store.get(slotsAtom)) {
    if (store.get(slotStreamAtom(slot.slot))?.getVideoTracks()[0]?.id === trackId) return slotLabel(slot);
  }
  return undefined;
}

function startWatchStats() {
  stopWatchStats();
  stopStats = startSampler({
    role: 'watch',
    pc: () => pc,
    videoTrackId: () => primary?.getVideoTracks()[0]?.id,
    audioMuted: () => primary?.getAudioTracks()[0]?.muted ?? false,
    capBps: () => null,
    labelOf: labelOfWatchTrack,
    write: (stats) => store.set(watchStatsAtom, stats)
  });
}

function stopWatchStats() {
  stopStats?.();
  stopStats = null;
}

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

/**
 * `live` was pushed for the name on screen this recently. The api says live at go-live, a beat
 * before video has the publisher, so a grant that says not live right after is video catching
 * up: the retry is quick for the api's own grace, then back to the pushed cadence.
 */
let toldLiveAt = 0;
const TOLD_LIVE_RETRY_MS = 2000;
const TOLD_LIVE_WINDOW_MS = 20_000;

/** Nobody is live right now. Check again in a bit: soon when the poll is all there is, rarely when `live` will be pushed. */
function waitForStreamer(message: string) {
  setPhase('waiting', message);
  if (retryTimer) clearTimeout(retryTimer);
  const toldLive = Date.now() - toldLiveAt < TOLD_LIVE_WINDOW_MS;
  const wait = toldLive ? TOLD_LIVE_RETRY_MS : store.get(eventsPhaseAtom) === 'open' ? LINKED_RETRY_MS : NOT_LIVE_RETRY_MS;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void start(store.get(watchNameAtom));
  }, wait);
}

/** A pushed `live` for the name on screen: start now, not at the retry. Only from `waiting`; anything else is under way, or over by hand. */
export function streamerLive(name: string) {
  if (name !== store.get(watchNameAtom)) return;
  toldLiveAt = Date.now();
  if (store.get(watchPhaseAtom) !== 'waiting') return;
  void start(name);
}

// the pushes: `live` starts a waiting page now; `ended` ends the quick retry (the video socket is
// what ends the stream). the socket opening for the first time while the page already waits (the
// grant beat it) slows the retry to the pushed cadence; coming back after a gap it re-asks `watch`
// (a `live` published in the gap was missed)
let linkWasOpen = false;
onEvents((event) => {
  if (event.type === 'live') streamerLive(event.name);
  else if (event.type === 'ended') {
    if (event.name === store.get(watchNameAtom)) toldLiveAt = 0;
  } else if (event.type === 'renamed') {
    // the name on screen became another: the page moves there (docs/ids.md)
    if (event.name === store.get(watchNameAtom) && isValidName(event.to)) store.set(watchRenamedToAtom, event.to);
  } else if (event.type === 'link' && event.phase === 'open') {
    if (store.get(watchPhaseAtom) === 'waiting') {
      if (linkWasOpen) void start(store.get(watchNameAtom));
      else waitForStreamer(store.get(watchMessageAtom));
    }
    linkWasOpen = true;
  }
});

/** Phases from which arriving on the page starts over even with picture in picture on: nothing is under way. */
const RESTART_PHASES: readonly WatchPhase[] = ['failed', 'bad-name'];

/**
 * The watch page mounted for `name`. Back on the page of the stream picture in picture kept
 * alive, there is nothing to start: the page's <video> binds to the same MediaStream. That is
 * read off the phase, not off the handles: a grant in flight (`loading`) or a wait for the
 * streamer (`waiting`) has no peer and, between the timer firing and the grant landing, no
 * timer either, yet is under way all the same.
 */
export async function watch(name: string): Promise<void> {
  if (store.get(pipAtom) && name === store.get(watchNameAtom) && !RESTART_PHASES.includes(store.get(watchPhaseAtom))) return;
  await start(name);
}

/** One attempt at `name`, whatever was going on before. The timer and the retry button come here directly. */
async function start(name: string): Promise<void> {
  teardown();
  const mine = ++attempt;
  const before = store.get(watchNameAtom);
  if (before && before !== name) {
    unwatchPresence(before);
    toldLiveAt = 0;
  }
  store.set(watchNameAtom, name);
  if (!isValidName(name)) {
    setPhase('bad-name', 'bad name');
    return;
  }
  // their word beside the name, and `live` when it comes, from the events socket (docs/status.md)
  watchPresence(name);
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
  // a grant for another name: the one asked for was renamed and is held for the hold's length.
  // the page moves there, and that mount starts over under the right name
  if (grant.name && grant.name !== name && isValidName(grant.name)) {
    store.set(watchRenamedToAtom, grant.name);
    return;
  }
  store.set(bioAtom, grant.bio ?? '');
  store.set(verifiedAtom, grant.verified === true);
  store.set(avatarAtom, grant.avatar ?? null);
  store.set(followersAtom, typeof grant.followers === 'number' ? grant.followers : null);
  // the word beside the name: the socket's while it is open (it is told on `watch` and on every
  // change, and a grant answered a beat behind a push must not undo the push); the grant's otherwise
  if (grant.presence && store.get(eventsPhaseAtom) !== 'open') presenceChanged(name, grant.presence);
  if (!grant.live) {
    waitForStreamer('not live yet. checking');
    return;
  }

  const myPc = new RTCPeerConnection();
  pc = myPc;
  // One section per video slot the publisher may fill, in its order: video binds its slots
  // to them in order, so the i-th one here is video slot i there (0 the camera). A slot with
  // nothing in it yet is a track that stays quiet until the streamer shares a screen.
  const videoTransceivers = Array.from({ length: VIDEO_SLOTS }, () => myPc.addTransceiver('video', { direction: 'recvonly' }));
  myPc.addTransceiver('audio', { direction: 'recvonly' });

  const main = new MediaStream();
  primary = main;
  myPc.ontrack = (e) => {
    if (e.track.kind === 'audio') main.addTrack(e.track);
    else {
      const slot = videoTransceivers.indexOf(e.transceiver);
      if (slot < 0) return;
      videoTracks[slot] = e.track;
      store.set(slotStreamAtom(slot), new MediaStream([e.track]));
    }
    showPrimary();
    if (store.get(remoteStreamAtom) !== main) store.set(remoteStreamAtom, main);
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

  // the frames after the answer, this attempt's only: `ended`, and what is live in which slot
  const onMessage = (msg: RelayReply) => {
    if (pc !== myPc) return;
    if (msg.error) fail(msg.error, myPc);
    else if (msg.event === 'ended') ended();
    else if (msg.event === 'viewers') store.set(watchViewersAtom, viewersOf(msg));
    else if (msg.event === 'slots') {
      const slots = slotsOf(msg);
      if (slots) {
        store.set(
          slotsAtom,
          slots.filter((s) => s.slot < VIDEO_SLOTS)
        );
        showPrimary();
      }
    }
  };

  try {
    await myPc.setLocalDescription(await myPc.createOffer());
    await waitForIceGathering(myPc, 1000);
    if (pc !== myPc) return;
    setPhase('connecting', 'connecting');
    ws = await connectRelay({ role: 'watch', name, pc: myPc, url: grant.url, onMessage });
  } catch (err) {
    if (pc !== myPc) return; // retry or leaving happened meanwhile
    if (messageOf(err) === 'not live') {
      teardown();
      waitForStreamer('not live yet. checking');
    } else fail(`failed: ${messageOf(err)}`, myPc);
    return;
  }

  ws.onclose = ended;
  if (pc === myPc) startWatchStats();

  connectTimer = setTimeout(() => {
    if (pc === myPc && myPc.connectionState !== 'connected') fail('no video. udp blocked?', myPc);
  }, NO_VIDEO_AFTER_MS);
}

/** The streamer left. Keep checking so a restart shows up on its own. */
function ended() {
  teardown();
  waitForStreamer('ended. checking for a restart');
}

/** A tile clicked: that slot goes big, for as long as it is live. */
export function pickSlot(slot: number) {
  store.set(chosenSlotAtom, slot);
  showPrimary();
}

/** The main stream's picture is the primary slot's track, whichever that is now. */
function showPrimary() {
  if (!primary) return;
  const want = videoTracks[store.get(primarySlotAtom)];
  for (const track of primary.getVideoTracks()) {
    if (track !== want) primary.removeTrack(track);
  }
  if (want && !primary.getVideoTracks().includes(want)) primary.addTrack(want);
}

/** The button: an explicit start-over, never the "back on the page of a kept stream" case `watch` keeps. */
export function retry() {
  void start(store.get(watchNameAtom));
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
  stopWatchStats();
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
  videoTracks = [];
  primary = null;
  store.set(remoteStreamAtom, null);
  for (const streamAtom of slotStreamAtoms) store.set(streamAtom, null);
  store.set(slotsAtom, []);
  store.set(chosenSlotAtom, null);
  store.set(watchViewersAtom, null);
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
  const name = store.get(watchNameAtom);
  if (name) unwatchPresence(name);
  store.set(pipAtom, false);
  store.set(watchNameAtom, '');
  store.set(mutedAtom, true);
  store.set(bioAtom, '');
  store.set(verifiedAtom, false);
  store.set(avatarAtom, null);
  store.set(followersAtom, null);
  setPhase('loading', 'loading');
}
