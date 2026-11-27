import type { GroupBadge } from '@/infra/api';

export type Presence = 'offline' | 'online' | 'dnd' | 'streaming';
export type PresenceChoice = 'online' | 'dnd' | 'invisible';
export type NotificationKind = 'live' | 'follow' | 'dm' | 'chat' | 'mention';

export type ClientFrame = { type: 'hello'; nick?: string } | { type: 'watch'; name: string } | { type: 'unwatch'; name: string };

export function groupTopic(name: string): string {
  return `group:${name}`;
}

export interface HeldRole {
  id: string;
  name: string;
  color: string;
}

export type GroupChange =
  | { what: 'joined'; who: string; avatar: number | null; joined: number; members: number }
  | { what: 'left'; who: string; by: 'leave' | 'kick'; members: number }
  | { what: 'banned'; who: string; reason: string; members: number }
  | { what: 'unbanned'; who: string }
  | {
      what: 'channel';
      channel: { name: string; about: string; made_by: string | null; cooldown?: number; kind?: 'text' | 'voice'; user_limit?: number; home?: boolean };
    }
  | { what: 'unchannel'; channel: string }
  | { what: 'channel_cooldown'; channel: string; cooldown: number }
  | { what: 'channel_renamed'; channel: string; name: string }
  | { what: 'channel_about'; channel: string; about: string }
  | { what: 'channel_order'; order: string[] }
  | { what: 'about'; about: string }
  | { what: 'color'; color: string }
  | { what: 'access'; public: boolean }
  | { what: 'adult'; adult: boolean; locked?: boolean }
  | { what: 'order'; order: string }
  | { what: 'icon'; icon: number }
  | { what: 'banner'; banner: number }
  | {
      what: 'role';
      role: HeldRole & { perms: { appearance: boolean; roles: boolean; channels: boolean; kick: boolean; ban: boolean }; channels?: string[]; cooldown?: number };
    }
  | { what: 'timeout'; who: string; until: number | null }
  | { what: 'unrole'; id: string }
  | { what: 'held'; who: string; role: HeldRole }
  | { what: 'unheld'; who: string; id: string }
  | { what: 'owner'; who: string; owner: boolean }
  | { what: 'owner_role'; name: string }
  | { what: 'live'; who: string }
  | { what: 'ended'; who: string }
  | { what: 'pin'; channel: string; id: string }
  | { what: 'unpin'; channel: string; id: string }
  | { what: 'voice_mute'; who: string; uid: string; muted: boolean }
  | { what: 'voice'; who: string; uid: string; channel: string; muted?: boolean }
  | { what: 'voice_left'; who: string; uid: string; channel: string }
  | { what: 'deleted' };

export type CallChange =
  | { what: 'ringing'; id: string; server: string; channel: string; avatar: number | null; ring: number }
  | { what: 'accepted'; id: string; server: string; channel: string }
  | { what: 'declined' | 'missed' | 'ended'; id: string; server: string; channel: string; secs: number | null }
  | { what: 'voice' | 'voice_left'; server: string; who: string; uid: string; channel: string };

export type ServerFrame =
  | { type: 'me'; name: string | null; presence: Presence; status: PresenceChoice }
  | { type: 'presence'; name: string; presence: Presence }
  | { type: 'live'; name: string; since: number; verified?: boolean; avatar?: number | null; bio?: string; thumbs?: number[]; badge?: GroupBadge | null }
  | { type: 'ended'; name: string }
  | { type: 'viewers'; name: string; viewers: number }
  | { type: 'renamed'; name: string; to: string }
  | {
      type: 'dm';
      id: number;
      from: string;
      to: string;
      text: string;
      at: number;
      from_id?: string;
      images?: string[];
      video?: { id: string; poster: string };
      reply?: { id: number; from?: string; text?: string; avatar?: number | null; images?: number; video?: boolean; gone?: boolean } | null;
      mentions?: string[];
      call?: unknown;
    }
  | { type: 'dm_react'; id: number; from: string; to: string; emoji: string; on: boolean }
  | { type: 'dm_embed'; id: number; from: string; to: string; embed: unknown }
  | { type: 'dm_read'; name: string; peer: string; peer_id: string; id: number }
  | {
      type: 'notification';
      id: number;
      kind: NotificationKind;
      name: string;
      actor: string;
      verified: boolean;
      avatar: number | null;
      at: number;
      text: string;
      session: number | null;
      room?: string;
    }
  | { type: 'notify_read'; name: string; id: number }
  | { type: 'notify_removed'; name: string; id: number }
  | { type: 'chat_read'; name: string; room: string }
  | ({ type: 'group'; group: string } & GroupChange)
  | ({ type: 'call'; caller: string; callee: string } & CallChange)
  | { type: 'error'; error: string };

