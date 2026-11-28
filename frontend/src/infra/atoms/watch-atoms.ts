import { atom } from 'jotai';

import { api, type GroupBadge, messageOf, type WatchGrant } from '@/infra/api';
import { askLatest, type ChatLine, takeHistoryFrom, warmChat } from '@/infra/atoms/chat-atoms';
import { presenceChanged, presencesAtom } from '@/infra/atoms/presence-atoms';
import { pipAtom, socialsAtom, watchNameAtom, watchPhaseAtom, type WatchPhase, watchWelcomeAtom } from '@/infra/atoms/watch-state';
import { welcomeOf } from '@/infra/atoms/welcome-atoms';
import { trackSocket } from '@/infra/debug/sockets';
import { eventsEverOpened, eventsPhaseAtom, onEvents, unwatchPresence, watchPresence } from '@/infra/events';
import { isValidName } from '@/infra/names';
import { onPrefetch, prefetch, PREFETCH_TTL_MS, takePrefetched } from '@/infra/prefetch';
import { connectRelay, isVideoLayer, type Layer, type RelayReply, relayUrl, type Scene, sceneOf, SCREEN_SLOTS, type SlotInfo, slotsOf, viewersOf } from '@/infra/relay';
import { reportPeerFailure } from '@/infra/report';
import { cleanSocials, EMPTY_SOCIALS } from '@/infra/socials';
import { type StreamStats, startSampler } from '@/infra/stream-stats';
import { store } from '@/infra/store';
import { debug } from '@/infra/debug-flag';
import { watchBeat } from '@/infra/watch-beat';
import { currentView, onViewChange, ViewSender, viewFrame } from '@/infra/watch-view';
import { perfBegin, perfMark } from '@/infra/watch-perf';
import type { Tone } from '@/shared-components/StatusLine';

const RETRY_FIRST_MS = 3000;
const RETRY_MAX_MS = 60_000;
const NO_VIDEO_AFTER_MS = 10000;
const RETRY_PHASES: readonly WatchPhase[] = ['failed'];
const SOUND_PHASES: readonly WatchPhase[] = ['watching', 'reconnecting'];
const VIDEO_SLOTS = 1 + SCREEN_SLOTS;

export const watchRenamedToAtom = atom<string | null>(null);
export const watchMessageAtom = atom('loading');
export const NOT_LIVE_MESSAGE = 'not live yet';
export const bioAtom = atom('');
export const verifiedAtom = atom(false);
export const oauthVerifiedAtom = atom(false);
export const avatarAtom = atom<number | null>(null);
export const offlineAtom = atom<number | null>(null);
export const offlineNoteAtom = atom('');
export const followersAtom = atom<number | null>(null);
export const joinedAtom = atom<string | null>(null);
export const watchBadgeAtom = atom<GroupBadge | null>(null);
export const canModerateAtom = atom(false);
export const remoteStreamAtom = atom<MediaStream | null>(null);
export const slotsAtom = atom<SlotInfo[]>([]);
export const watchViewersAtom = atom<number | null>(null);
export const sceneAtom = atom<Scene | null>(null);
export const chosenSlotAtom = atom<number | null>(null);
const shownLayersAtom = atom<Layer[]>((get) => {
  const live = get(slotsAtom);
  return (get(sceneAtom)?.layers ?? []).filter((l) => !isVideoLayer(l) || live.some((s) => s.slot === l.slot));
});
const sceneSlotAtom = atom((get) => get(shownLayersAtom).find(isVideoLayer)?.slot ?? null);
const focusedSlotAtom = atom((get) => {
  const chosen = get(chosenSlotAtom);
  if (chosen === null || chosen === get(sceneSlotAtom)) return null;
  return get(slotsAtom).some((s) => s.slot === chosen) ? chosen : null;
});
export const primarySlotAtom = atom<number | null>((get) => {
  const focused = get(focusedSlotAtom);
  if (focused !== null) return focused;
  const theirs = get(sceneSlotAtom);
  if (theirs !== null) return theirs;
  if (get(shownLayersAtom).length > 0) return null;
  return get(slotsAtom).find((s) => s.kind === 'screen')?.slot ?? 0;
});
export const watchLayersAtom = atom<Layer[]>((get) => (get(focusedSlotAtom) !== null ? [] : get(shownLayersAtom)));
export const watchBlankAtom = atom((get) => get(focusedSlotAtom) === null && get(sceneAtom)?.layers.length === 0);
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
export const sceneTileAtom = atom((get) => get(focusedSlotAtom) !== null && get(sceneSlotAtom) === null && get(shownLayersAtom).length > 0);
const slotStreamAtoms = Array.from({ length: VIDEO_SLOTS }, () => atom<MediaStream | null>(null));
const spareStreamAtom = atom<MediaStream | null>(null);
export const slotStreamAtom = (slot: number) => slotStreamAtoms[slot] ?? spareStreamAtom;
export const mutedAtom = atom(true);
export const watchStatsAtom = atom<StreamStats | null>(null);

