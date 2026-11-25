import { atom } from 'jotai';
import { atomWithStorage } from 'jotai/utils';

import rnnoiseWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
import rnnoiseSimdWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url';
import rnnoiseWorkletUrl from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url';

import { api, messageOf, statusOf } from '@/infra/api';
import { trackSocket } from '@/infra/debug/sockets';
import { socketUrl } from '@/infra/frames';
import { FLOOR_DB, type Level, levelAnalyser, levelOf } from '@/infra/mic-level';
import { store } from '@/infra/store';
import gateWorkletUrl from '@/infra/voice-gate-worklet.js?url';
import { trimOffer } from '@/infra/voice-offer';

import { HEARD_DEFAULT, heardLevelOf, IDLE, type VoiceCall, voiceCallAtom, voiceHeardAtom, voiceUidsAtom } from './voice-state';
import { sayVoiceState, startVideo, stopVideo, switchVoiceCamera, takeVideoAnswer, type VideoKind, videoSeats } from './voice-video';

const HEARD_LINES = 15;
const GATHER_MS = 3000;
const LEVEL_MS = 150;
const SPEAKING = 0.03;
const STATS_MS = 2000;
const ANSWER_MS = 15000;
export const RETRY_MS: readonly number[] = [1000, 2000, 4000, 8000];
const MOVE_MS = 5000;
const MOVE_ASK_MS = 200;
const REJOIN_GAP_MS = 30000;

export interface VoiceSeat {
  seat: number;
  user: string;
  line: number;
  mute?: boolean;
  deaf?: boolean;
  video?: { kind: VideoKind; mid: string | null }[];
}

const NO_AUDIO_PATH = 'no audio path: nothing got through to the voice server over udp, a firewall is closing it';

export const voiceSeatsAtom = atom<VoiceSeat[]>([]);
export const voiceSpeakingAtom = atom<ReadonlySet<string>>(new Set<string>());
export const voiceMutedAtom = atom(false);
export const voiceDeafAtom = atom(false);
export const voiceStatsAtom = atom<VoiceStats | null>(null);

interface Live {
  pc: RTCPeerConnection;
  ws: WebSocket | null;
  audios: HTMLAudioElement[];
  heard: Heard[];
  ctx: AudioContext | null;
  timer: ReturnType<typeof setInterval> | null;
  deadline: ReturnType<typeof setTimeout> | null;
  sample: StatsSample | null;
}

interface Heard {
  raw: MediaStream;
  gain: GainNode | null;
  keep: HTMLAudioElement | null;
}

let live: Live | null = null;
let attempt = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let joiningAs = '';
let putDownAt = 0;
let rejoinedAt = 0;
const TAB = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');

function setCall(next: Partial<VoiceCall>): void {
  store.set(voiceCallAtom, { ...store.get(voiceCallAtom), ...next });
}

function teardown(): void {
  const was = live;
  live = null;
  store.set(voiceSeatsAtom, []);
  store.set(voiceSpeakingAtom, new Set<string>());
  store.set(voiceStatsAtom, null);
  stopVideo();
  syncPtt();
  if (!was) return;
  releaseVoiceMic();
  if (was.timer) clearInterval(was.timer);
  if (was.deadline) clearTimeout(was.deadline);
  if (was.ws) {
    putDownAt = Date.now();
    was.ws.onclose = null;
    was.ws.onmessage = null;
    was.ws.close();
  }
  was.pc.onconnectionstatechange = null;
  was.pc.oniceconnectionstatechange = null;
  was.pc.close();
  for (const audio of [...was.audios, ...was.heard.flatMap((h) => (h.keep ? [h.keep] : []))]) {
    audio.pause();
    audio.srcObject = null;
  }
  void was.ctx?.close().catch(() => undefined);
}

const FINAL = ['room full', 'too many voice peers', 'voice is not open', 'not allowed', 'notallowederror', 'notfounderror', 'unauthorized'];

export function retryable(error: string, status?: number): boolean {
  if (status !== undefined && status >= 400 && status < 500) return false;
  const said = error.toLowerCase();
  return !FINAL.some((word) => said.includes(word));
}

export function retryDelay(retry: number): number | null {
  return RETRY_MS[retry - 1] ?? null;
}

function clearRetry(): void {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
}

export function dropped(error: string): boolean {
  return error.startsWith('voice dropped') || error === 'voice lost its connection';
}

