import { record } from '@/infra/atoms/inspector-atoms';
import { type AvatarLook, readAvatarLook } from '@/infra/avatar-look';
import { trackSocket } from '@/infra/debug/sockets';
import { type Box, clampBox, type Fit, LAYER_MIN, thousandth } from '@/infra/box';
import { type ChatSpec, readChat, readText, readTextStyle, readTimer, type TextStyle, type TimerSpec } from '@/infra/text-paint';

export { type Box, clampBox, type Fit, LAYER_MIN, thousandth };

export type RelayRole = 'publish' | 'watch';

export const SCREEN_SLOTS = 3;

export interface SlotInfo {
  slot: number;
  kind: string;
  label?: string;
}

export type VideoLayer = Box & { id: string; kind: 'camera' | 'screen'; slot: number; fit?: Fit };
export type ImageLayer = Box & { id: string; kind: 'image'; asset: number };
export type AvatarLayer = Box & { id: string; kind: 'avatar'; look?: AvatarLook };
export type TextLayer = Box & { id: string; kind: 'text'; text: string; style?: TextStyle };
export type TimerLayer = Box & { id: string; kind: 'timer'; timer: TimerSpec; style?: TextStyle };
export type ChatLayer = Box & { id: string; kind: 'chat'; chat?: ChatSpec; style?: TextStyle };
export type Layer = VideoLayer | ImageLayer | AvatarLayer | TextLayer | TimerLayer | ChatLayer;
export interface Scene {
  layers: Layer[];
}

export const MAX_LAYERS = 16;
const ID_RE = /^[a-z0-9_-]{1,16}$/i;

export const isVideoLayer = (layer: Layer): layer is VideoLayer => layer.kind === 'camera' || layer.kind === 'screen';
export const isOverlayLayer = (layer: Layer): layer is TextLayer | TimerLayer | ChatLayer => layer.kind === 'text' || layer.kind === 'timer' || layer.kind === 'chat';
export const fitOf = (layer: VideoLayer): Fit => layer.fit ?? (layer.kind === 'camera' ? 'cover' : 'contain');

export interface RelayReply {
  sdp?: string;
  error?: string;
  event?: string;
  slots?: SlotInfo[];
  scene?: unknown;
  viewers?: number;
  full?: boolean;
}

export function viewersOf(msg: RelayReply): number | null {
  return typeof msg.viewers === 'number' && Number.isInteger(msg.viewers) && msg.viewers >= 0 ? msg.viewers : null;
}

export function slotsOf(msg: RelayReply): SlotInfo[] | null {
  if (!Array.isArray(msg.slots)) return null;
  return msg.slots.filter(
    (s): s is SlotInfo =>
      typeof s === 'object' &&
      s !== null &&
      Number.isInteger(s.slot) &&
      s.slot >= 0 &&
      typeof s.kind === 'string' &&
      (s.label === undefined || typeof s.label === 'string')
  );
}

const isFraction = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;

function validLayer(raw: unknown): Layer | null {
  if (!raw || typeof raw !== 'object') return null;
  const l = raw as Record<string, unknown>;
  if (typeof l.id !== 'string' || !ID_RE.test(l.id) || !isFraction(l.x) || !isFraction(l.y) || !isFraction(l.w) || !isFraction(l.h)) return null;
  const box = clampBox({ x: l.x, y: l.y, w: l.w, h: l.h });
  if (l.kind === 'camera' || l.kind === 'screen') {
    if (!Number.isInteger(l.slot) || (l.slot as number) < 0) return null;
    const fit = l.fit === 'cover' || l.fit === 'contain' ? l.fit : undefined;
    return { id: l.id, kind: l.kind, slot: l.slot as number, ...(fit && { fit }), ...box };
  }
  if (l.kind === 'image') {
    return Number.isInteger(l.asset) && (l.asset as number) > 0 ? { id: l.id, kind: 'image', asset: l.asset as number, ...box } : null;
  }
  if (l.kind === 'avatar') {
    const look = readAvatarLook(l.look);
    return { id: l.id, kind: 'avatar', ...(look && { look }), ...box };
  }
  const style = readTextStyle(l.style);
  const styled = style ? { style } : {};
  if (l.kind === 'text') {
    const text = readText(l.text);
    return text ? { id: l.id, kind: 'text', text, ...styled, ...box } : null;
  }
  if (l.kind === 'timer') {
    const timer = readTimer(l.timer);
    return timer ? { id: l.id, kind: 'timer', timer, ...styled, ...box } : null;
  }
  if (l.kind === 'chat') {
    const chat = readChat(l.chat);
    return { id: l.id, kind: 'chat', ...(chat && { chat }), ...styled, ...box };
  }
  return null;
}

