import { atom } from 'jotai';

import { api, ApiError, type DirectGrant, messageOf, type RelayGrant, type RelayStatus } from '@/infra/api';
import { restreamDirectAtom } from '@/infra/atoms/settings-atoms';
import type { DirectSender, DirectStatus } from '@/infra/desktop/direct';
import { HERE } from '@/infra/here';
import { type Box, fitOf, isVideoLayer, type Layer, type Scene } from '@/infra/relay';
import Clock from '@/infra/restream-clock.worker?worker';
import { store } from '@/infra/store';
import { inTauri } from '@/infra/update-check';
import { colorOf } from '@/shared-components/GeneratedAvatar';

export type RestreamState = 'off' | 'starting' | 'on' | 'retrying';
export const restreamAtom = atom<RestreamState>('off');
export const restreamMessageAtom = atom('');
export const directStatusAtom = atom<Record<string, RelayStatus>>({});

const FPS = 30;
const VIDEO_BITRATE = 4_500_000;
const START_KBPS = 2500;
const MIN_KBPS = 1500;
const AUDIO_BITRATE = 128_000;
const DIRECT_AUDIO_KBPS = 160;
const NO_H264 = `${HERE} cannot send h.264`;
const ICE_WAIT_MS = 2000;
const RETRY_MS = [2000, 5000, 15000, 30000];
const LOST_MS = 8000;
const AVATAR_FILL = 0.84;
const IDLE_MS = 5000;

export interface RestreamInputs {
  name: string;
  owner: { session: number; token: number };
  sound: MediaStreamTrack | null;
  scene: () => Scene;
  streamFor: (slot: number) => MediaStream | null;
  imageUrl: (asset: number) => string;
  avatar: () => { name: string; version: number | null };
  avatarUrl: (name: string, version: number) => string;
}

export function restreamSize(): { width: number; height: number } {
  const phone = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const strong = (navigator.hardwareConcurrency ?? 4) >= 8;
  return !phone && strong ? { width: 1920, height: 1080 } : { width: 1280, height: 720 };
}

export function fitRect(srcW: number, srcH: number, box: Box, cover: boolean): [number, number, number, number, number, number, number, number] {
  if (srcW <= 0 || srcH <= 0 || box.w <= 0 || box.h <= 0) return [0, 0, 0, 0, box.x, box.y, 0, 0];
  if (cover) {
    const scale = Math.max(box.w / srcW, box.h / srcH);
    const sw = box.w / scale;
    const sh = box.h / scale;
    return [(srcW - sw) / 2, (srcH - sh) / 2, sw, sh, box.x, box.y, box.w, box.h];
  }
  const scale = Math.min(box.w / srcW, box.h / srcH);
  const dw = srcW * scale;
  const dh = srcH * scale;
  return [0, 0, srcW, srcH, box.x + (box.w - dw) / 2, box.y + (box.h - dh) / 2, dw, dh];
}

export function h264First(codecs: RTCRtpCodec[]): RTCRtpCodec[] {
  const h264 = codecs.filter((c) => c.mimeType.toLowerCase() === 'video/h264');
  const rank = (c: RTCRtpCodec) => {
    const f = c.sdpFmtpLine ?? '';
    return (f.includes('packetization-mode=1') ? 0 : 2) + (f.includes('profile-level-id=42e01f') ? 0 : 1);
  };
  const extras = codecs.filter((c) => ['video/rtx', 'video/red', 'video/ulpfec'].includes(c.mimeType.toLowerCase()));
  return h264.length ? [...h264.sort((a, b) => rank(a) - rank(b)), ...extras] : [];
}

function radiusOf(side: number): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--r-avatar').trim();
  const n = parseFloat(raw);
  if (!Number.isFinite(n)) return side / 2;
  const px = raw.endsWith('rem') ? n * parseFloat(getComputedStyle(document.documentElement).fontSize || '16') : n;
  return Math.min(side / 2, px * (side / 48));
}

class Compositor {
  readonly canvas: HTMLCanvasElement;
  readonly track: MediaStreamTrack;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly videos = new Map<string, { el: HTMLVideoElement; used: number }>();
  private readonly images = new Map<string, HTMLImageElement>();
  private readonly clock: Worker;
  private readonly inputs: RestreamInputs;
  onDraw: ((canvas: HTMLCanvasElement) => void) | null = null;

  constructor(inputs: RestreamInputs, width: number, height: number) {
    this.inputs = inputs;
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    const ctx = this.canvas.getContext('2d', { alpha: false, desynchronized: true });
    if (!ctx) throw new Error('no canvas');
    this.ctx = ctx;
    const stream = this.canvas.captureStream(0);
    const track = stream.getVideoTracks()[0];
    if (!track) throw new Error('no canvas track');
    track.contentHint = 'motion';
    this.track = track;
    this.draw();
    this.clock = new Clock();
    this.clock.onmessage = () => this.draw();
    this.clock.postMessage(FPS);
  }