export function slotLabel(slot: SlotInfo): string {
  return slot.label || slot.kind;
}
export const volumeAtom = atom(1);
export const dialAtom = atom((get) => (get(mutedAtom) ? 0 : get(volumeAtom)));
export const needsTapAtom = atom(false);

export const canRetryAtom = atom((get) => RETRY_PHASES.includes(get(watchPhaseAtom)));
export const canHearAtom = atom((get) => SOUND_PHASES.includes(get(watchPhaseAtom)));
export const watchToneAtom = atom<Tone>((get) => {
  const phase = get(watchPhaseAtom);
  if (phase === 'watching') return 'live';
  return phase === 'failed' || phase === 'bad-name' ? 'bad' : 'neutral';
});

const WS_PATH = '/ws';

interface Warm {
  name: string;
  url: string;
  pc: RTCPeerConnection;
  videoTransceivers: RTCRtpTransceiver[];
  offer: Promise<void>;
  ws: WebSocket;
  born: number;
}

const WARM_MAX_MS = 8000;

function makeWarm(name: string, url = WS_PATH): Warm {
  const warmPc = new RTCPeerConnection();
  const videoTransceivers = Array.from({ length: VIDEO_SLOTS }, () => warmPc.addTransceiver('video', { direction: 'recvonly' }));
  warmPc.addTransceiver('audio', { direction: 'recvonly' });
  perfMark('peer');
  const offer = warmPc.createOffer().then((o) => warmPc.setLocalDescription(o));
  void offer.then(
    () => perfMark('offer'),
    () => undefined
  );
  const ws = trackSocket('video', new WebSocket(relayUrl(url)), url);
  ws.addEventListener('open', () => perfMark('ws-open'), { once: true });
  return { name, url, pc: warmPc, videoTransceivers, offer, ws, born: performance.now() };
}

function closeWarm(w: Warm) {
  w.ws.close();
  w.pc.close();
}

const isFresh = (w: Warm) => w.pc.signalingState !== 'closed' && w.ws.readyState <= WebSocket.OPEN && performance.now() - w.born < WARM_MAX_MS;

let pressed: { warm: Warm; timer: ReturnType<typeof setTimeout> } | null = null;

function dropPressed() {
  if (!pressed) return;
  clearTimeout(pressed.timer);
  closeWarm(pressed.warm);
  pressed = null;
}

function warmOnPress(name: string) {
  if (pressed?.warm.name === name && isFresh(pressed.warm)) return;
  dropPressed();
  perfBegin('press', name);
  const warm = makeWarm(name);
  pressed = { warm, timer: setTimeout(dropPressed, PREFETCH_TTL_MS) };
}

function takePressed(name: string): Warm | null {
  if (!pressed) return null;
  const { warm, timer } = pressed;
  clearTimeout(timer);
  pressed = null;
  if (warm.name === name && isFresh(warm)) return warm;
  closeWarm(warm);
  return null;
}

interface BootWatch {
  name: string;
  born: number;
  grant: Promise<Response>;
  pc: RTCPeerConnection;
  videoTransceivers: RTCRtpTransceiver[];
  offer: Promise<void>;
  offerAt?: number;
  ws: WebSocket;
  wsAt?: number;
}

declare global {
  interface Window {
    __bootWatch?: BootWatch;
  }
}

