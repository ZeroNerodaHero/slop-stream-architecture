/**
 * Being in a voice channel (docs/voice.md). One call at a time, for the whole tab: a join asks
 * the api for a grant (`POST /api/groups/:group/voice/:channel/join`), opens `/voice`, and its
 * first frame is `{role: 'voice', grant, sdp}` with an offer of 1 sendrecv mic and 15 recvonly
 * audio m-lines (video/src/voice.rs). The voice server answers `{sdp}` or `{error}`, then
 * `{event: 'seats', seats: [{seat, user, line}]}` on every join and leave: `line` is the m-line
 * that person is heard on. Who is in which channel is the room's (`voice` in room-atoms.ts,
 * kept by the `voice` and `voice_left` facts); this module is only this tab's own call, and who
 * is speaking in it, from each m-line's `audioLevel` (getStats). Same shape as the other atom
 * modules: atoms for what renders, module handles, action functions. The devices a call uses
 * (the mic, the speakers, a camera for later) are picked in the user modal's voice tab and kept
 * in this browser; they are at the end of this file.
 */

import { atom } from 'jotai';
import { atomWithStorage } from 'jotai/utils';

import { api, messageOf } from '@/infra/api';
import { socketUrl } from '@/infra/frames';
import { store } from '@/infra/store';
import { trimOffer } from '@/infra/voice-offer';

/** How many m-lines hear the others: a room's 16 seats less your own. */
const HEARD_LINES = 15;
/** How long the offer waits for its candidates: there is no trickle, the join frame carries them. */
const GATHER_MS = 3000;
/** How often the levels are read. */
const LEVEL_MS = 150;
/** An `audioLevel` (0 to 1) at or over this is speaking. */
const SPEAKING = 0.03;
/** How often the call's quality (ping, loss, bitrate) is read: off the same getStats as the levels, every so many of them. */
const STATS_MS = 2000;

export interface VoiceSeat {
  seat: number;
  user: string;
  line: number;
}

/**
 * This tab's call. `joining` from the click to the answer; `linked` once the audio itself is
 * through (the peer connected over udp), which can lag the answer or never come; `error` is a
 * quiet line under the list, '' for none.
 */
export interface VoiceCall {
  phase: 'idle' | 'joining' | 'connected';
  server: string;
  channel: string;
  linked: boolean;
  error: string;
}

const IDLE: VoiceCall = { phase: 'idle', server: '', channel: '', linked: false, error: '' };

/** A call whose audio never got through: the answer came over the socket, the udp did not. */
const NO_AUDIO_PATH = 'no audio path: nothing got through to the voice server over udp, a firewall is closing it';

export const voiceCallAtom = atom<VoiceCall>(IDLE);
/** Who sits where in the room, as the last seats frame said. Your own seat is not in it. */
export const voiceSeatsAtom = atom<VoiceSeat[]>([]);
/** The names speaking now, your own among them while your mic is. */
export const voiceSpeakingAtom = atom<ReadonlySet<string>>(new Set<string>());
/** Your mic is off: the track is still there, sending silence. */
export const voiceMutedAtom = atom(false);
/** You hear nobody, and your mic is off with it. */
export const voiceDeafAtom = atom(false);
/** How the call is getting through, every STATS_MS while connected; null before the first read and while idle. */
export const voiceStatsAtom = atom<VoiceStats | null>(null);

/** The live call's handles, null while idle. */
interface Live {
  pc: RTCPeerConnection;
  ws: WebSocket | null;
  mic: MediaStream;
  /** The device the mic was opened on: the picked one, or the default when that was gone. */
  micFor: string;
  audios: HTMLAudioElement[];
  timer: ReturnType<typeof setInterval> | null;
  /** The counters at the last stats read, for the deltas of the next; null before the first. */
  sample: StatsSample | null;
}

let live: Live | null = null;
/** Which join is the current one: anything an older one finishes after a leave is dropped. */
let attempt = 0;

