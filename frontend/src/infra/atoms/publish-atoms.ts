/**
 * Going live from the browser camera. State lives in atoms; the peer connection, socket and
 * timers are plain module handles because nothing renders from them. Every state change goes
 * through an action function here, so cause and effect sit in one place (no reactive effects).
 */

import { atom } from 'jotai';

import { ApiError, api, type Owner, messageOf, statusOf } from '@/infra/api';
import { loadMe, meAtom } from '@/infra/atoms/auth-atoms';
import { nickAtom } from '@/infra/atoms/chat-atoms';
import { record } from '@/infra/atoms/inspector-atoms';
import { cleanName, isValidName } from '@/infra/names';
import { connectRelay, SCREEN_SLOTS, type SlotInfo, viewersOf, waitForIceGathering } from '@/infra/relay';
import { reportPeerFailure } from '@/infra/report';
import { type StreamStats, startSampler } from '@/infra/stream-stats';
import { store } from '@/infra/store';
import type { Tone } from '@/shared-components/StatusLine';

export type PublishPhase = 'camera-off' | 'camera-blocked' | 'no-camera' | 'camera-ready' | 'starting' | 'connecting' | 'live' | 'reconnecting' | 'stopped' | 'failed';

const HEARTBEAT_MS = 15000;
const VIDEO_MAX_BITRATE = 2_500_000;
/** The camera while a screen is shared too: the screen is what people look at. */
const CAMERA_SHARING_BITRATE = 500_000;
/** All the shared screens together. One alone gets it all, three get a third each. */
const SCREENS_BITRATE = 3_000_000;
const BUSY_PHASES: readonly PublishPhase[] = ['starting', 'connecting', 'live', 'reconnecting'];
const BAD_PHASES: readonly PublishPhase[] = ['camera-blocked', 'no-camera', 'failed'];
/** Sharing a screen needs the socket, which exists once connected. */
const SHARE_PHASES: readonly PublishPhase[] = ['live', 'reconnecting'];

export const cameraAtom = atom<MediaStream | null>(null);
/** A screen being shared: which screen slot (0 to SCREEN_SLOTS-1) and what the browser called it. Its stream is in `screenStreamAtoms`. */
export interface SharedScreen {
  slot: number;
  label: string;
}
export const screensAtom = atom<SharedScreen[]>([]);
/** The shared screens' streams by screen slot, for the previews. A stream is not render data, so they are bound imperatively (`VideoFrame`). */
const screenStreamAtoms = Array.from({ length: SCREEN_SLOTS }, () => atom<MediaStream | null>(null));
/** For a screen slot that does not exist (never: slots come from `screenSenders`, which has SCREEN_SLOTS): an atom that stays empty. */
const spareStreamAtom = atom<MediaStream | null>(null);
export const screenStreamAtom = (slot: number) => screenStreamAtoms[slot] ?? spareStreamAtom;
/** Phones have no screen capture; there the button is not shown at all. */
export const screenShareSupported = typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function';
export const publishPhaseAtom = atom<PublishPhase>('camera-off');
/** The upload, sampled from the peer once a second while a publish is up. Null once it stops. */
export const publishStatsAtom = atom<StreamStats | null>(null);
export const publishMessageAtom = atom('camera off');
/** Always clean: lowercase, trimmed. Set through `setStreamName`. */
export const streamNameAtom = atom('');
/**
 * The room the streamer's own chat panel is in: the name box as last settled (blur, enter,
 * start), never the keystrokes. Following every keystroke would join a room per letter typed.
 */
export const chatRoomAtom = atom('');
export const ownerAtom = atom<Owner | null>(null);
/** How many are watching my stream, as video tells me. `null` while not live. */
export const liveViewersAtom = atom<number | null>(null);
export const bioDraftAtom = atom('');
export const bioStatusAtom = atom('');
/** The upload time of my picture (the `?v=` of its url). `null`: none. */
export const myAvatarAtom = atom<number | null>(null);
export const avatarStatusAtom = atom('');
/** Pictures on this name's home card, oldest first. Empty: home shows the camera. */
export const streamThumbsAtom = atom<number[]>([]);
export const thumbStatusAtom = atom('');

/** The picture the page sends: this big, as a jpeg of this quality. A few tens of kb. */
const AVATAR_PX = 256;
const AVATAR_QUALITY = 0.85;
const THUMB_W = 640;
const THUMB_H = 360;
const THUMB_QUALITY = 0.8;
const MAX_THUMBS = 6;