export type LinkPhase = 'off' | 'connecting' | 'open' | 'closed';

export function socketUrl(path: string, href: string): string {
  const u = new URL(path, href);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return u.href;
}

export function parseServerFrame(data: unknown): ServerFrame | null {
  if (typeof data !== 'string') return null;
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || typeof (raw as { type?: unknown }).type !== 'string') return null;
  return raw as ServerFrame;
}

export type ToWorker =
  | { kind: 'attach'; nick: string | null; inspector: boolean }
  | { kind: 'hello'; nick: string | null }
  | { kind: 'watch'; name: string }
  | { kind: 'unwatch'; name: string }
  | { kind: 'ping' }
  | { kind: 'bye' }
  | { kind: 'inspector'; on: boolean }
  | { kind: 'record'; entry: FrameEntry }
  | { kind: 'snapshot' }
  | { kind: 'clear' };

export type FromWorker =
  | { kind: 'link'; phase: LinkPhase }
  | { kind: 'frame'; frame: ServerFrame }
  | { kind: 'entries'; entries: FrameEntry[] }
  | { kind: 'entry'; entry: FrameEntry }
  | { kind: 'cleared' };

export const TAB_PING_MS = 15_000;
export const TAB_DEAD_MS = 60_000;

export interface FrameEntry {
  at: number;
  source: string;
  dir: 'in' | 'out' | 'link';
  type: string;
  text: string;
  bytes: number;
}

export const RING_SIZE = 1000;
const CLIP_AT = 2048;

export class Ring {
  private readonly buf: (FrameEntry | undefined)[] = Array.from({ length: RING_SIZE });
  private head = 0;
  count = 0;
  version = 0;

  push(entry: FrameEntry): void {
    this.buf[this.head] = entry;
    this.head = (this.head + 1) % RING_SIZE;
    this.count = Math.min(this.count + 1, RING_SIZE);
    this.version++;
  }

  at(i: number): FrameEntry | undefined {
    if (i < 0 || i >= this.count) return undefined;
    return this.buf[(this.head - 1 - i + 2 * RING_SIZE) % RING_SIZE];
  }

  toArray(): FrameEntry[] {
    const out: FrameEntry[] = [];
    for (let i = this.count - 1; i >= 0; i--) {
      const e = this.at(i);
      if (e) out.push(e);
    }
    return out;
  }

  clear(): void {
    this.buf.fill(undefined);
    this.head = 0;
    this.count = 0;
    this.version++;
  }
}

export function makeEntry(source: string, dir: FrameEntry['dir'], frame: unknown): FrameEntry {
  let text: string;
  let type = '';
  if (typeof frame === 'string') {
    text = frame;
    try {
      const parsed = JSON.parse(frame) as unknown;
      type = typeOf(parsed);
      text = JSON.stringify(redact(parsed));
    } catch {
    }
  } else {
    type = typeOf(frame);
    text = JSON.stringify(redact(frame)) ?? String(frame);
  }
  const bytes = text.length;
  if (text.length > CLIP_AT) text = `${text.slice(0, CLIP_AT)}…`;
  return { at: Date.now(), source, dir, type, text, bytes };
}

function typeOf(frame: unknown): string {
  if (!frame || typeof frame !== 'object') return typeof frame;
  const f = frame as Record<string, unknown>;
  for (const key of ['type', 'event', 'role', 'kind']) {
    if (typeof f[key] === 'string') return f[key];
  }
  if ('sdp' in f) return 'sdp';
  if ('slots' in f) return 'slots';
  return Object.keys(f)[0] ?? 'object';
}

function redact(frame: unknown): unknown {
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return frame;
  const out: Record<string, unknown> = { ...(frame as Record<string, unknown>) };
  if ('token' in out) out.token = '…';
  if ('ticket' in out) out.ticket = '…';
  if (typeof out.sdp === 'string' && out.sdp.length > 120) out.sdp = `${out.sdp.slice(0, 120)}… (${out.sdp.length} chars)`;
  return out;
}