function setCall(next: Partial<VoiceCall>): void {
  store.set(voiceCallAtom, { ...store.get(voiceCallAtom), ...next });
}

/** Puts everything down: socket, peer, mic, players, the level reader. Nothing is said to anyone: the voice server frees the seat when the socket closes. */
function teardown(): void {
  const was = live;
  live = null;
  store.set(voiceSeatsAtom, []);
  store.set(voiceSpeakingAtom, new Set<string>());
  store.set(voiceStatsAtom, null);
  if (!was) return;
  if (was.timer) clearInterval(was.timer);
  if (was.ws) {
    was.ws.onclose = null;
    was.ws.onmessage = null;
    was.ws.close();
  }
  was.pc.onconnectionstatechange = null;
  was.pc.oniceconnectionstatechange = null;
  was.pc.close();
  for (const track of was.mic.getTracks()) track.stop();
  for (const audio of was.audios) {
    audio.pause();
    audio.srcObject = null;
  }
}

/** The call went wrong: down, with the word under the list. */
function fail(mine: number, error: string): void {
  if (mine !== attempt) return;
  teardown();
  store.set(voiceCallAtom, { ...IDLE, error });
}

/** Out of the call, if in one. Clicked, or the page going away. */
export function leaveVoice(): void {
  attempt++;
  teardown();
  store.set(voiceCallAtom, IDLE);
}

/** The call's outgoing mic track, for a level to read off it; null while idle or before the mic is open. A new device swaps it. */
export function voiceMicTrack(): MediaStreamTrack | null {
  return live?.mic.getAudioTracks()[0] ?? null;
}

/** The mic on or off. Off while deafened, whatever was asked. */
function applyMic(): void {
  const on = !store.get(voiceMutedAtom) && !store.get(voiceDeafAtom);
  for (const track of live?.mic.getAudioTracks() ?? []) track.enabled = on;
}

export function setVoiceMuted(muted: boolean): void {
  store.set(voiceMutedAtom, muted);
  applyMic();
}

export function setVoiceDeaf(deaf: boolean): void {
  store.set(voiceDeafAtom, deaf);
  for (const audio of live?.audios ?? []) audio.muted = deaf;
  applyMic();
}