export const hasMicAtom = atom((get) => (get(cameraAtom)?.getAudioTracks().length ?? 0) > 0);
export const isPublishingAtom = atom((get) => BUSY_PHASES.includes(get(publishPhaseAtom)));
export const canStartAtom = atom((get) => get(cameraAtom) !== null && isValidName(get(streamNameAtom)) && !get(isPublishingAtom));
export const canShareScreenAtom = atom((get) => screenShareSupported && SHARE_PHASES.includes(get(publishPhaseAtom)) && get(screensAtom).length < SCREEN_SLOTS);
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
 * Picture in picture for the broadcast: the go live page's button turns it on and goes home;
 * from then on leaving the page keeps the stream (and the camera it sends) up, and the corner
 * player shows it on every other page, watching someone else included. Off again on the
 * corner's ×, on a page load, and when the page is left with nothing on air. A stream that
 * fails out there stays in the corner saying so, until × or a visit back to the page.
 */
export const publishPipAtom = atom(false);

let pc: RTCPeerConnection | null = null;
let stopStats: (() => void) | null = null;
let ws: WebSocket | null = null;
let abort: AbortController | null = null;
let heartbeat: ReturnType<typeof setInterval> | null = null;
/** The camera's video sender, and the SCREEN_SLOTS senders offered empty for screens (`screenSenders[i]` is screen slot i). */
let cameraSender: RTCRtpSender | null = null;
let screenSenders: RTCRtpSender[] = [];
/** Bumped on leaving /live: a camera granted after that belongs to nobody and is stopped. */
let liveGeneration = 0;
/** The name whose bio and picture are in the boxes, and the bio as it was loaded for it. */
let profileName = '';
let loadedBio = '';

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
      const track = store.get(cameraAtom)?.getAudioTracks()[0];
      return !!track && (track.muted || !track.enabled);
    },
    capBps: () => (store.get(screensAtom).length > 0 ? CAMERA_SHARING_BITRATE : VIDEO_MAX_BITRATE),
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

/** The name box settled (blur, enter): the chat moves to that room and its profile is loaded. */
export function commitStreamName(): Promise<void> {
  const name = store.get(streamNameAtom);
  store.set(chatRoomAtom, isValidName(name) ? name : '');
  return loadProfile();
}

/**
 * The name box on arrival: a login streams as itself, anyone else starts from
 * the name in the header (and can still type another). Back from the corner with the
 * stream still up there is nothing to fill in: the name, its room and its profile stayed.
 */
export async function enterLivePage(): Promise<void> {
  if (store.get(isPublishingAtom)) return;
  const generation = liveGeneration;
  await loadMe();
  if (generation !== liveGeneration) return; // left before the answer: nothing to fill in
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
  // the tab closing ends the stream wherever in the app it is kept (picture in picture takes it
  // off its page), so the listeners are the stream's, from here to `stopLive`, not the page's
  addEventListener('pagehide', stopOnLeave);
  addEventListener('beforeunload', stopOnLeave);
  myPc.onconnectionstatechange = () => {
    if (!gone()) onConnection(myPc.connectionState);
  };

  for (const track of camera.getTracks()) {
    const init: RTCRtpTransceiverInit = { direction: 'sendonly', streams: [camera] };
    if (track.kind === 'video') {
      track.contentHint = 'motion';
      init.sendEncodings = [{ maxBitrate: VIDEO_MAX_BITRATE }];
    }
    const transceiver = myPc.addTransceiver(track, init);
    if (track.kind === 'video') cameraSender = transceiver.sender;
  }
  // The screens' sections, offered now with nothing in them: a screen shared later goes
  // into one with `replaceTrack`, and nothing is renegotiated, with video or with anyone
  // watching. The camera is video slot 0 to everyone, these are 1 to SCREEN_SLOTS.
  screenSenders = Array.from(
    { length: SCREEN_SLOTS },
    () => myPc.addTransceiver('video', { direction: 'sendonly', sendEncodings: [{ maxBitrate: SCREENS_BITRATE }] }).sender
  );

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
  if (!gone()) startPublishStats();
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
 * The share button: the browser's picker, one screen (or window, or tab) per press, into the
 * first free screen slot. The picker closed without a choice is nothing. Sharp text over
 * smooth motion (`contentHint`), and no more than 1080p: a retina display would hand over
 * a picture too big for the bitrate. The browser's own "stop sharing" bar ends the track,
 * which is a stop here.
 */
export async function shareScreen(): Promise<void> {
  const myPc = pc;
  if (!myPc || !store.get(canShareScreenAtom)) return;
  let display: MediaStream;
  try {
    display = await navigator.mediaDevices.getDisplayMedia({ video: { width: { max: 1920 }, height: { max: 1080 }, frameRate: { max: 30 } }, audio: false });
  } catch {
    return;
  }
  const track = display.getVideoTracks()[0];
  const slot = screenSenders.findIndex((sender) => !sender.track);
  const sender = screenSenders[slot];
  // stopped, or every slot filled, while the picker was up
  if (pc !== myPc || !track || !sender) {
    display.getTracks().forEach((t) => t.stop());
    return;
  }
  track.contentHint = 'detail';
  try {
    await sender.replaceTrack(track);
  } catch {
    display.getTracks().forEach((t) => t.stop());
    return;
  }
  track.addEventListener('ended', () => stopScreen(slot));
  const surface = track.getSettings().displaySurface;
  const base = surface === 'window' ? 'window' : surface === 'browser' ? 'tab' : 'screen';
  const alike = store.get(screensAtom).filter((s) => s.label.startsWith(base)).length;
  const label = alike ? `${base} ${alike + 1}` : base;
  store.set(screenStreamAtom(slot), display);
  store.set(screensAtom, [...store.get(screensAtom), { slot, label }]);
  screensChanged();
}

/** The tile's stop, or the browser's "stop sharing" bar. The slot is emptied and free again. */
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
  // a closed peer refuses this; nothing is lost then, the stream is over
  screenSenders[slot]?.replaceTrack(null).catch(() => undefined);
  screensChanged();
}