  stop() {
    this.clock.postMessage(0);
    this.clock.terminate();
    this.track.stop();
    for (const { el } of this.videos.values()) {
      el.pause();
      el.srcObject = null;
    }
    this.videos.clear();
    this.images.clear();
  }

  private video(stream: MediaStream): HTMLVideoElement | null {
    const now = performance.now();
    let entry = this.videos.get(stream.id);
    if (!entry) {
      const el = document.createElement('video');
      el.muted = true;
      el.playsInline = true;
      el.autoplay = true;
      el.srcObject = stream;
      void el.play().catch(() => undefined);
      entry = { el, used: now };
      this.videos.set(stream.id, entry);
    }
    entry.used = now;
    const el = entry.el;
    return el.readyState >= 2 && el.videoWidth > 0 ? el : null;
  }

  private image(url: string): HTMLImageElement | null {
    let img = this.images.get(url);
    if (!img) {
      img = new Image();
      img.crossOrigin = 'anonymous';
      img.decoding = 'async';
      img.src = url;
      this.images.set(url, img);
    }
    return img.complete && img.naturalWidth > 0 ? img : null;
  }

  private boxOf(l: Box): Box {
    const { width, height } = this.canvas;
    return { x: l.x * width, y: l.y * height, w: l.w * width, h: l.h * height };
  }

  private drawVideo(stream: MediaStream | null, box: Box, cover: boolean) {
    const el = stream && this.video(stream);
    if (!el) return;
    const [sx, sy, sw, sh, dx, dy, dw, dh] = fitRect(el.videoWidth, el.videoHeight, box, cover);
    if (dw > 0 && dh > 0) this.ctx.drawImage(el, sx, sy, sw, sh, dx, dy, dw, dh);
  }

