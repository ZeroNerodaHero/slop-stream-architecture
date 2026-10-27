/**
 * Watching one stream. Same shape as publish-atoms: atoms for what renders, module handles
 * for the peer connection and socket, action functions for every transition.
 */

import { atom } from 'jotai';

import { api, messageOf } from '@/infra/api';
import { presenceChanged } from '@/infra/atoms/presence-atoms';
import { eventsPhaseAtom, onEvents, unwatchPresence, watchPresence } from '@/infra/events';
import { isValidName } from '@/infra/names';
import {
  connectRelay,
  isVideoLayer,
  type Layer,
  type RelayReply,
  type Scene,
  sceneOf,
  SCREEN_SLOTS,
  type SlotInfo,
  slotsOf,
  viewersOf,
  waitForIceGathering
} from '@/infra/relay';
import { reportPeerFailure } from '@/infra/report';
import { cleanSocials, EMPTY_SOCIALS, type Socials } from '@/infra/socials';
import { type StreamStats, startSampler } from '@/infra/stream-stats';
import { store } from '@/infra/store';
import type { Tone } from '@/shared-components/StatusLine';

export type WatchPhase = 'loading' | 'waiting' | 'connecting' | 'connected' | 'watching' | 'reconnecting' | 'failed' | 'bad-name';

/**
 * Nothing is polled for. A page waiting on a name is told `live` on the events socket the
 * moment video has the publisher (docs/status.md), and starts then. The one timer is for an
 * ask that failed (the api did not answer; the video socket dropped under a stream with no
 * `ended`): asked again, later each time it fails again, up to RETRY_MAX_MS. A clean "not
 * live" sets no timer at all.
 */
const RETRY_FIRST_MS = 3000;
const RETRY_MAX_MS = 60_000;
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
/** Their offline picture's upload time: shown where the player would be while they are not live. `null`: none. */
export const offlineAtom = atom<number | null>(null);
/** The line they wrote for under the word while not live. '' for none. */
export const offlineNoteAtom = atom('');
/** How many follow them (docs/follows.md). `null` until the grant says, or on an older api. */
export const followersAtom = atom<number | null>(null);
/** Where else to find them (docs/socials.md), as the grant said, cleaned. The empty document until it has, and on an older api. */
export const socialsAtom = atom<Socials>(EMPTY_SOCIALS);
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
/** The streamer's scene (relay.ts), as the slots frame says. `null` until it has, and from a streamer that never sends one (the dummy, an older page). */
export const sceneAtom = atom<Scene | null>(null);
/** The slot the watcher clicked to see big, if any. `null`: the streamer's frame, or the rule below. */
export const chosenSlotAtom = atom<number | null>(null);
/** The layers there is a picture for: a video layer needs its slot live, a picture is always there. */
const shownLayersAtom = atom<Layer[]>((get) => {
  const live = get(slotsAtom);
  return (get(sceneAtom)?.layers ?? []).filter((l) => !isVideoLayer(l) || live.some((s) => s.slot === l.slot));
});
/** The slot the streamer's own frame has at the bottom, live. `null` from a scene with no video in it, and from no scene. */
const sceneSlotAtom = atom((get) => get(shownLayersAtom).find(isVideoLayer)?.slot ?? null);
/**
 * The watcher pulled one picture out of the frame: a live slot they clicked that is not the one
 * the streamer has at the bottom. While it holds, that picture is the whole frame and the scene
 * is set aside; the streamer's own slot in the tiles, or the `the stream` tile, puts it back.
 */
const focusedSlotAtom = atom((get) => {
  const chosen = get(chosenSlotAtom);
  if (chosen === null || chosen === get(sceneSlotAtom)) return null;
  return get(slotsAtom).some((s) => s.slot === chosen) ? chosen : null;
});
/**
 * Which slot the big `<video>` plays: the one pulled out of the frame, else the streamer's own,
 * else the rule every stream had before scenes (the first live screen, else the camera: a dummy,
 * a page that sends no scene). `null` when the streamer's frame has no video in it at all (a
 * picture alone): the big `<video>` carries the sound and nothing else then.
 */
export const primarySlotAtom = atom<number | null>((get) => {
  const focused = get(focusedSlotAtom);
  if (focused !== null) return focused;
  const theirs = get(sceneSlotAtom);
  if (theirs !== null) return theirs;
  if (get(shownLayersAtom).length > 0) return null;
  return get(slotsAtom).find((s) => s.kind === 'screen')?.slot ?? 0;
});
/**
 * The frame to draw, bottom first: the streamer's layers, the big `<video>` standing in for the
 * bottom video layer (`SceneView`). Nothing while a picture is pulled out of the frame: that one
 * is shown plain. The watch page and the corner player both draw this.
 */