function screensChanged() {
  announceSlots();
  void shareBitrate();
}

/** Tell video what is live where, for the watchers: the camera, then each shared screen. */
function announceSlots() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const screens: SlotInfo[] = store.get(screensAtom).map((s) => ({ slot: s.slot + 1, kind: 'screen', label: s.label }));
  const slots: SlotInfo[] = [{ slot: 0, kind: 'camera' }, ...screens];
  record('/ws', 'out', { slots });
  ws.send(JSON.stringify({ slots }));
}

/** The upload, divided: the camera steps back while a screen is shared, the screens share their part. */
async function shareBitrate() {
  const sharing = store.get(screensAtom).length;
  await capBitrate(cameraSender, sharing ? CAMERA_SHARING_BITRATE : VIDEO_MAX_BITRATE);
  for (const sender of screenSenders) {
    if (sender.track) await capBitrate(sender, Math.floor(SCREENS_BITRATE / Math.max(1, sharing)));
  }
}

async function capBitrate(sender: RTCRtpSender | null, maxBitrate: number) {
  if (!sender) return;
  const params = sender.getParameters();
  const encoding = params.encodings?.[0];
  if (!encoding) return; // not negotiated yet: the offer's cap holds
  encoding.maxBitrate = maxBitrate;
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
  removeEventListener('beforeunload', stopOnLeave);
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
  // the shared screens go with the stream (the camera preview stays)
  for (const streamAtom of screenStreamAtoms) {
    store
      .get(streamAtom)
      ?.getTracks()
      .forEach((track) => track.stop());
    store.set(streamAtom, null);
  }
  store.set(screensAtom, []);
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

/** Tab closed. sendBeacon survives page teardown, fetch may not. */
export function stopOnLeave() {
  const owner = store.get(ownerAtom);
  if (!owner) return;
  api.stopBeacon(owner);
  store.set(ownerAtom, null);
  stopLive();
}

/** From here on, leaving the go live page keeps the stream in the corner. The way back off is the corner's ×. */
export function startPublishPip() {
  store.set(publishPipAtom, true);
}

/**
 * Navigated away inside the app. With picture in picture on and a stream up (or on its way
 * up), everything stays as it is and the corner player takes over; otherwise the stream ends
 * and the camera is released.
 */
export function leaveLivePage() {
  if (store.get(publishPipAtom) && store.get(isPublishingAtom)) return;
  endLive();
}

/**
 * The corner's ×, and leaving the page without picture in picture: the stream ends, the camera
 * goes, the page's boxes are forgotten. What leaving used to do unconditionally.
 */
export function endLive() {
  store.set(publishPipAtom, false);
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
  store.set(streamThumbsAtom, []);
  store.set(thumbStatusAtom, '');
}

/**
 * The bio, picture and thumbnails saved under the name in the box. A bio being typed is left
 * alone. Another name than last time starts clean: the old name's saved bio, picture and
 * thumbnails go, so they cannot be saved under the new one. Text the person typed is theirs
 * and stays.
 */
export async function loadProfile(): Promise<void> {
  const name = store.get(streamNameAtom);
  if (!isValidName(name)) return;
  if (profileName !== name) {
    if (profileName) {
      // trimmed, as it was saved or loaded; the box may hold a trailing newline on top
      if (store.get(bioDraftAtom).trim() === loadedBio) store.set(bioDraftAtom, '');
      store.set(bioStatusAtom, '');
      store.set(myAvatarAtom, null);
      store.set(streamThumbsAtom, []);
      store.set(thumbStatusAtom, '');
    }
    // the same name again keeps what was loaded for it: a second commit (focus, blur) must not
    // forget the saved bio, or the next name change would take it for typed text and keep it
    profileName = name;
    loadedBio = '';
  }
  const generation = liveGeneration;
  try {
    const me = await api.streamer(name);
    // the box moved on, or the page was left, while the api was answering
    if (store.get(streamNameAtom) !== name || generation !== liveGeneration) return;
    loadedBio = me.bio ?? '';
    if (!store.get(bioDraftAtom)) store.set(bioDraftAtom, loadedBio);
    store.set(myAvatarAtom, me.avatar ?? null);
    store.set(streamThumbsAtom, me.thumbs ?? []);
  } catch {
    // nothing saved yet
  }
}

/**
 * The name box follows the identity when the user modal or the corner panel changes it (a
 * login, a logout, a new nick) while this page is open and nothing is on air: the page seeds
 * the box once, on arrival, and would otherwise go live under the old name while the chat
 * speaks as the new. With `was` (a nick change), only a box that still held the old nick
 * follows: a name typed by hand is theirs.
 */
export function followIdentityOnLivePage(was?: string) {
  if (location.pathname.replace(/\/$/, '') !== '/live' || store.get(isPublishingAtom)) return;
  const me = store.get(meAtom);
  const name = me ?? cleanName(store.get(nickAtom));
  const box = store.get(streamNameAtom);
  if (!isValidName(name) || box === name) return;
  if (was !== undefined && !me && box !== cleanName(was)) return;
  setStreamName(name);
  void commitStreamName();
}

/**
 * Any picture file to a square jpeg, in the browser, before it goes anywhere: the middle
 * square of it, scaled to AVATAR_PX. So the api never has to decode an image. The user
 * modal's profile tab makes its pictures the same way.
 */
export async function squareJpeg(file: File): Promise<Blob> {
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

/**
 * Any picture file to a 16:9 jpeg, in the browser, before it goes anywhere: the middle
 * of it, scaled to 640x360. So the api never has to decode an image.
 */
export async function wideJpeg(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  try {
    const target = 16 / 9;
    const ratio = bitmap.width / bitmap.height;
    let sx = 0;
    let sy = 0;
    let sw = bitmap.width;
    let sh = bitmap.height;
    if (ratio > target) {
      sw = bitmap.height * target;
      sx = (bitmap.width - sw) / 2;
    } else {
      sh = bitmap.width / target;
      sy = (bitmap.height - sh) / 2;
    }
    const canvas = document.createElement('canvas');
    canvas.width = THUMB_W;
    canvas.height = THUMB_H;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no canvas');
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, THUMB_W, THUMB_H);
    return await new Promise((resolve, reject) => {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('could not make a jpeg'))), 'image/jpeg', THUMB_QUALITY);
    });
  } finally {
    bitmap.close();
  }
}

export async function addStreamThumb(file: File): Promise<void> {
  const name = store.get(streamNameAtom);
  if (!isValidName(name)) {
    store.set(thumbStatusAtom, 'type a name first');
    return;
  }
  if (store.get(thumbStatusAtom) === 'saving') return;
  if (store.get(streamThumbsAtom).length >= MAX_THUMBS) {
    store.set(thumbStatusAtom, '6 pictures at most. remove one first');
    return;
  }
  store.set(thumbStatusAtom, 'saving');
  try {
    const saved = await api.saveStreamThumb(name, await wideJpeg(file));
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
    const saved = await api.saveBio(name, store.get(bioDraftAtom).trim());
    store.set(bioStatusAtom, 'saved');
    // saved is as good as loaded: it belongs to this name now and goes with it on a name change
    if (name === profileName) loadedBio = saved.bio;
  } catch (err) {
    store.set(bioStatusAtom, `not saved: ${messageOf(err)}`);
  }
}

export function copyWatchUrl() {
  const url = store.get(watchUrlAtom);
  if (url) navigator.clipboard?.writeText(url).catch(() => undefined);
}