/** Into `channel` of `server`. Already in it: nothing. In another: out of that one first. */
export async function joinVoice(server: string, channel: string, me: string): Promise<void> {
  const call = store.get(voiceCallAtom);
  if (call.phase !== 'idle' && call.server === server && call.channel === channel) return;
  leaveVoice();
  const mine = attempt;
  store.set(voiceCallAtom, { phase: 'joining', server, channel, linked: false, error: '' });

  let grant;
  try {
    grant = await api.joinVoice(server, channel);
  } catch (err) {
    return fail(mine, messageOf(err));
  }
  if (mine !== attempt) return;

  let mic: MediaStream;
  let micFor: string;
  try {
    ({ stream: mic, device: micFor } = await openDevice('audio', store.get(voiceInputAtom), MIC_AUDIO));
  } catch {
    return fail(mine, 'no microphone: allow it in the browser to talk');
  }
  if (mine !== attempt) {
    for (const track of mic.getTracks()) track.stop();
    return;
  }

  const [track] = mic.getAudioTracks();
  if (!track) {
    for (const t of mic.getTracks()) t.stop();
    return fail(mine, 'no microphone: allow it in the browser to talk');
  }
  const pc = new RTCPeerConnection();
  const audios: HTMLAudioElement[] = [];
  live = { pc, ws: null, mic, micFor, audios, timer: null, sample: null };
  // the mic is allowed now, so the browser names the devices: a pick that is gone shows as gone
  void refreshVoiceDevices();
  applyMic();
  // m-line 0 is the mic; 1 to 15 are where the others are heard, in the order they were added
  pc.addTransceiver(track, { direction: 'sendrecv', streams: [mic] });
  for (let i = 0; i < HEARD_LINES; i++) {
    const t = pc.addTransceiver('audio', { direction: 'recvonly' });
    const audio = new Audio();
    audio.autoplay = true;
    audio.muted = store.get(voiceDeafAtom);
    audio.srcObject = new MediaStream([t.receiver.track]);
    void sinkTo(audio, store.get(voiceOutputAtom));
    audios.push(audio);
  }
  // what ice did, in the console: a call that never links says how far it got
  pc.oniceconnectionstatechange = () => console.info(`voice: ice ${pc.iceConnectionState}`);
  pc.onconnectionstatechange = () => {
    console.info(`voice: peer ${pc.connectionState}`);
    if (pc.connectionState === 'connected' && mine === attempt) setCall({ linked: true });
    if (pc.connectionState === 'failed') fail(mine, store.get(voiceCallAtom).linked ? 'voice lost its connection' : NO_AUDIO_PATH);
  };

  try {
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise<void>((done) => {
      if (pc.iceGatheringState === 'complete') return done();
      pc.onicegatheringstatechange = () => pc.iceGatheringState === 'complete' && done();
      setTimeout(done, GATHER_MS);
    });
  } catch {
    return fail(mine, 'voice could not start');
  }
  if (mine !== attempt) return;

  const ws = new WebSocket(socketUrl(grant.url, location.href));
  live.ws = ws;
  // trimmed: a phone's full offer is over the voice server's 48 KB (voice-offer.ts)
  ws.onopen = () => ws.send(JSON.stringify({ role: 'voice', grant: grant.grant, sdp: trimOffer(pc.localDescription?.sdp ?? '') }));
  // the voice server says why in an error frame when it knows (that one wins: fail tears this
  // handler down); a socket that only closes is said from what this side saw
  ws.onclose = (e: CloseEvent) => fail(mine, closedWord(store.get(voiceCallAtom), e.code));
  ws.onmessage = (e: MessageEvent) => {
    let msg: { error?: string; sdp?: string; event?: string; seats?: VoiceSeat[] };
    try {
      msg = JSON.parse(String(e.data));
    } catch {
      return;
    }
    if (msg.error) return fail(mine, msg.error);
    if (msg.sdp) {
      pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp }).then(
        () => {
          if (mine !== attempt) return;
          setCall({ phase: 'connected' });
          for (const audio of audios) void audio.play().catch(() => {});
        },
        () => fail(mine, 'bad answer')
      );
    } else if (msg.event === 'seats' && Array.isArray(msg.seats)) {
      store.set(voiceSeatsAtom, msg.seats);
    }
  };
  live.timer = setInterval(() => void readLevels(mine, me), LEVEL_MS);
}

/**
 * Why the socket closed with no word from the voice server, from where the call had got to. An
 * ice that never connects is the voice server's to say (its `no audio path` frame), so a bare
 * close before the audio linked is the socket's doing, not udp's.
 */
function closedWord(call: VoiceCall, code: number): string {
  if (call.phase !== 'connected') return code === 1006 ? 'voice is unreachable: the voice server did not answer' : `voice is unreachable (${code})`;
  if (!call.linked) return code === 1006 ? 'voice dropped before the audio connected: the connection to the voice server broke' : `voice dropped before the audio connected (${code})`;
  return code === 1006 ? 'voice dropped: the connection to the voice server broke' : `voice dropped: the voice server closed the call (${code})`;
}

/**
 * Who is speaking: each heard m-line's `audioLevel` by its seat's name, and the mic's as `me`.
 * Set only when the set changes. Every STATS_MS once connected, the same report is the call's
 * quality too (voiceStatsAtom).
 */