function fail(mine: number, error: string, status?: number): void {
  if (mine !== attempt) return;
  teardown();
  let call = store.get(voiceCallAtom);
  if (call.linked && dropped(error) && Date.now() - rejoinedAt > REJOIN_GAP_MS) {
    rejoinedAt = Date.now();
    console.info(`voice: dropped (${error}), joining again`);
    call = { ...call, linked: false, retry: 0 };
  }
  const retry = call.retry + 1;
  const wait = retryDelay(retry);
  if (!call.linked && wait !== null && retryable(error, status)) {
    console.info(`voice: try ${retry} failed (${error}), again in ${wait}ms`);
    const next = ++attempt;
    store.set(voiceCallAtom, { ...call, phase: 'joining', linked: false, error, retry });
    retryTimer = setTimeout(() => {
      retryTimer = null;
      const now = store.get(voiceCallAtom);
      if (next === attempt && now.phase === 'joining') void tryJoin(now.server, now.channel, joiningAs);
    }, wait);
    return;
  }
  store.set(voiceCallAtom, { ...call, phase: 'failed', linked: false, error });
}

export function leaveVoice(): void {
  clearRetry();
  attempt++;
  teardown();
  store.set(voiceCallAtom, IDLE);
}

function micOpen(): boolean {
  if (store.get(voiceMutedAtom) || store.get(voiceDeafAtom)) return false;
  return store.get(voiceModeAtom) !== 'ptt' || store.get(voicePttHeldAtom);
}

function applyMic(): void {
  if (mic) mic.out.enabled = micOpen();
}

export function setVoiceMuted(muted: boolean): void {
  store.set(voiceMutedAtom, muted);
  applyMic();
  sayVoiceState(muted, store.get(voiceDeafAtom));
}

export function setVoiceDeaf(deaf: boolean): void {
  store.set(voiceDeafAtom, deaf);
  applyHeard();
  applyMic();
  sayVoiceState(store.get(voiceMutedAtom), deaf);
}

function noMic(err: unknown): string {
  const name = (err as { name?: string } | null)?.name || 'Error';
  return `no microphone (${name}): allow it in the browser to talk`;
}

export async function joinVoice(server: string, channel: string, me: string): Promise<void> {
  const call = store.get(voiceCallAtom);
  if ((call.phase === 'joining' || call.phase === 'connected') && call.server === server && call.channel === channel) return;
  leaveVoice();
  joiningAs = me;
  store.set(voiceCallAtom, { ...IDLE, phase: 'joining', server, channel });
  await tryJoin(server, channel, me);
}