function takeBoot(name: string): { warm: Warm; grant: Promise<WatchGrant> } | null {
  const boot = window.__bootWatch;
  if (!boot) return null;
  delete window.__bootWatch;
  const warm: Warm = { name: boot.name, url: WS_PATH, pc: boot.pc, videoTransceivers: boot.videoTransceivers, offer: boot.offer, ws: boot.ws, born: boot.born };
  if (boot.name !== name || !isFresh(warm)) {
    closeWarm(warm);
    return null;
  }
  trackSocket('video', boot.ws, WS_PATH);
  perfBegin('boot', name, boot.born);
  perfMark('peer', boot.born);
  if (boot.offerAt !== undefined) perfMark('offer', boot.offerAt);
  else
    void boot.offer.then(
      () => perfMark('offer'),
      () => undefined
    );
  if (boot.wsAt !== undefined) perfMark('ws-open', boot.wsAt);
  else boot.ws.addEventListener('open', () => perfMark('ws-open'), { once: true });
  return { warm, grant: api.watchAsked(name, boot.grant) };
}

const knownNotLive = (name: string) => {
  const word = store.get(presencesAtom).get(name);
  return word !== undefined && word !== 'streaming';
};

let pc: RTCPeerConnection | null = null;
let early: Warm | null = null;
let stopStats: (() => void) | null = null;
let ws: WebSocket | null = null;
let connectTimer: ReturnType<typeof setTimeout> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let failures = 0;
let attempt = 0;
let played = false;
let videoTracks: (MediaStreamTrack | undefined)[] = [];
let primary: MediaStream | null = null;
let viewSender: ViewSender | null = null;

onViewChange((view) => viewSender?.update(view));

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
  watchBeat(store.get(watchNameAtom), SOUND_PHASES.includes(phase));
}

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

function waitForLive(message: string) {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  failures = 0;
  setPhase('waiting', message);
}

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

export function streamerLive(name: string) {
  if (name !== store.get(watchNameAtom)) return;
  if (store.get(watchPhaseAtom) !== 'waiting') return;
  void start(name);
}

let linkWasOpen = eventsEverOpened();
onEvents((event) => {
  if (event.type === 'live') streamerLive(event.name);
  else if (event.type === 'presence') {
    if (event.presence === 'streaming') streamerLive(event.name);
  } else if (event.type === 'renamed') {
    if (event.name === store.get(watchNameAtom) && isValidName(event.to)) store.set(watchRenamedToAtom, event.to);
  } else if (event.type === 'link' && event.phase === 'open') {
    if (linkWasOpen && store.get(watchPhaseAtom) === 'waiting') void start(store.get(watchNameAtom));
    linkWasOpen = true;
  }
});

const RESTART_PHASES: readonly WatchPhase[] = ['failed', 'bad-name'];

export async function watch(name: string): Promise<void> {
  if (keptInCorner(name)) return;
  await start(name);
}

function keptInCorner(name: string): boolean {
  return store.get(pipAtom) && name === store.get(watchNameAtom) && !RESTART_PHASES.includes(store.get(watchPhaseAtom));
}

const grantKey = (name: string) => `watch:${name}`;

const chatKey = (name: string) => `chat:${name}`;

takeHistoryFrom((name) => takePrefetched<ChatLine[]>(chatKey(name))?.answer ?? null);

onPrefetch('watch', (name) => {
  if (keptInCorner(name)) return;
  prefetch(chatKey(name), null, 'drop', () => askLatest(name));
  warmChat(name);
  prefetch(grantKey(name), name, 'drop', () => api.watch(name));
  if (!knownNotLive(name)) warmOnPress(name);
});