async function readLevels(mine: number, me: string): Promise<void> {
  const call = live;
  if (!call || mine !== attempt) return;
  let report: RTCStatsReport;
  try {
    report = await call.pc.getStats();
  } catch {
    return;
  }
  if (mine !== attempt) return;
  const lineOfTrack = new Map<string, number>();
  call.pc.getTransceivers().forEach((t, i) => lineOfTrack.set(t.receiver.track.id, i));
  const userOfLine = new Map(store.get(voiceSeatsAtom).map((s) => [s.line, s.user]));
  const speaking = new Set<string>();
  const micOn = !store.get(voiceMutedAtom) && !store.get(voiceDeafAtom);
  const entries: StatsEntry[] = [];
  report.forEach((s: StatsEntry) => {
    entries.push(s);
    if (s.kind !== 'audio' || (s.audioLevel ?? 0) < SPEAKING) return;
    if (s.type === 'media-source') {
      if (micOn) speaking.add(me);
    } else if (s.type === 'inbound-rtp' && s.trackIdentifier) {
      const user = userOfLine.get(lineOfTrack.get(s.trackIdentifier) ?? -1);
      if (user) speaking.add(user);
    }
  });
  const was = store.get(voiceSpeakingAtom);
  if (was.size !== speaking.size || [...speaking].some((n) => !was.has(n))) store.set(voiceSpeakingAtom, speaking);

  const now = performance.now();
  if (store.get(voiceCallAtom).phase !== 'connected' || (call.sample && now - call.sample.at < STATS_MS)) return;
  const read = readStats(entries, call.sample, now);
  call.sample = read.sample;
  // `disconnected` is ice's own word for a path that stopped answering, before it gives up as `failed`
  store.set(voiceStatsAtom, { ...read.stats, dropped: call.pc.connectionState === 'disconnected' });
}

// ---- quality ------------------------------------------------------------------------------

/** The fields of a getStats report this file reads: every report is one of these, most of them absent. */
export interface StatsEntry {
  id: string;
  type: string;
  kind?: string;
  audioLevel?: number;
  trackIdentifier?: string;
  selectedCandidatePairId?: string;
  nominated?: boolean;
  selected?: boolean;
  state?: string;
  currentRoundTripTime?: number;
  bytesSent?: number;
  bytesReceived?: number;
  localCandidateId?: string;
  remoteCandidateId?: string;
  candidateType?: string;
  jitter?: number;
  packetsLost?: number;
  packetsReceived?: number;
  codecId?: string;
  mimeType?: string;
  clockRate?: number;
}

/** How the call is getting through. A number is null when the browser did not say or there is no window yet (the first read). */
export interface VoiceStats {
  /** Round trip on the path in use, ms. */
  rtt: number | null;
  /** The worst of the heard lines' jitter, ms. */
  jitter: number | null;
  /** Of the packets due on the heard lines over the window, how many were lost, %. Null with nobody to hear. */
  loss: number | null;
  /** Kbps out and in on the path in use, over the window. */
  up: number | null;
  down: number | null;
  /** Like `opus 48k`; '' when not said. */
  codec: string;
  /** `relay` when either end of the path in use is a turn relay, else `direct`; '' when not said. */
  route: 'direct' | 'relay' | '';
  /** Ice lost the path for now (`disconnected`): it may come back or fail. */
  dropped: boolean;
}

/** The running counters a delta is taken against. */
export interface StatsSample {
  at: number;
  sent: number | null;
  received: number | null;
  lost: number;
  got: number;
}

export type VoiceQuality = 'good' | 'ok' | 'poor';

/** Good under 100ms and 1% lost, ok under 250ms and 5%, else poor. Null when neither is known. An unknown one counts as fine. */
export function voiceQuality(stats: Pick<VoiceStats, 'rtt' | 'loss'>): VoiceQuality | null {
  if (stats.rtt === null && stats.loss === null) return null;
  const rtt = stats.rtt ?? 0;
  const loss = stats.loss ?? 0;
  if (rtt < 100 && loss < 1) return 'good';
  if (rtt < 250 && loss < 5) return 'ok';
  return 'poor';
}

/** `now - was` per ms, as kbps from bytes; null without both, or when the counter went back (a new path). */
export function kbps(was: number | null, now: number | null, ms: number): number | null {
  if (was === null || now === null || now < was || ms <= 0) return null;
  return ((now - was) * 8) / ms;
}