async function tryJoin(server: string, channel: string, me: string): Promise<void> {
  const mine = attempt;

  let grant;
  for (;;) {
    try {
      grant = await api.joinVoice(server, channel, TAB);
      break;
    } catch (err) {
      if (mine !== attempt) return;
      if (statusOf(err) === 409 && messageOf(err).includes('already in voice') && Date.now() - putDownAt < MOVE_MS) {
        await new Promise((done) => setTimeout(done, MOVE_ASK_MS));
        if (mine !== attempt) return;
        continue;
      }
      return fail(mine, messageOf(err), statusOf(err));
    }
  }
  if (mine !== attempt) return;

  try {
    await holdVoiceMic();
  } catch (err) {
    return fail(mine, noMic(err));
  }
  if (mine !== attempt || !mic) {
    releaseVoiceMic();
    if (mine === attempt) fail(mine, noMic(new DOMException('no microphone', 'NotFoundError')));
    return;
  }

  const track = mic.out;
  const pc = new RTCPeerConnection();
  const audios: HTMLAudioElement[] = [];
  const heard: Heard[] = [];
  live = { pc, ws: null, audios, heard, ctx: null, timer: null, deadline: null, sample: null };
  live.deadline = setTimeout(() => fail(mine, 'voice timed out: no answer from the voice server'), ANSWER_MS);
  void refreshVoiceDevices();
  applyMic();
  syncPtt();
  pc.addTransceiver(track, { direction: 'sendrecv', streams: [new MediaStream([track])] });
  for (let i = 0; i < HEARD_LINES; i++) {
    const t = pc.addTransceiver('audio', { direction: 'recvonly' });
    const audio = new Audio();
    audio.autoplay = true;
    const raw = new MediaStream([t.receiver.track]);
    audio.srcObject = raw;
    void sinkTo(audio, store.get(voiceOutputAtom));
    audios.push(audio);
    heard.push({ raw, gain: null, keep: null });
  }
  applyHeard();
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

  const ws = trackSocket('voice', new WebSocket(socketUrl(grant.url, location.href)), grant.url);
  live.ws = ws;
  ws.onopen = () => ws.send(JSON.stringify({ role: 'voice', grant: grant.grant, sdp: trimOffer(pc.localDescription?.sdp ?? '') }));
  ws.onclose = (e: CloseEvent) => fail(mine, closedWord(store.get(voiceCallAtom), e.code));
  ws.onmessage = (e: MessageEvent) => {
    let msg: { error?: string; sdp?: string; event?: string; seats?: VoiceSeat[] };
    try {
      msg = JSON.parse(String(e.data));
    } catch {
      return;
    }
    if (msg.error) return fail(mine, msg.error);
    if (msg.sdp && takeVideoAnswer(msg.sdp)) return;
    if (msg.sdp) {
      pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp }).then(
        () => {
          if (mine !== attempt) return;
          if (live?.deadline) clearTimeout(live.deadline);
          setCall({ phase: 'connected' });
          startVideo(
            pc,
            (frame) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(frame)),
            (error) => fail(mine, error)
          );
          sayVoiceState(store.get(voiceMutedAtom), store.get(voiceDeafAtom));
          videoSeats(store.get(voiceSeatsAtom));
          for (const audio of [...audios, ...heard.flatMap((h) => (h.keep ? [h.keep] : []))]) void audio.play().catch(() => {});
        },
        () => fail(mine, 'bad answer')
      );
    } else if (msg.event === 'seats' && Array.isArray(msg.seats)) {
      store.set(voiceSeatsAtom, msg.seats);
      videoSeats(msg.seats);
    }
  };
  live.timer = setInterval(() => void readLevels(mine, me), LEVEL_MS);
}

function closedWord(call: VoiceCall, code: number): string {
  if (call.phase !== 'connected') return code === 1006 ? 'voice is unreachable: the voice server did not answer' : `voice is unreachable (${code})`;
  if (!call.linked) return code === 1006 ? 'voice dropped before the audio connected: the connection to the voice server broke' : `voice dropped before the audio connected (${code})`;
  return code === 1006 ? 'voice dropped: the connection to the voice server broke' : `voice dropped: the voice server closed the call (${code})`;
}

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
  const micOn = micOpen();
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
  store.set(voiceStatsAtom, { ...read.stats, dropped: call.pc.connectionState === 'disconnected' });
}

function applyHeard(): void {
  const call = live;
  if (!call) return;
  const deaf = store.get(voiceDeafAtom);
  const levels = store.get(voiceHeardAtom);
  const uids = store.get(voiceUidsAtom);
  const userOfLine = new Map(store.get(voiceSeatsAtom).map((s) => [s.line, s.user]));
  call.audios.forEach((audio, i) => {
    const user = userOfLine.get(i + 1);
    const uid = user === undefined ? undefined : uids.get(user);
    const level = uid === undefined ? HEARD_DEFAULT : heardLevelOf(levels, uid);
    audio.muted = deaf || level.muted;
    const gain = level.volume / 100;
    const h = call.heard[i];
    if (h && !h.gain && gain !== 1) amplify(call, audio, h);
    if (h?.gain) h.gain.gain.setTargetAtTime(gain, h.gain.context.currentTime, 0.02);
    else audio.volume = Math.min(1, gain);
  });
}

function amplify(call: Live, audio: HTMLAudioElement, h: Heard): void {
  if (typeof AudioContext === 'undefined') return;
  try {
    call.ctx ??= new AudioContext();
    void call.ctx.resume().catch(() => undefined);
    const gain = call.ctx.createGain();
    const out = call.ctx.createMediaStreamDestination();
    call.ctx.createMediaStreamSource(h.raw).connect(gain).connect(out);
    const keep = new Audio();
    keep.muted = true;
    keep.srcObject = h.raw;
    void keep.play().catch(() => undefined);
    audio.srcObject = out.stream;
    audio.volume = 1;
    void audio.play().catch(() => undefined);
    h.gain = gain;
    h.keep = keep;
  } catch {
  }
}