async function start(name: string): Promise<void> {
  teardown();
  const mine = ++attempt;
  const before = store.get(watchNameAtom);
  if (before && before !== name) {
    unwatchPresence(before);
    failures = 0;
    store.set(watchBadgeAtom, null);
  }
  store.set(watchNameAtom, name);
  if (!isValidName(name)) {
    setPhase('bad-name', 'bad name');
    return;
  }
  watchPresence(name);
  setPhase('loading', 'loading');

  const fromPress = takePressed(name);
  const boot = fromPress ? null : takeBoot(name);
  if (fromPress || boot) perfMark('start');
  else perfBegin('start', name);
  early = fromPress ?? boot?.warm ?? (knownNotLive(name) ? null : makeWarm(name));
  const asked = takePrefetched<WatchGrant>(grantKey(name))?.answer ?? boot?.grant ?? api.watch(name);
  const ahead = early && handshake(name, early);

  let grant;
  try {
    grant = await asked;
  } catch {
    if (mine === attempt) {
      teardown();
      retryLater('cannot reach the server. retrying');
    }
    return;
  }
  if (mine !== attempt) return;
  perfMark('grant');
  if (grant.name && grant.name !== name && isValidName(grant.name)) {
    teardown();
    store.set(watchRenamedToAtom, grant.name);
    return;
  }
  store.set(bioAtom, grant.bio ?? '');
  store.set(verifiedAtom, grant.verified === true);
  store.set(oauthVerifiedAtom, grant.oauth_verified === true);
  store.set(avatarAtom, grant.avatar ?? null);
  store.set(offlineAtom, grant.offline ?? null);
  store.set(offlineNoteAtom, grant.offline_note ?? '');
  store.set(watchWelcomeAtom, welcomeOf(grant));
  store.set(followersAtom, typeof grant.followers === 'number' ? grant.followers : null);
  store.set(socialsAtom, cleanSocials(grant.socials));
  store.set(joinedAtom, typeof grant.joined_at === 'string' && !Number.isNaN(Date.parse(grant.joined_at)) ? grant.joined_at : null);
  store.set(watchBadgeAtom, grant.badge ?? null);
  store.set(canModerateAtom, grant.can_moderate === true);
  if (grant.presence && store.get(eventsPhaseAtom) !== 'open') presenceChanged(name, grant.presence);
  if (!grant.live) {
    teardown();
    waitForLive(NOT_LIVE_MESSAGE);
    return;
  }

  let shake = ahead && !ahead.failed() && ahead.warm.url === grant.url ? ahead : null;
  if (!shake) {
    if (ahead) teardown();
    shake = handshake(name, (early = makeWarm(name, grant.url)));
  }
  await settle(shake);
}

interface Shake {
  warm: Warm;
  done: Promise<WebSocket | Error>;
  failed: () => boolean;
  show: () => void;
}

function handshake(name: string, warm: Warm): Shake {
  const myPc = warm.pc;
  pc = myPc;
  const { videoTransceivers } = warm;
  const main = new MediaStream();
  primary = main;
  let shown = false;
  let sent = false;
  let outcome: WebSocket | Error | null = null;
  const heldTracks: RTCTrackEvent[] = [];
  const heldMessages: RelayReply[] = [];

  const onTrack = (e: RTCTrackEvent) => {
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
  const onState = () => {
    if (pc !== myPc) return;
    const state = myPc.connectionState;
    if (state === 'connected') {
      if (connectTimer) clearTimeout(connectTimer);
      if (played) setPhase('watching', 'watching');
      else setPhase('connected', 'connected, waiting for video');
    } else if (state === 'disconnected') setPhase('reconnecting', 'reconnecting');
    else if (state === 'failed') fail('connection failed', myPc);
  };
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
        const scene = sceneOf(msg);
        store.set(sceneAtom, scene && { layers: scene.layers.filter((l) => !isVideoLayer(l) || l.slot < VIDEO_SLOTS) });
        showPrimary();
      }
    }
  };
  const connecting = () => {
    if (shown && sent && pc === myPc) setPhase('connecting', 'connecting');
  };

  myPc.ontrack = (e) => {
    if (shown) onTrack(e);
    else heldTracks.push(e);
  };
  myPc.onconnectionstatechange = () => {
    if (pc !== myPc) return;
    if (myPc.connectionState === 'connected' && !played) perfMark('ice-connected');
    if (shown) onState();
  };

  const done = warm.offer
    .then(() => {
      if (pc !== myPc) throw new Error('cancelled');
      sent = true;
      connecting();
      return connectRelay({
        role: 'watch',
        name,
        pc: myPc,
        url: warm.url,
        socket: warm.ws,
        onPhase: (phase) => {
          if (phase !== 'ws-open') perfMark(phase);
        },
        onMessage: (msg) => {
          if (shown) onMessage(msg);
          else heldMessages.push(msg);
        }
      });
    })
    .then(
      (socket) => (outcome = socket),
      (err) => (outcome = new Error(messageOf(err)))
    );

  return {
    warm,
    done,
    failed: () => outcome instanceof Error,
    show: () => {
      shown = true;
      connecting();
      heldTracks.splice(0).forEach(onTrack);
      heldMessages.splice(0).forEach(onMessage);
      onState();
    }
  };
}

