/**
 * The frames on the `/events` socket (docs/status.md), the envelope between a tab and the
 * events worker, and the ring the inspector keeps. Pure: no store, no react, no dom, so the
 * worker bundle can import it too.
 */

export type Presence = 'offline' | 'online' | 'dnd' | 'streaming';
/** The one you pick. `invisible` shows as `offline` to everyone else. */
export type PresenceChoice = 'online' | 'dnd' | 'invisible';
/** What can happen to a login (docs/notifications.md): someone they follow went live, someone followed them, a friend wrote, someone wrote in a channel of a group they are in. */
export type NotificationKind = 'live' | 'follow' | 'dm' | 'chat';

/** `watch` takes a name, `*` for every name's `live`, `ended` and `viewers` (the home page's feed), or `group:<name>` for a group's changes (a room's feed). */
export type ClientFrame = { type: 'hello'; nick?: string } | { type: 'watch'; name: string } | { type: 'unwatch'; name: string };

/** The `watch` that is one group's room: its `group` frames, and `live` / `ended` for its members. */
export function groupTopic(name: string): string {
  return `group:${name}`;
}

/** The roles a member holds, as a `group` frame and the roster name them. `id` is the role's uuid. */
export interface HeldRole {
  id: string;
  name: string;
  color: string;
}

/**
 * One change to a group (docs/groups.md), spread into a `group` frame beside `group` and `what`.
 * `members` is the count after the change, so a room never counts on its own. `who` is a name
 * as it is now. The room patches what it holds; a change about the login itself (its own
 * membership, powers or roles) makes it ask the room again, since what it may see depends.
 */
export type GroupChange =
  | { what: 'joined'; who: string; avatar: number | null; joined: number; members: number }
  | { what: 'left'; who: string; by: 'leave' | 'kick'; members: number }
  | { what: 'banned'; who: string; reason: string; members: number }
  | { what: 'unbanned'; who: string }
  | { what: 'channel'; channel: { name: string; about: string; made_by: string | null } }
  | { what: 'unchannel'; channel: string }
  /** The channels put in this order, every one of them, from the top. */
  | { what: 'channel_order'; order: string[] }
  | { what: 'about'; about: string }
  | { what: 'access'; public: boolean }
  | { what: 'order'; order: string }
  | { what: 'icon'; icon: number }
  | { what: 'banner'; banner: number }
  | { what: 'role'; role: HeldRole & { perms: { appearance: boolean; roles: boolean; channels: boolean; kick: boolean; ban: boolean } } }
  | { what: 'unrole'; id: string }
  | { what: 'held'; who: string; role: HeldRole }
  | { what: 'unheld'; who: string; id: string }
  | { what: 'owner'; who: string; owner: boolean }
  /** A member went live, or stopped: the room's faces. */
  | { what: 'live'; who: string }
  | { what: 'ended'; who: string }
  | { what: 'deleted' };

export type ServerFrame =
  | { type: 'me'; name: string | null; presence: Presence; status: PresenceChoice }
  | { type: 'presence'; name: string; presence: Presence }
  /** A stream started. The card fields ride along for home (absent from an older gateway). */
  | { type: 'live'; name: string; since: number; verified?: boolean; avatar?: number | null; bio?: string; thumbs?: number[] }
  | { type: 'ended'; name: string }
  /** How many are receiving a stream now, as video counts them. To the name's watchers and to `watch *`. */
  | { type: 'viewers'; name: string; viewers: number }
  /** `name` became `to` (docs/ids.md): to the account's own sockets and to `name`'s watchers. */
  | { type: 'renamed'; name: string; to: string }
  /** A direct message (docs/dms.md), to the sockets of both names: every device of either sees the same line. `from_id` is the writer's account; an older gateway leaves it off. */
  | { type: 'dm'; id: number; from: string; to: string; text: string; at: number; from_id?: string }
  /** `name` read its thread with `peer` up to `id` on some device: the others drop their count. `peer_id` is that account; an older gateway leaves it off. */
  | { type: 'dm_read'; name: string; peer: string; peer_id: string; id: number }
  /** A row of the login's inbox (docs/notifications.md), to its own sockets. `name` is who did it, `actor` their id; `at` unix ms; `text` a dm's or a channel line's words; `session` a go-live's; `room` a `chat` row's `<server>/<channel>`. An older gateway leaves `actor` and `room` off. */
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
  /** `name` saw its inbox up to `id` on some device: the others drop their count. */
  | { type: 'notify_read'; name: string; id: number }
  /** `name` had the channel `room` (`<server>/<channel>`) on screen on some device: its `chat` rows for it are read there too. */
  | { type: 'chat_read'; name: string; room: string }
  /** A group changed (docs/groups.md), to the sockets watching `group:<group>`. `what` says how; the rest is the change. */
  | ({ type: 'group'; group: string } & GroupChange)
  | { type: 'error'; error: string };