store.sub(voiceSeatsAtom, applyHeard);
store.sub(voiceUidsAtom, applyHeard);
store.sub(voiceHeardAtom, applyHeard);

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

export interface VoiceStats {
  rtt: number | null;
  jitter: number | null;
  loss: number | null;
  up: number | null;
  down: number | null;
  codec: string;
  route: 'direct' | 'relay' | '';
  dropped: boolean;
}

export interface StatsSample {
  at: number;
  sent: number | null;
  received: number | null;
  lost: number;
  got: number;
}

export type VoiceQuality = 'good' | 'ok' | 'poor';

export function voiceQuality(stats: Pick<VoiceStats, 'rtt' | 'loss'>): VoiceQuality | null {
  if (stats.rtt === null && stats.loss === null) return null;
  const rtt = stats.rtt ?? 0;
  const loss = stats.loss ?? 0;
  if (rtt < 100 && loss < 1) return 'good';
  if (rtt < 250 && loss < 5) return 'ok';
  return 'poor';
}

export function kbps(was: number | null, now: number | null, ms: number): number | null {
  if (was === null || now === null || now < was || ms <= 0) return null;
  return ((now - was) * 8) / ms;
}

export function lossPercent(was: Pick<StatsSample, 'lost' | 'got'>, now: Pick<StatsSample, 'lost' | 'got'>): number | null {
  const lost = Math.max(0, now.lost - was.lost);
  const got = Math.max(0, now.got - was.got);
  return lost + got > 0 ? (lost / (lost + got)) * 100 : null;
}

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

export const DEFAULT_DEVICE = 'default';

export interface VoiceDevice {
  id: string;
  label: string;
}

export interface VoiceDevices {
  inputs: VoiceDevice[];
  outputs: VoiceDevice[];
  cameras: VoiceDevice[];
  micNamed: boolean;
  cameraNamed: boolean;
}

export const voiceDevicesAtom = atom<VoiceDevices>({ inputs: [], outputs: [], cameras: [], micNamed: false, cameraNamed: false });

export const SINK_SUPPORTED = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;

const storedInputAtom = atomWithStorage<unknown>('settings.voiceInput', DEFAULT_DEVICE, undefined, { getOnInit: true });
const storedOutputAtom = atomWithStorage<unknown>('settings.voiceOutput', DEFAULT_DEVICE, undefined, { getOnInit: true });
const storedCameraAtom = atomWithStorage<unknown>('settings.voiceCamera', DEFAULT_DEVICE, undefined, { getOnInit: true });

function inUse(kept: unknown, list: readonly VoiceDevice[], named: boolean): string {
  const id = typeof kept === 'string' && kept ? kept : DEFAULT_DEVICE;
  if (id === DEFAULT_DEVICE || !named) return id;
  return list.some((d) => d.id === id) ? id : DEFAULT_DEVICE;
}

export const voiceInputAtom = atom((get) => inUse(get(storedInputAtom), get(voiceDevicesAtom).inputs, get(voiceDevicesAtom).micNamed));
export const voiceOutputAtom = atom((get) => inUse(get(storedOutputAtom), get(voiceDevicesAtom).outputs, get(voiceDevicesAtom).micNamed));
export const voiceCameraAtom = atom((get) => inUse(get(storedCameraAtom), get(voiceDevicesAtom).cameras, get(voiceDevicesAtom).cameraNamed));

export function setVoiceInput(id: string): void {
  store.set(storedInputAtom, id);
  void syncMic();
}

export function setVoiceOutput(id: string): void {
  store.set(storedOutputAtom, id);
  applySink();
}

export function setVoiceCamera(id: string): void {
  store.set(storedCameraAtom, id);
  void switchVoiceCamera();
}

function gone(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return name === 'OverconstrainedError' || name === 'NotFoundError';
}

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

export async function openVoiceCamera(deviceId = store.get(voiceCameraAtom), base: MediaTrackConstraints = {}): Promise<MediaStream> {
  return (await openDevice('video', deviceId, base)).stream;
}

async function sinkTo(audio: HTMLAudioElement, deviceId: string): Promise<void> {
  if (!SINK_SUPPORTED) return;
  try {
    await audio.setSinkId(deviceId === DEFAULT_DEVICE ? '' : deviceId);
  } catch {
    await audio.setSinkId('').catch(() => undefined);
  }
}