async function settle(shake: Shake) {
  const myPc = shake.warm.pc;
  shake.show();
  const socket = await shake.done;
  if (pc !== myPc) return;
  if (socket instanceof Error) {
    if (socket.message === 'not live') {
      teardown();
      waitForLive(NOT_LIVE_MESSAGE);
    } else fail(`failed: ${socket.message}`, myPc);
    return;
  }
  if (early === shake.warm) early = null;
  ws = socket;
  ws.onclose = dropped;
  if (socket.readyState === WebSocket.CLOSED) {
    dropped();
    return;
  }
  viewSender = new ViewSender((view) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(viewFrame(view));
  });
  viewSender.update(currentView());
  startWatchStats();

  connectTimer = setTimeout(() => {
    if (pc === myPc && myPc.connectionState !== 'connected') fail('no video', myPc);
  }, NO_VIDEO_AFTER_MS);
}

function dropEarly() {
  if (!early) return;
  closeWarm(early);
  early = null;
}

function ended() {
  teardown();
  waitForLive('ended');
}

function dropped() {
  teardown();
  retryLater('connection lost. retrying');
}

export function pickSlot(slot: number) {
  store.set(chosenSlotAtom, slot);
  showPrimary();
}

export function clearChoice() {
  store.set(chosenSlotAtom, null);
  showPrimary();
}

function showPrimary() {
  if (!primary) return;
  const slot = store.get(primarySlotAtom);
  const want = slot === null ? undefined : videoTracks[slot];
  for (const track of primary.getVideoTracks()) {
    if (track !== want) primary.removeTrack(track);
  }
  if (want && !primary.getVideoTracks().includes(want)) primary.addTrack(want);
}

export function retry() {
  void start(store.get(watchNameAtom));
}

export function markPlaying(e?: { currentTarget: EventTarget | null }) {
  if (!pc) return;
  if (!played && debug.timings) markFirstFrame(e?.currentTarget);
  played = true;
  failures = 0;
  store.set(needsTapAtom, false);
  setPhase('watching', 'watching');
}

function markFirstFrame(video: EventTarget | null | undefined) {
  if (!(video instanceof HTMLVideoElement) || typeof video.requestVideoFrameCallback !== 'function') {
    perfMark('first-frame', undefined, true);
    return;
  }
  perfMark('first-frame');
  const mine = attempt;
  video.requestVideoFrameCallback((now) => {
    if (mine === attempt) perfMark('first-frame-decoded', now);
  });
}

export function markAutoplayBlocked() {
  if (pc) store.set(needsTapAtom, true);
}

export function markUnmuted() {
  store.set(mutedAtom, false);
  store.set(needsTapAtom, false);
}

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

export function settleDial(from: number) {
  if (store.get(mutedAtom) && from > 0) store.set(volumeAtom, from);
}

export function startPip() {
  store.set(pipAtom, true);
}

export function teardown() {
  stopWatchStats();
  if (connectTimer) clearTimeout(connectTimer);
  if (retryTimer) clearTimeout(retryTimer);
  connectTimer = retryTimer = null;
  played = false;
  viewSender?.reset();
  viewSender = null;
  store.set(needsTapAtom, false);
  dropEarly();
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

export function leaveWatchPage() {
  if (store.get(pipAtom) && store.get(watchNameAtom) && store.get(watchPhaseAtom) !== 'bad-name') return;
  endWatch();
}

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
  store.set(oauthVerifiedAtom, false);
  store.set(avatarAtom, null);
  store.set(offlineAtom, null);
  store.set(offlineNoteAtom, '');
  store.set(watchWelcomeAtom, null);
  store.set(followersAtom, null);
  store.set(socialsAtom, EMPTY_SOCIALS);
  store.set(joinedAtom, null);
  store.set(watchBadgeAtom, null);
  store.set(canModerateAtom, false);
  setPhase('loading', 'loading');
}