export function validScene(raw: unknown): Scene | null {
  if (!raw || typeof raw !== 'object') return null;
  const { layers } = raw as { layers?: unknown };
  if (!Array.isArray(layers)) return null;
  const seen = new Set<string>();
  const kept: Layer[] = [];
  for (const entry of layers.slice(0, MAX_LAYERS)) {
    const layer = validLayer(entry);
    if (!layer || seen.has(layer.id)) continue;
    seen.add(layer.id);
    kept.push(layer);
  }
  return { layers: kept };
}

export function sceneOf(msg: RelayReply): Scene | null {
  return validScene(msg.scene);
}

export function waitForIceGathering(pc: RTCPeerConnection, capMs = 1000): Promise<void> {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', onChange);
      resolve();
    };
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') finish();
    };
    const timer = setTimeout(finish, capMs);
    pc.addEventListener('icegatheringstatechange', onChange);
  });
}

export function relayUrl(path = '/ws'): string {
  const u = new URL(path, location.href);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return u.href;
}

export function parseRelayMessage(data: unknown): RelayReply | null {
  if (typeof data !== 'string') return null;
  try {
    return JSON.parse(data) as RelayReply;
  } catch {
    return null;
  }
}

interface ConnectRelayOptions {
  role: RelayRole;
  name: string;
  pc: RTCPeerConnection;
  session?: number;
  token?: number;
  preview?: boolean;
  url?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  socket?: WebSocket;
  onPhase?: (phase: 'ws-open' | 'setup-sent' | 'answer') => void;
  onMessage?: (msg: RelayReply) => void;
}

export function connectRelay({
  role,
  name,
  pc,
  session,
  token,
  preview,
  url = '/ws',
  timeoutMs = 15000,
  signal,
  socket,
  onPhase,
  onMessage
}: ConnectRelayOptions): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = socket ?? trackSocket(preview ? 'preview' : role === 'publish' ? 'publish' : 'video', new WebSocket(relayUrl(url)), url);
    let done = false;
    const pending: RelayReply[] = [];

    const fail = (err: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ws.close();
      reject(err);
    };
    const timer = setTimeout(() => fail(new Error('server did not answer')), timeoutMs);
    if (signal) {
      if (signal.aborted) {
        fail(new Error('cancelled'));
        return;
      }
      signal.addEventListener('abort', () => fail(new Error('cancelled')), { once: true });
    }

    const sendSetup = () => {
      if (done) return;
      onPhase?.('ws-open');
      const setup = { role, name, sdp: pc.localDescription?.sdp ?? '', session, token, preview };
      record(url, 'out', setup);
      ws.send(JSON.stringify(setup));
      onPhase?.('setup-sent');
    };
    ws.onerror = () => fail(new Error('socket error'));
    ws.onclose = () => fail(new Error('socket closed'));
    if (ws.readyState === WebSocket.OPEN) sendSetup();
    else if (ws.readyState === WebSocket.CONNECTING) ws.onopen = sendSetup;
    else fail(new Error('socket closed'));
    ws.onmessage = async (e) => {
      if (done) return;
      const msg = parseRelayMessage(e.data);
      if (msg) record(url, 'in', msg);
      if (!msg) {
        fail(new Error('bad reply'));
        return;
      }
      if (msg.error) {
        fail(new Error(msg.error));
        return;
      }
      if (!msg.sdp) {
        if (onMessage) pending.push(msg);
        return;
      }
      try {
        await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      if (done) return;
      done = true;
      clearTimeout(timer);
      onPhase?.('answer');
      ws.onopen = ws.onerror = ws.onclose = null;
      ws.onmessage = onMessage
        ? (ev) => {
            const later = parseRelayMessage(ev.data);
            if (later) {
              record(url, 'in', later);
              onMessage(later);
            }
          }
        : null;
      resolve(ws);
      if (onMessage && pending.length) queueMicrotask(() => pending.forEach(onMessage));
    };
  });
}