function applySink(): void {
  for (const audio of live?.audios ?? []) void sinkTo(audio, store.get(voiceOutputAtom));
}

let watching = false;

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
  const listOf = (kind: MediaDeviceKind, word: string) =>
    devices
      .filter((d) => d.kind === kind && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
      .map((d, i) => ({ id: d.deviceId, label: d.label || `${word} ${i + 1}` }));
  const named = (kind: MediaDeviceKind) => devices.some((d) => d.kind === kind && d.label);
  const next: VoiceDevices = {
    inputs: listOf('audioinput', 'mic'),
    outputs: listOf('audiooutput', 'speakers'),
    cameras: listOf('videoinput', 'camera'),
    micNamed: named('audioinput'),
    cameraNamed: named('videoinput')
  };
  if (JSON.stringify(next) === JSON.stringify(store.get(voiceDevicesAtom))) return;
  store.set(voiceDevicesAtom, next);
  void syncMic();
  applySink();
}

const TONE_HZ = 660;
const TONE_S = 0.5;

export async function playTestTone(): Promise<void> {
  if (typeof AudioContext === 'undefined') return;
  const shared = mic?.ctx ?? null;
  const ctx = shared ?? new AudioContext();
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
    gain.disconnect();
    if (!shared) await ctx.close().catch(() => undefined);
  }
}

const storedIsolationAtom = atomWithStorage<unknown>('settings.voiceIsolation', true, undefined, { getOnInit: true });
const storedEchoAtom = atomWithStorage<unknown>('settings.voiceEchoCancellation', true, undefined, { getOnInit: true });
const storedAutoGainAtom = atomWithStorage<unknown>('settings.voiceAutoGain', true, undefined, { getOnInit: true });
const storedModeAtom = atomWithStorage<unknown>('settings.voiceMode', 'activity', undefined, { getOnInit: true });
const storedGateAtom = atomWithStorage<unknown>('settings.voiceGateDb', FLOOR_DB, undefined, { getOnInit: true });
const storedPttKeyAtom = atomWithStorage<unknown>('settings.voicePttKey', 'Backquote', undefined, { getOnInit: true });
const storedPttDelayAtom = atomWithStorage<unknown>('settings.voicePttDelay', 200, undefined, { getOnInit: true });

const numberIn = (kept: unknown, min: number, max: number, fallback: number) =>
  typeof kept === 'number' && Number.isFinite(kept) ? Math.min(max, Math.max(min, kept)) : fallback;

export type VoiceMode = 'activity' | 'ptt';

export const voiceIsolationAtom = atom((get) => get(storedIsolationAtom) !== false);
export const voiceEchoCancellationAtom = atom((get) => get(storedEchoAtom) !== false);
export const voiceAutoGainAtom = atom((get) => get(storedAutoGainAtom) !== false);
export const voiceModeAtom = atom<VoiceMode>((get) => (get(storedModeAtom) === 'ptt' ? 'ptt' : 'activity'));
export const voiceGateAtom = atom((get) => numberIn(get(storedGateAtom), FLOOR_DB, 0, FLOOR_DB));
export const voicePttKeyAtom = atom((get) => {
  const kept = get(storedPttKeyAtom);
  return typeof kept === 'string' && kept ? kept : 'Backquote';
});
export const voicePttDelayAtom = atom((get) => numberIn(get(storedPttDelayAtom), 0, 1000, 200));
export const PTT_DELAY_MAX = 1000;
export const voicePttHeldAtom = atom(false);
export const voiceIsolationFailedAtom = atom(false);

export function setVoiceIsolation(on: boolean): void {
  store.set(storedIsolationAtom, on);
  void syncMic();
}

export function setVoiceEchoCancellation(on: boolean): void {
  store.set(storedEchoAtom, on);
  void syncMic();
}

export function setVoiceAutoGain(on: boolean): void {
  store.set(storedAutoGainAtom, on);
  void syncMic();
}

export function setVoiceMode(mode: VoiceMode): void {
  store.set(storedModeAtom, mode);
  applyGate();
  syncPtt();
  applyMic();
}

export function setVoiceGate(db: number): void {
  store.set(storedGateAtom, db);
  applyGate();
}

export function setVoicePttKey(code: string): void {
  store.set(storedPttKeyAtom, code);
}

export function setVoicePttDelay(ms: number): void {
  store.set(storedPttDelayAtom, ms);
}