  private drawAvatar(box: Box) {
    const ctx = this.ctx;
    const { name, version } = this.inputs.avatar();
    const side = Math.min(box.w, box.h) * AVATAR_FILL;
    const x = box.x + (box.w - side) / 2;
    const y = box.y + (box.h - side) / 2;
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x, y, side, side, radiusOf(side));
    ctx.clip();
    const img = version !== null ? this.image(this.inputs.avatarUrl(name, version)) : null;
    const key = name.trim().toLowerCase();
    if (img) {
      const [sx, sy, sw, sh, dx, dy, dw, dh] = fitRect(img.naturalWidth, img.naturalHeight, { x, y, w: side, h: side }, true);
      ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
    } else {
      ctx.fillStyle = key ? colorOf(key) : '#333';
      ctx.fillRect(x, y, side, side);
      ctx.fillStyle = 'white';
      ctx.font = `600 ${Math.round(side * 0.56)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(key ? [...key][0]!.toUpperCase() : '?', x + side / 2, y + side / 2);
    }
    ctx.restore();
  }

  private drawLayer(layer: Layer) {
    const box = this.boxOf(layer);
    if (layer.kind !== 'avatar') {
      this.ctx.fillStyle = '#000';
      this.ctx.fillRect(box.x, box.y, box.w, box.h);
    }
    if (isVideoLayer(layer)) this.drawVideo(this.inputs.streamFor(layer.slot), box, fitOf(layer) === 'cover');
    else if (layer.kind === 'image') {
      const img = this.image(this.inputs.imageUrl(layer.asset));
      if (img) this.ctx.drawImage(img, box.x, box.y, box.w, box.h);
    } else this.drawAvatar(box);
  }

  draw() {
    const ctx = this.ctx;
    const { width, height } = this.canvas;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);
    const layers = this.inputs.scene().layers;
    if (layers.length === 0) this.drawVideo(this.inputs.streamFor(0), { x: 0, y: 0, w: width, h: height }, false);
    for (const layer of layers) this.drawLayer(layer);
    const now = performance.now();
    for (const [id, entry] of this.videos) {
      if (now - entry.used < IDLE_MS) continue;
      entry.el.srcObject = null;
      this.videos.delete(id);
    }
    const t = this.track as MediaStreamTrack & { requestFrame?: () => void };
    t.requestFrame?.();
    this.onDraw?.(this.canvas);
  }
}

function silence(): MediaStreamTrack | null {
  try {
    const ctx = new AudioContext({ sampleRate: 48000 });
    const dest = ctx.createMediaStreamDestination();
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const osc = ctx.createOscillator();
    osc.connect(gain).connect(dest);
    osc.start();
    return dest.stream.getAudioTracks()[0] ?? null;
  } catch {
    return null;
  }
}

async function iceDone(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return;
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ICE_WAIT_MS);
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState !== 'complete') return;
      clearTimeout(t);
      resolve();
    });
  });
}

async function whip(grant: RelayGrant, video: MediaStreamTrack, audio: MediaStreamTrack | null): Promise<{ pc: RTCPeerConnection; resource: string | null }> {
  const codecs = h264First(RTCRtpSender.getCapabilities('video')?.codecs ?? []);
  if (!codecs.length) throw new Error(NO_H264);
  const pc = new RTCPeerConnection();
  try {
    const v = pc.addTransceiver(video, { direction: 'sendonly', sendEncodings: [{ maxBitrate: VIDEO_BITRATE, maxFramerate: FPS }] });
    v.setCodecPreferences(codecs);
    if (audio) pc.addTransceiver(audio, { direction: 'sendonly', sendEncodings: [{ maxBitrate: AUDIO_BITRATE }] });
    else pc.addTransceiver('audio', { direction: 'sendonly' });
    await pc.setLocalDescription(await pc.createOffer());
    await iceDone(pc);
    const res = await fetch(grant.whip, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp', Authorization: `Bearer ${grant.token}` },
      body: pc.localDescription?.sdp ?? ''
    });
    if (!res.ok) throw new Error(res.status === 401 ? 'the relay did not take this stream' : `the relay said ${res.status}`);
    const answer = await res.text();
    await pc.setRemoteDescription({ type: 'answer', sdp: withStartBitrate(answer) });
    const location = res.headers.get('location');
    const resource = location ? new URL(location, grant.whip).toString() : null;
    const params = v.sender.getParameters();
    params.degradationPreference = 'maintain-resolution';
    await v.sender.setParameters(params).catch(() => undefined);
    return { pc, resource };
  } catch (err) {
    pc.close();
    throw err;
  }
}

interface Running {
  inputs: RestreamInputs;
  compositor: Compositor | null;
  pc: RTCPeerConnection | null;
  resource: string | null;
  token: string | null;
  silent: MediaStreamTrack | null;
  tries: number;
  timer: ReturnType<typeof setTimeout> | null;
  lostAt: number;
  direct: DirectSender | null;
  note: string;
}

let running: Running | null = null;

function say(state: RestreamState, message: string) {
  store.set(restreamAtom, state);
  store.set(restreamMessageAtom, message);
}

function dropPeer(r: Running) {
  if (r.pc) {
    r.pc.onconnectionstatechange = null;
    r.pc.close();
    r.pc = null;
  }
  if (r.resource) {
    const headers: Record<string, string> = r.token ? { Authorization: `Bearer ${r.token}` } : {};
    void fetch(r.resource, { method: 'DELETE', headers }).catch(() => undefined);
    r.resource = null;
  }
}

function later(r: Running, why: string) {
  if (running !== r) return;
  dropPeer(r);
  const wait = RETRY_MS[Math.min(r.tries, RETRY_MS.length - 1)]!;
  r.tries += 1;
  say('retrying', `${why}. trying the relay again in ${Math.round(wait / 1000)}s`);
  if (r.timer) clearTimeout(r.timer);
  r.timer = setTimeout(() => void connect(r), wait);
}

async function connect(r: Running): Promise<void> {
  if (running !== r) return;
  let grant: RelayGrant;
  try {
    grant = await api.relayStart(r.inputs.name, r.inputs.owner.session, r.inputs.owner.token, r.inputs.name);
  } catch (err) {
    if (running !== r) return;
    if (err instanceof ApiError && (err.status === 404 || err.status === 409 || err.status === 401 || err.status === 403)) {
      const note = err.status === 404 ? r.note : '';
      stopRestream({ quiet: true });
      if (note) say('off', note);
      return;
    }
    later(r, `could not start the relay: ${messageOf(err)}`);
    return;
  }
  if (running !== r) return;
  try {
    if (!r.compositor) {
      const { width, height } = restreamSize();
      r.compositor = new Compositor(r.inputs, width, height);
    }
    const audio = r.inputs.sound ?? (r.silent ??= silence());
    const { pc, resource } = await whip(grant, r.compositor.track, audio);
    if (running !== r) {
      pc.close();
      return;
    }
    r.pc = pc;
    r.resource = resource;
    r.token = grant.token;
    r.lostAt = 0;
    say('starting', 'sending to the relay');
    pc.onconnectionstatechange = () => {
      if (running !== r || r.pc !== pc) return;
      const s = pc.connectionState;
      if (s === 'connected') {
        r.tries = 0;
        r.lostAt = 0;
        say('on', '');
      } else if (s === 'failed') later(r, 'the relay connection failed');
      else if (s === 'disconnected') {
        r.lostAt = performance.now();
        setTimeout(() => {
          if (running === r && r.pc === pc && pc.connectionState === 'disconnected' && performance.now() - r.lostAt >= LOST_MS) later(r, 'the relay connection dropped');
        }, LOST_MS);
      }
    };
  } catch (err) {
    if (running !== r) return;
    if (messageOf(err) === NO_H264) {
      stopRestream({ quiet: true });
      say('off', `${NO_H264}, so only slop gets the stream`);
      return;
    }
    later(r, messageOf(err));
  }
}

export function startRestream(inputs: RestreamInputs) {
  stopRestream({ quiet: true });
  if (typeof RTCPeerConnection === 'undefined' || typeof HTMLCanvasElement.prototype.captureStream !== 'function') return;
  const r: Running = { inputs, compositor: null, pc: null, resource: null, token: null, silent: null, tries: 0, timer: null, lostAt: 0, direct: null, note: '' };
  running = r;
  say('starting', directWanted() ? `starting to send from ${HERE}` : 'starting the relay');
  void begin(r);
}

export function directWanted(): boolean {
  return inTauri() && store.get(restreamDirectAtom);
}

async function begin(r: Running) {
  const handled = directWanted() ? await connectDirect(r).catch((err: unknown) => directFailed(r, messageOf(err))) : false;
  if (handled || running !== r) return;
  if (r.note) say('starting', r.note);
  void connect(r).catch((err: unknown) => later(r, messageOf(err)));
}

function directFailed(r: Running, why: string): boolean {
  r.direct?.stop();
  r.direct = null;
  r.note = `${HERE} could not send straight to your destinations (${why}), so it goes through the relay`;
  return false;
}

function statusesOf(list: DirectStatus[]): Record<string, RelayStatus> {
  const out: Record<string, RelayStatus> = {};
  for (const s of list) out[s.id] = { state: s.state, message: s.message };
  return out;
}

async function connectDirect(r: Running): Promise<boolean> {
  const { width, height } = restreamSize();
  const shape = { width, height, fps: FPS, videoKbps: Math.round(VIDEO_BITRATE / 1000), audioKbps: DIRECT_AUDIO_KBPS };
  const direct = await import('@/infra/desktop/direct');
  const config = await direct.directVideoConfig(shape);
  if (running !== r) return true;
  if (!config) {
    r.note = `${HERE} cannot encode h.264 and aac here (it needs macOS with Safari 26 or newer, or the latest app), so it goes through the relay`;
    return false;
  }
  let grant: DirectGrant;
  try {
    grant = await api.relayDirect(r.inputs.name, r.inputs.owner.session, r.inputs.owner.token, r.inputs.name);
  } catch (err) {
    if (running !== r) return true;
    if (err instanceof ApiError && err.status === 404) return false;
    if (err instanceof ApiError && (err.status === 409 || err.status === 401 || err.status === 403)) {
      stopRestream({ quiet: true });
      return true;
    }
    throw err;
  }
  if (running !== r) return true;
  if (!grant.targets.length) {
    say('off', 'none of your destinations could be reached');
    return true;
  }
  if (!r.compositor) r.compositor = new Compositor(r.inputs, width, height);
  const sender = await direct.DirectSender.open(
    grant.targets,
    shape,
    config,
    r.inputs.sound,
    (list) => {
      if (running === r) store.set(directStatusAtom, statusesOf(list));
    },
    (why) => {
      if (running !== r) return;
      directFailed(r, why);
      if (r.compositor) r.compositor.onDraw = null;
      say('retrying', r.note);
      void connect(r).catch((err: unknown) => later(r, messageOf(err)));
    }
  );
  if (running !== r) {
    sender.stop();
    return true;
  }
  r.direct = sender;
  r.compositor.onDraw = (canvas) => r.direct?.frame(canvas);
  say('on', '');
  return true;
}

export function stopRestream({ quiet = false }: { quiet?: boolean } = {}) {
  const r = running;
  running = null;
  if (r) {
    if (r.timer) clearTimeout(r.timer);
    dropPeer(r);
    r.direct?.stop();
    r.direct = null;
    r.compositor?.stop();
    r.silent?.stop();
    if (!quiet) void api.relayStop().catch(() => undefined);
  }
  store.set(directStatusAtom, {});
  say('off', '');
}

export const restreamRunning = () => running !== null;

export function withStartBitrate(sdp: string): string {
  const h264 = new Set<string>();
  for (const m of sdp.matchAll(/^a=rtpmap:(\d+) H264\/90000/gim)) if (m[1]) h264.add(m[1]);
  return sdp.replace(/^a=fmtp:(\d+) (.*)$/gim, (line, pt: string, rest: string) =>
    h264.has(pt) && !rest.includes('x-google-start-bitrate') ? `a=fmtp:${pt} ${rest};x-google-start-bitrate=${START_KBPS};x-google-min-bitrate=${MIN_KBPS}` : line
  );
}