export const watchLayersAtom = atom<Layer[]>((get) => (get(focusedSlotAtom) !== null ? [] : get(shownLayersAtom)));
/**
 * The tiles under the video: every live slot the frame does not show. While a picture is pulled
 * out of the frame, every other live slot, so the streamer's own is one click away.
 */
export const tilesAtom = atom((get) => {
  const primary = get(primarySlotAtom);
  const composed = get(focusedSlotAtom) === null;
  const inFrame = new Set(
    get(shownLayersAtom)
      .filter(isVideoLayer)
      .map((l) => l.slot)
  );
  return get(slotsAtom).filter((s) => s.slot !== primary && !(composed && inFrame.has(s.slot)));
});
/** One more tile, first, while a picture is pulled out of a frame the tiles cannot give back (a scene of pictures alone has no slot of the streamer's to click). */
export const sceneTileAtom = atom((get) => get(focusedSlotAtom) !== null && get(sceneSlotAtom) === null && get(shownLayersAtom).length > 0);
/** Each slot's own stream, picture only, for its tile. Bound imperatively (`VideoFrame`). */
const slotStreamAtoms = Array.from({ length: VIDEO_SLOTS }, () => atom<MediaStream | null>(null));
/** For a slot there is no section for (never, every slot number is checked against VIDEO_SLOTS first): an atom that stays empty. */
const spareStreamAtom = atom<MediaStream | null>(null);
export const slotStreamAtom = (slot: number) => slotStreamAtoms[slot] ?? spareStreamAtom;
export const mutedAtom = atom(true);
/** The arriving picture, sampled from the peer once a second while a watch is up. Null with no peer. */
export const watchStatsAtom = atom<StreamStats | null>(null);

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
 * close, on a page load, when the stream is ended by hand, and when you go live (publish-atoms'
 * `goLive` ends the stream in the corner: yours takes its place). Never on while your own
 * stream has the corner (`publishPipAtom`): one corner player at a time, so the watch page
 * disables its button then.
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
/** Failed asks in a row, for the backoff. Back to 0 once an ask is answered or frames play. */
let failures = 0;
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
 * Nobody is live right now, and the api said so. Nothing is asked again: the page waits to be
 * told. `live` comes pushed the moment video has the publisher; if that frame is missed, the
 * word `streaming` on the gateway's next recheck says the same (both land in `streamerLive`).
 */
function waitForLive(message: string) {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  failures = 0;
  setPhase('waiting', message);
}

/**
 * The ask itself failed, so there is nothing to be told by: no answer from the api, or the
 * video socket dropped under the stream without an `ended`. Asked again, later each time, up
 * to RETRY_MAX_MS. The profile shows meanwhile, with the reason in the status line.
 */
function retryLater(message: string) {
  setPhase('waiting', message);
  if (retryTimer) clearTimeout(retryTimer);
  const wait = Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** failures);
  failures++;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void start(store.get(watchNameAtom));
  }, wait);
}

/**
 * The name on screen went live, as pushed: a `live` frame, or its word turning `streaming`.
 * Start now. Only from `waiting`; anything else is under way, or over by hand. The word can
 * run a beat ahead of video (the key is set at go-live, the fact published when video has the
 * publisher): that ask is answered not live, and the `live` that follows starts this over.
 */
export function streamerLive(name: string) {
  if (name !== store.get(watchNameAtom)) return;
  if (store.get(watchPhaseAtom) !== 'waiting') return;
  void start(name);
}

// the pushes (docs/status.md): `live`, and the word `streaming` (the gateway re-derives every
// watched word every 30s, so a `live` the page missed is still told), start a waiting page now.
// `ended` is the video socket's to say. the events socket coming back after a gap re-asks
// `watch` while waiting: a `live` published in the gap was missed, and the ask is the pull that
// makes the push true (docs/transition.md)
let linkWasOpen = false;
onEvents((event) => {
  if (event.type === 'live') streamerLive(event.name);
  else if (event.type === 'presence') {
    if (event.presence === 'streaming') streamerLive(event.name);
  } else if (event.type === 'renamed') {
    // the name on screen became another: the page moves there (docs/ids.md)
    if (event.name === store.get(watchNameAtom) && isValidName(event.to)) store.set(watchRenamedToAtom, event.to);
  } else if (event.type === 'link' && event.phase === 'open') {
    if (linkWasOpen && store.get(watchPhaseAtom) === 'waiting') void start(store.get(watchNameAtom));
    linkWasOpen = true;
  }
});