/** The share of packets lost over a window, %, from the running lost and received counters; null when no packet was due. */
export function lossPercent(was: Pick<StatsSample, 'lost' | 'got'>, now: Pick<StatsSample, 'lost' | 'got'>): number | null {
  // packetsLost can go down (a late packet counted after all): a negative window is none lost
  const lost = Math.max(0, now.lost - was.lost);
  const got = Math.max(0, now.got - was.got);
  return lost + got > 0 ? (lost / (lost + got)) * 100 : null;
}

/**
 * One getStats report read as the call's quality, with the deltas against `was` (the last
 * read's counters). The path is the transport's selected candidate pair (chrome, safari), else
 * the pair marked `selected` or nominated and succeeded (firefox).
 */
export function readStats(entries: readonly StatsEntry[], was: StatsSample | null, at: number): { stats: Omit<VoiceStats, 'dropped'>; sample: StatsSample } {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const transport = entries.find((e) => e.type === 'transport' && e.selectedCandidatePairId);
  const pair =
    (transport?.selectedCandidatePairId ? byId.get(transport.selectedCandidatePairId) : undefined) ??
    entries.find((e) => e.type === 'candidate-pair' && (e.selected || (e.nominated && e.state === 'succeeded')));
  const types = [pair?.localCandidateId, pair?.remoteCandidateId].map((id) => (id ? byId.get(id)?.candidateType : undefined));
  const route = types.includes('relay') ? 'relay' : types.some(Boolean) ? 'direct' : '';

  const inbound = entries.filter((e) => e.type === 'inbound-rtp' && e.kind === 'audio');
  const heard = inbound.filter((e) => (e.packetsReceived ?? 0) > 0 && e.jitter !== undefined);
  const outbound = entries.find((e) => e.type === 'outbound-rtp' && e.kind === 'audio' && e.codecId);
  const codecReport = byId.get(outbound?.codecId ?? heard.find((e) => e.codecId)?.codecId ?? '');
  const codec = codecReport?.mimeType
    ? `${codecReport.mimeType.replace(/^audio\//i, '').toLowerCase()}${codecReport.clockRate ? ` ${Math.round(codecReport.clockRate / 1000)}k` : ''}`
    : '';

  const sample: StatsSample = {
    at,
    sent: pair?.bytesSent ?? null,
    received: pair?.bytesReceived ?? null,
    lost: inbound.reduce((n, e) => n + (e.packetsLost ?? 0), 0),
    got: inbound.reduce((n, e) => n + (e.packetsReceived ?? 0), 0)
  };
  const ms = was ? at - was.at : 0;
  return {
    sample,
    stats: {
      rtt: pair?.currentRoundTripTime !== undefined ? pair.currentRoundTripTime * 1000 : null,
      jitter: heard.length ? Math.max(...heard.map((e) => (e.jitter ?? 0) * 1000)) : null,
      loss: was ? lossPercent(was, sample) : null,
      up: was ? kbps(was.sent, sample.sent, ms) : null,
      down: was ? kbps(was.received, sample.received, ms) : null,
      codec,
      route
    }
  };
}

// ---- devices ------------------------------------------------------------------------------

/** A pick that is no device in particular: the browser's own (the system's). */
export const DEFAULT_DEVICE = 'default';

export interface VoiceDevice {
  id: string;
  label: string;
}

/**
 * What is plugged in, by kind. The browser names its devices (and gives their ids) only once
 * one of that kind was allowed: until then a list is empty and its `named` is false, and a
 * kept pick cannot be told from a gone one.
 */
export interface VoiceDevices {
  inputs: VoiceDevice[];
  outputs: VoiceDevice[];
  cameras: VoiceDevice[];
  micNamed: boolean;
  cameraNamed: boolean;
}

export const voiceDevicesAtom = atom<VoiceDevices>({ inputs: [], outputs: [], cameras: [], micNamed: false, cameraNamed: false });

/** The browser can send a player's sound to a device of its choosing. Not safari, not an older firefox: the speakers are the system's there. */
export const SINK_SUPPORTED = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;