export type LinkPhase = 'off' | 'connecting' | 'open' | 'closed';

/** '/events' -> 'wss://<host>/events' (ws:// on the http dev server), from a window's location or a worker's. */
export function socketUrl(path: string, href: string): string {
  const u = new URL(path, href);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return u.href;
}

/** Unknown frames are dropped on both sides; a known one has a `type` the page handles. */
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

// ---- tab ↔ worker ----------------------------------------------------------------------------

/** What a tab tells the worker. */
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

/** What the worker tells a tab. */
export type FromWorker =
  | { kind: 'link'; phase: LinkPhase }
  | { kind: 'frame'; frame: ServerFrame }
  | { kind: 'entries'; entries: FrameEntry[] }
  | { kind: 'entry'; entry: FrameEntry }
  | { kind: 'cleared' };

/** A tab that said nothing for this long is gone: its port is dropped and its watches with it. */
export const TAB_PING_MS = 15_000;
export const TAB_DEAD_MS = 60_000;

// ---- the ring ------------------------------------------------------------------------------

/** One frame, as the inspector shows it. `text` is the clipped json; `bytes` the real size. */
export interface FrameEntry {
  at: number;
  /** `/events`, `/chat/<name>`, `/ws`. */
  source: string;
  dir: 'in' | 'out' | 'link';
  type: string;
  text: string;
  bytes: number;
}

export const RING_SIZE = 1000;
/** A body longer than this is clipped in the ring (the video offer is up to 48 KB, a chat history 200 lines). */
const CLIP_AT = 2048;

/**
 * The last RING_SIZE entries in a fixed array that eats its own tail: O(1) push, newest-first
 * iteration with no allocation. A module handle on both sides, never in an atom (a copy of a
 * thousand entries per frame is what the chat's slice-per-line would cost here).
 */
export class Ring {
  private readonly buf: (FrameEntry | undefined)[] = Array.from({ length: RING_SIZE });
  private head = 0;
  count = 0;
  /** Bumped on every push and clear. The page renders when it changes. */
  version = 0;

  push(entry: FrameEntry): void {
    this.buf[this.head] = entry;
    this.head = (this.head + 1) % RING_SIZE;
    this.count = Math.min(this.count + 1, RING_SIZE);
    this.version++;
  }

  /** `at(0)` is the newest, `at(count - 1)` the oldest. */
  at(i: number): FrameEntry | undefined {
    if (i < 0 || i >= this.count) return undefined;
    return this.buf[(this.head - 1 - i + 2 * RING_SIZE) % RING_SIZE];
  }

  /** Oldest first, the order a log reads in. */
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

/**
 * An entry from a frame, with the credential taken out before it is anywhere: the chat hello
 * and the video publish frame carry the go-live `token`, which stops and republishes a stream.
 * Clipped at CLIP_AT with the true size kept.
 */
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
      // not json: shown as it came
    }
  } else {
    type = typeOf(frame);
    text = JSON.stringify(redact(frame)) ?? String(frame);
  }
  const bytes = text.length;
  if (text.length > CLIP_AT) text = `${text.slice(0, CLIP_AT)}…`;
  return { at: Date.now(), source, dir, type, text, bytes };
}

/** The frame's kind: `type`, else `event`, else `role` (the video setup frame), else the first key. */
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
  if (typeof out.sdp === 'string' && out.sdp.length > 120) out.sdp = `${out.sdp.slice(0, 120)}… (${out.sdp.length} chars)`;
  return out;
}