/** Phases from which arriving on the page starts over even with picture in picture on: nothing is under way. */
const RESTART_PHASES: readonly WatchPhase[] = ['failed', 'bad-name'];

/**
 * The watch page mounted for `name`. Back on the page of the stream picture in picture kept
 * alive, there is nothing to start: the page's <video> binds to the same MediaStream. That is
 * read off the phase, not off the handles: a grant in flight (`loading`) or a wait for the
 * streamer (`waiting`, nothing but the events socket's subscription) has no peer, yet is under
 * way all the same.
 */
export async function watch(name: string): Promise<void> {
  if (store.get(pipAtom) && name === store.get(watchNameAtom) && !RESTART_PHASES.includes(store.get(watchPhaseAtom))) return;
  await start(name);
}

/** One attempt at `name`, whatever was going on before. A push, the backoff timer and the retry button come here directly. */
async function start(name: string): Promise<void> {
  teardown();
  const mine = ++attempt;
  const before = store.get(watchNameAtom);
  if (before && before !== name) {
    unwatchPresence(before);
    failures = 0;
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
    if (mine === attempt) retryLater('cannot reach the server. retrying');
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
  store.set(offlineAtom, grant.offline ?? null);
  store.set(offlineNoteAtom, grant.offline_note ?? '');
  store.set(followersAtom, typeof grant.followers === 'number' ? grant.followers : null);
  store.set(socialsAtom, cleanSocials(grant.socials));
  // the word beside the name: the socket's while it is open (it is told on `watch` and on every
  // change, and a grant answered a beat behind a push must not undo the push); the grant's otherwise
  if (grant.presence && store.get(eventsPhaseAtom) !== 'open') presenceChanged(name, grant.presence);
  if (!grant.live) {
    waitForLive('not live yet');
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
        // a layer on a slot this page has no section for has no picture: dropped, like the slot would be
        const scene = sceneOf(msg);
        store.set(sceneAtom, scene && { layers: scene.layers.filter((l) => !isVideoLayer(l) || l.slot < VIDEO_SLOTS) });
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
      // the api's word ran ahead of video (a word, a key with no publisher yet): the `live`
      // pushed when video has them starts this over
      teardown();
      waitForLive('not live yet');
    } else fail(`failed: ${messageOf(err)}`, myPc);
    return;
  }

  // the streamer leaving is an `ended` frame (onMessage). a close with none is not that: video
  // restarted under everyone, or this link dropped. then the ask is made again, backing off
  ws.onclose = dropped;
  if (pc === myPc) startWatchStats();

  connectTimer = setTimeout(() => {
    if (pc === myPc && myPc.connectionState !== 'connected') fail('no video. udp blocked?', myPc);
  }, NO_VIDEO_AFTER_MS);
}

/** The streamer left (video said `ended`). A restart is pushed like any start. */
function ended() {
  teardown();
  waitForLive('ended');
}

/** The video socket closed under the stream with no `ended`: ask again, since nothing else will say whether they are still live. */
function dropped() {
  teardown();
  retryLater('connection lost. retrying');
}

/** A tile clicked, or a video layer of the frame: that slot goes big, for as long as it is live. */
export function pickSlot(slot: number) {
  store.set(chosenSlotAtom, slot);
  showPrimary();
}

/** The `the stream` tile: the watcher's choice is dropped and the streamer's frame is back. */
export function clearChoice() {
  store.set(chosenSlotAtom, null);
  showPrimary();
}

/** The main stream's picture is the primary slot's track, whichever that is now; none with a frame of pictures alone. */
function showPrimary() {
  if (!primary) return;
  const slot = store.get(primarySlotAtom);
  const want = slot === null ? undefined : videoTracks[slot];
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
  failures = 0;
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
  store.set(sceneAtom, null);
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
  failures = 0;
  const name = store.get(watchNameAtom);
  if (name) unwatchPresence(name);
  store.set(pipAtom, false);
  store.set(watchNameAtom, '');
  store.set(mutedAtom, true);
  store.set(bioAtom, '');
  store.set(verifiedAtom, false);
  store.set(avatarAtom, null);
  store.set(offlineAtom, null);
  store.set(offlineNoteAtom, '');
  store.set(followersAtom, null);
  store.set(socialsAtom, EMPTY_SOCIALS);
  setPhase('loading', 'loading');
}