/** The three picks, kept in this browser. A kept id stays kept while its device is unplugged, so plugging it back in brings it back. */
const storedInputAtom = atomWithStorage<unknown>('settings.voiceInput', DEFAULT_DEVICE, undefined, { getOnInit: true });
const storedOutputAtom = atomWithStorage<unknown>('settings.voiceOutput', DEFAULT_DEVICE, undefined, { getOnInit: true });
const storedCameraAtom = atomWithStorage<unknown>('settings.voiceCamera', DEFAULT_DEVICE, undefined, { getOnInit: true });

/** The kept pick, when it is plugged in (or the list is not known yet); the default when it is gone. */
function inUse(kept: unknown, list: readonly VoiceDevice[], named: boolean): string {
  const id = typeof kept === 'string' && kept ? kept : DEFAULT_DEVICE;
  if (id === DEFAULT_DEVICE || !named) return id;
  return list.some((d) => d.id === id) ? id : DEFAULT_DEVICE;
}

/** Read: the device each is on now. */
export const voiceInputAtom = atom((get) => inUse(get(storedInputAtom), get(voiceDevicesAtom).inputs, get(voiceDevicesAtom).micNamed));
export const voiceOutputAtom = atom((get) => inUse(get(storedOutputAtom), get(voiceDevicesAtom).outputs, get(voiceDevicesAtom).micNamed));
export const voiceCameraAtom = atom((get) => inUse(get(storedCameraAtom), get(voiceDevicesAtom).cameras, get(voiceDevicesAtom).cameraNamed));

/** A call on now follows a new mic and new speakers at once. */
export function setVoiceInput(id: string): void {
  store.set(storedInputAtom, id);
  void switchMic();
}

export function setVoiceOutput(id: string): void {
  store.set(storedOutputAtom, id);
  applySink();
}

/** Kept for video in voice, which is not here yet: nothing uses it but the tab's preview. */
export function setVoiceCamera(id: string): void {
  store.set(storedCameraAtom, id);
}

const MIC_AUDIO = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

/** The picked device was asked for and is not there (unplugged, or an id from another day). */
function gone(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return name === 'OverconstrainedError' || name === 'NotFoundError';
}

/** `deviceId`'s stream, else the browser's own when that one is gone. `device` is which it got. Throws as getUserMedia does. */
async function openDevice(kind: 'audio' | 'video', deviceId: string, base: MediaTrackConstraints): Promise<{ stream: MediaStream; device: string }> {
  if (deviceId !== DEFAULT_DEVICE) {
    try {
      return { stream: await navigator.mediaDevices.getUserMedia({ [kind]: { ...base, deviceId: { exact: deviceId } } }), device: deviceId };
    } catch (err) {
      if (!gone(err)) throw err;
    }
  }
  return { stream: await navigator.mediaDevices.getUserMedia({ [kind]: base }), device: DEFAULT_DEVICE };
}

/** The mic for a call or the tab's meter: the picked one, else the browser's. */
export async function openVoiceMic(deviceId = store.get(voiceInputAtom)): Promise<MediaStream> {
  return (await openDevice('audio', deviceId, MIC_AUDIO)).stream;
}

/** The camera for the tab's preview, and for video in voice when it comes. */
export async function openVoiceCamera(deviceId = store.get(voiceCameraAtom)): Promise<MediaStream> {
  return (await openDevice('video', deviceId, {})).stream;
}

/** Sends `audio` to `deviceId`, or to the default when it cannot be had. Nothing where the browser cannot. */
async function sinkTo(audio: HTMLAudioElement, deviceId: string): Promise<void> {
  if (!SINK_SUPPORTED) return;
  try {
    await audio.setSinkId(deviceId === DEFAULT_DEVICE ? '' : deviceId);
  } catch {
    await audio.setSinkId('').catch(() => undefined);
  }
}