export function keyName(code: string): string {
  const names: Record<string, string> = {
    Backquote: 'backtick `',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
    Space: 'space',
    CapsLock: 'caps lock'
  };
  if (names[code]) return names[code];
  const [, mod, side] = /^(Shift|Control|Alt|Meta)(Left|Right)$/.exec(code) ?? [];
  if (mod && side) return `${side.toLowerCase()} ${mod === 'Control' ? 'ctrl' : mod === 'Meta' ? 'cmd' : mod.toLowerCase()}`;
  return code
    .replace(/^Key|^Digit/, '')
    .replace(/^Numpad/, 'num ')
    .replace(/^Arrow/, 'arrow ')
    .toLowerCase();
}

interface Mic {
  key: string;
  raw: MediaStream;
  ctx: AudioContext | null;
  denoise: (AudioWorkletNode & { destroy(): void }) | null;
  gate: AudioWorkletNode | null;
  level: Level | null;
  out: MediaStreamTrack;
}

let mic: Mic | null = null;
let holders = 0;
let micQueue: Promise<unknown> = Promise.resolve();

function queued<T>(step: () => Promise<T>): Promise<T> {
  const next = micQueue.then(step);
  micQueue = next.catch(() => undefined);
  return next;
}

export async function holdVoiceMic(): Promise<void> {
  holders++;
  try {
    await queued(() => buildMic());
    if (!mic) throw new DOMException('no microphone', 'NotFoundError');
  } catch (err) {
    releaseVoiceMic();
    throw err;
  }
}

export function releaseVoiceMic(): void {
  holders = Math.max(0, holders - 1);
  void queued(async () => {
    if (holders || !mic) return;
    closeMic(mic);
    mic = null;
  });
}

function syncMic(): Promise<void> {
  return queued(() => buildMic()).catch(() => undefined);
}

export function readVoiceMicLevel(now: number): number {
  return mic?.level?.read(now) ?? 0;
}

export function gateFraction(db: number): number {
  return Math.min(1, Math.max(0, 1 - db / FLOOR_DB));
}

async function buildMic(): Promise<void> {
  if (!holders) return;
  const device = store.get(voiceInputAtom);
  const isolation = store.get(voiceIsolationAtom);
  const constraints = {
    echoCancellation: store.get(voiceEchoCancellationAtom),
    autoGainControl: store.get(voiceAutoGainAtom),
    noiseSuppression: !isolation
  };
  const key = JSON.stringify([device, isolation, constraints]);
  const was = mic;
  if (was && was.key === key && was.raw.getAudioTracks()[0]?.readyState === 'live') return;
  const { stream } = await openDevice('audio', device, constraints);
  let next: Mic;
  try {
    next = await micOf(stream, key, isolation);
  } catch (err) {
    for (const t of stream.getTracks()) t.stop();
    throw err;
  }
  if (!holders) return closeMic(next);
  mic = next;
  applyGate();
  applyMic();
  await sendMic();
  if (was) closeMic(was);
}

async function micOf(raw: MediaStream, key: string, isolation: boolean): Promise<Mic> {
  const [track] = raw.getAudioTracks();
  if (!track) throw new DOMException('no microphone', 'NotFoundError');
  track.addEventListener('ended', () => void syncMic());
  const bare: Mic = { key, raw, ctx: null, denoise: null, gate: null, level: null, out: track };
  if (typeof AudioContext === 'undefined' || typeof AudioWorkletNode === 'undefined') {
    store.set(voiceIsolationFailedAtom, isolation);
    return bare;
  }
  let ctx: AudioContext | null = null;
  try {
    let source: MediaStreamAudioSourceNode;
    try {
      ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
      source = ctx.createMediaStreamSource(raw);
    } catch {
      void ctx?.close().catch(() => undefined);
      ctx = new AudioContext({ latencyHint: 'interactive' });
      source = ctx.createMediaStreamSource(raw);
    }
    if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
    let head: AudioNode = source;
    let denoise: Mic['denoise'] = null;
    if (isolation) {
      denoise = ctx.sampleRate === 48000 ? await denoiser(ctx).catch(() => null) : null;
      store.set(voiceIsolationFailedAtom, !denoise);
      if (denoise) head = head.connect(denoise);
    } else {
      store.set(voiceIsolationFailedAtom, false);
    }
    const analyser = levelAnalyser(ctx);
    head.connect(analyser);
    await ctx.audioWorklet.addModule(gateWorkletUrl);
    const gate = new AudioWorkletNode(ctx, 'voice-gate', { channelCount: 1, channelCountMode: 'explicit', outputChannelCount: [1] });
    const out = ctx.createMediaStreamDestination();
    head.connect(gate).connect(out);
    const [outTrack] = out.stream.getAudioTracks();
    if (!outTrack) throw new Error('no track out of web audio');
    return { key, raw, ctx, denoise, gate, level: levelOf(analyser), out: outTrack };
  } catch {
    void ctx?.close().catch(() => undefined);
    store.set(voiceIsolationFailedAtom, isolation);
    return bare;
  }
}