/** The call's players, to the speakers in use. */
function applySink(): void {
  for (const audio of live?.audios ?? []) void sinkTo(audio, store.get(voiceOutputAtom));
}

/** Which switch is the current one: a mic that opens after a newer pick is put down. */
let micSwitch = 0;

/**
 * The call's mic, onto the device in use now, when it is on another: the new track replaces
 * the old one on m-line 0's sender, so nothing is offered again and the seat stays.
 */
async function switchMic(): Promise<void> {
  const call = live;
  const want = store.get(voiceInputAtom);
  const [now] = call?.mic.getAudioTracks() ?? [];
  if (!call || (call.micFor === want && now?.readyState === 'live')) return;
  const mine = ++micSwitch;
  let next: { stream: MediaStream; device: string };
  try {
    next = await openDevice('audio', want, MIC_AUDIO);
  } catch {
    return; // the old mic stays
  }
  const [track] = next.stream.getAudioTracks();
  const sender = call.pc.getTransceivers()[0]?.sender;
  const drop = () => {
    for (const t of next.stream.getTracks()) t.stop();
  };
  if (mine !== micSwitch || live !== call || !track || !sender) return drop();
  try {
    await sender.replaceTrack(track);
  } catch {
    return drop();
  }
  if (live !== call) return drop();
  const old = call.mic;
  call.mic = next.stream;
  call.micFor = next.device;
  for (const t of old.getTracks()) t.stop();
  applyMic();
}

let watching = false;

/** The devices plugged in now, into `voiceDevicesAtom`; a call on moves off one that went. Watches for plugging from its first call on. */
export async function refreshVoiceDevices(): Promise<void> {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  if (!watching) {
    watching = true;
    navigator.mediaDevices.addEventListener('devicechange', () => void refreshVoiceDevices());
  }
  let devices: MediaDeviceInfo[];
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch {
    return;
  }
  // `default` and `communications` are chrome's stand-ins for another device in the list: the default pick is them
  const listOf = (kind: MediaDeviceKind, word: string) =>
    devices
      .filter((d) => d.kind === kind && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
      .map((d, i) => ({ id: d.deviceId, label: d.label || `${word} ${i + 1}` }));
  const named = (kind: MediaDeviceKind) => devices.some((d) => d.kind === kind && d.label);
  store.set(voiceDevicesAtom, {
    inputs: listOf('audioinput', 'mic'),
    outputs: listOf('audiooutput', 'speakers'),
    cameras: listOf('videoinput', 'camera'),
    micNamed: named('audioinput'),
    cameraNamed: named('videoinput')
  });
  void switchMic();
  applySink();
}

/** Asks for the mic, so the browser names the devices. Throws as getUserMedia does. */
export async function allowMic(): Promise<void> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  for (const t of stream.getTracks()) t.stop();
  await refreshVoiceDevices();
}

/** The test tone: a short beep, faded in and out so it does not click. */
const TONE_HZ = 660;
const TONE_S = 0.5;

/** A short beep through the speakers picked. */
export async function playTestTone(): Promise<void> {
  if (typeof AudioContext === 'undefined') return;
  const ctx = new AudioContext();
  const out = ctx.createMediaStreamDestination();
  const gain = ctx.createGain();
  const osc = ctx.createOscillator();
  osc.frequency.value = TONE_HZ;
  osc.connect(gain).connect(out);
  const audio = new Audio();
  audio.srcObject = out.stream;
  try {
    await sinkTo(audio, store.get(voiceOutputAtom));
    await ctx.resume();
    await audio.play();
    const t = ctx.currentTime;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.25, t + 0.02);
    gain.gain.setValueAtTime(0.25, t + TONE_S - 0.05);
    gain.gain.linearRampToValueAtTime(0, t + TONE_S);
    osc.start(t);
    osc.stop(t + TONE_S);
    await new Promise((done) => setTimeout(done, TONE_S * 1000 + 150));
  } finally {
    audio.pause();
    audio.srcObject = null;
    await ctx.close().catch(() => undefined);
  }
}