let rnnoiseWasm: Promise<ArrayBuffer> | null = null;

async function denoiser(ctx: AudioContext): Promise<NonNullable<Mic['denoise']>> {
  const { loadRnnoise, RnnoiseWorkletNode } = await import('@sapphi-red/web-noise-suppressor');
  rnnoiseWasm ??= loadRnnoise({ url: rnnoiseWasmUrl, simdUrl: rnnoiseSimdWasmUrl }).catch((err: unknown) => {
    rnnoiseWasm = null;
    throw err;
  });
  const [wasmBinary] = await Promise.all([rnnoiseWasm, ctx.audioWorklet.addModule(rnnoiseWorkletUrl)]);
  const node = new RnnoiseWorkletNode(ctx, { wasmBinary, maxChannels: 1 });
  node.channelCount = 1;
  node.channelCountMode = 'explicit';
  return node;
}

function closeMic(m: Mic): void {
  for (const t of m.raw.getTracks()) t.stop();
  m.out.stop();
  m.denoise?.destroy();
  void m.ctx?.close().catch(() => undefined);
}

async function sendMic(): Promise<void> {
  const sender = live?.pc.getTransceivers()[0]?.sender;
  if (!sender || !mic || sender.track === mic.out) return;
  await sender.replaceTrack(mic.out).catch(() => undefined);
}

function applyGate(): void {
  const param = mic?.gate?.parameters.get('threshold');
  if (!param || !mic?.ctx) return;
  const db = store.get(voiceGateAtom);
  const open = store.get(voiceModeAtom) === 'ptt' || db <= FLOOR_DB;
  param.setValueAtTime(open ? 0 : 10 ** (db / 20), mic.ctx.currentTime);
}

const NOT_TYPED = new Set(['button', 'checkbox', 'radio', 'range', 'color', 'file', 'image', 'reset', 'submit']);

function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  return target instanceof HTMLInputElement && !NOT_TYPED.has(target.type);
}

let pttListening = false;
let pttRelease: ReturnType<typeof setTimeout> | null = null;

function setHeld(held: boolean): void {
  if (pttRelease) clearTimeout(pttRelease);
  pttRelease = null;
  if (store.get(voicePttHeldAtom) === held) return;
  store.set(voicePttHeldAtom, held);
  applyMic();
}

function letGo(): void {
  if (!store.get(voicePttHeldAtom) || pttRelease) return;
  pttRelease = setTimeout(() => setHeld(false), store.get(voicePttDelayAtom));
}

function onPttDown(e: KeyboardEvent): void {
  if (e.code !== store.get(voicePttKeyAtom) || typing(e.target)) return;
  e.preventDefault();
  setHeld(true);
}

function onPttUp(e: KeyboardEvent): void {
  if (e.code === store.get(voicePttKeyAtom)) letGo();
}

function onPttLost(): void {
  if (document.visibilityState === 'hidden' || !document.hasFocus()) letGo();
}

function syncPtt(): void {
  const want = live !== null && store.get(voiceModeAtom) === 'ptt';
  if (want === pttListening) return;
  pttListening = want;
  if (want) {
    window.addEventListener('keydown', onPttDown);
    window.addEventListener('keyup', onPttUp);
    window.addEventListener('blur', onPttLost);
    document.addEventListener('visibilitychange', onPttLost);
  } else {
    window.removeEventListener('keydown', onPttDown);
    window.removeEventListener('keyup', onPttUp);
    window.removeEventListener('blur', onPttLost);
    document.removeEventListener('visibilitychange', onPttLost);
    setHeld(false);
  }
}
