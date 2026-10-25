/** The json api behind /api. Same origin, so the dev server and caddy both forward it. */

import type { Presence, PresenceChoice } from '@/infra/frames';
import { report } from '@/infra/report';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

export interface LiveStream {
  name: string;
  bio: string;
  since: string | null;
  /** The name has an account, so only its owner can be behind it. */
  verified: boolean;
  /** When the picture was saved (unix seconds), the `?v=` of its url. `null`: no picture. */
  avatar: number | null;
}

export interface Streamer {
  name: string;
  bio: string;
  verified: boolean;
  avatar: number | null;
  /** The word next to the name: `offline` `online` `dnd` `streaming`. See docs/status.md. */
  presence: Presence;
}

/** A group as worn on a chat line: enough to draw the badge. */
export interface GroupBadge {
  name: string;
  /** The word on the badge. Shown in capitals. */
  badge: string;
  /** `#rrggbb` */
  color: string;
}

/** A group as `GET /api/groups` lists it. */
export interface Group extends GroupBadge {
  about: string;
  /** The login that made it. null for the built-in `bot`. */
  made_by: string | null;
  members: number;
  /** The login this list was asked with is in it. Always false for nobody. */
  mine: boolean;
  /** `bot`: nobody joins it, a chat socket that says `bot: true` wears it. */
  automatic: boolean;
}

export interface NewGroup {
  name: string;
  badge: string;
  color: string;
  about: string;
}

export interface Grant {
  url: string;
  session: number;
  token: number;
}

export interface WatchGrant {
  url: string;
  bio: string;
  live: boolean;
  verified: boolean;
  avatar: number | null;
  presence: Presence;
}

/** Proof that this page is the one that went live. Heartbeat and stop carry it. */
export interface Owner {
  name: string;
  session: number;
  token: number;
}

/** GET /api/health. `ok` is postgres and redis; the rest is for a monitor. See docs/debugging.md. */
export interface Health {
  ok: boolean;
  env: string;
  build: string;
  up_secs: number;
  postgres: boolean;
  redis: boolean;
  debug_db: boolean;
  video: boolean;
  video_up_secs: number | null;
  video_build: string | null;
  live: number | null;
  /** Reports POST /api/errors dropped in the current rate limit window (10 min). */
  errors_dropped: number;
}

/** One report a page sent to /api/errors, as /admin lists them. */
export interface ClientError {
  id: number;
  at: string;
  env: string;
  build: string | null;
  kind: string;
  page: string;
  stream: string | null;
  phase: string | null;
  me: string | null;
  ip: string | null;
  ua: string | null;
  message: string;
  stack: string | null;
  extra: Record<string, unknown> | null;
}

interface RequestOptions {
  /** `false`: a 5xx from this call is not reported to /api/errors. For the call that reads them. */
  report?: boolean;
  /** Give up after this long with no answer. For a call whose caller must move on (the watch grant: its retry loop). */
  timeoutMs?: number;
}

/**
 * A Blob goes as it is, with its own type (the picture). Anything else is json.
 *
 * A 5xx the api itself answered is the api breaking, not the person doing something wrong
 * (4xx are theirs), so it is reported, with the api's own words. Not reported: no answer at
 * all, and caddy's 502/504, because a report would die the same way; and never the query
 * string, heartbeat and stop carry the owner's token in it.
 */
async function request<T>(method: string, path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
  const raw = body instanceof Blob;
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'content-type': raw ? body.type : 'application/json' },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    signal: options.timeoutMs === undefined ? undefined : AbortSignal.timeout(options.timeoutMs)
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  const said = data && typeof data === 'object' && 'error' in data ? String((data as { error: unknown }).error) : '';
  if (options.report !== false && res.status >= 500 && res.status !== 502 && res.status !== 504) {
    report('api', `${method} ${new URL(path, location.origin).pathname}: http ${res.status}${said ? ` ${said}` : ''}`);
  }
  if (!res.ok) throw new ApiError(said || `http ${res.status}`, res.status);
  return data as T;
}

function ownerQuery(owner: Owner): string {
  return `session=${owner.session}&token=${owner.token}`;
}

export const api = {
  /** The login cookie goes along on its own (httponly, same origin). `name` is null for nobody. */
  me: () => request<{ name: string | null }>('GET', '/api/me'),
  signup: (name: string, password: string) => request<{ name: string }>('POST', '/api/signup', { name, password }),
  login: (name: string, password: string) => request<{ name: string }>('POST', '/api/login', { name, password }),
  logout: () => request<null>('POST', '/api/logout'),
  /** Every login of the account, this one included. */
  logoutAll: () => request<null>('POST', '/api/logout-all'),
  changePassword: (old: string, next: string) => request<null>('POST', '/api/password', { old, new: next }),
  /** Every group, `bot` first; `mine` says which the login is in. See docs/groups.md. */
  groups: () => request<Group[]>('GET', '/api/groups'),
  /** A login makes a group and is in it. 400 bad name/badge/colour, 409 `name taken`. */
  createGroup: (group: NewGroup) => request<Group>('POST', '/api/groups', group),
  joinGroup: (name: string) => request<null>('POST', `/api/groups/${encodeURIComponent(name)}/join`),
  leaveGroup: (name: string) => request<null>('POST', `/api/groups/${encodeURIComponent(name)}/leave`),
  /** The one who made it (or an admin). Its members are out with it. */
  deleteGroup: (name: string) => request<null>('DELETE', `/api/groups/${encodeURIComponent(name)}`),
  streams: () => request<LiveStream[]>('GET', '/api/streams'),
  streamer: (name: string) => request<Streamer>('GET', `/api/streamers/${name}`),
  saveBio: (name: string, bio: string) => request<{ name: string; bio: string }>('PUT', `/api/streamers/${name}`, { bio }),
  /** The jpeg itself as the body. The page has already made it 256x256. */
  saveAvatar: (name: string, jpeg: Blob) => request<{ name: string; avatar: number }>('PUT', `/api/streamers/${name}/avatar`, jpeg),
  deleteAvatar: (name: string) => request<null>('DELETE', `/api/streamers/${name}/avatar`),
  /** The presence choice, through the bio's gate. The answer also arrives on the events socket, to every tab and device. */
  setPresence: (name: string, status: PresenceChoice) => request<{ status: PresenceChoice; presence: Presence }>('PUT', `/api/streamers/${name}/presence`, { status }),
  /** `version` is the upload time the api hands out, so a new picture is a new url and the old one can be cached. */
  avatarUrl: (name: string, version: number) => `/api/streamers/${encodeURIComponent(name)}/avatar?v=${version}`,
  goLive: (name: string) => request<Grant>('POST', `/api/streams/${name}/go-live`),
  heartbeat: (owner: Owner) => request<{ ok: boolean }>('POST', `/api/streams/${owner.name}/heartbeat?${ownerQuery(owner)}`),
  stop: (owner: Owner) => request<{ ok: boolean }>('POST', `/api/streams/${owner.name}/stop?${ownerQuery(owner)}`),
  /** Survives page teardown, unlike fetch. */
  stopBeacon: (owner: Owner) => navigator.sendBeacon(`/api/streams/${owner.name}/stop?${ownerQuery(owner)}`),
  /** Bounded: the watch page keeps a grant in flight as "under way", so one must always land or fail. */
  watch: (name: string) => request<WatchGrant>('POST', `/api/streams/${name}/watch`, undefined, { timeoutMs: 15000 }),
  /** The picture of a stream, made on the video machine. `bucket` changes every few seconds so the browser re-fetches. */
  thumbUrl: (name: string, bucket: number) => `/thumb/${encodeURIComponent(name)}.jpg?t=${bucket}`,
  /** The body is wanted on a 503 too (it says which part is down), so not through `request`. */
  health: async (): Promise<Health> => {
    const res = await fetch('/api/health', { cache: 'no-store' });
    // caddy answers for a dead api with an html 502. that is not a Health
    if (!res.headers.get('content-type')?.includes('json')) throw new ApiError(`http ${res.status}`, res.status);
    return (await res.json()) as Health;
  },
  /** Admins only: 401 for anyone else, 404 when the box has no admin at all. Its own 5xx is not reported: it would read itself. */
  errors: (kind?: string, limit = 200) =>
    request<ClientError[]>('GET', `/api/errors?limit=${limit}${kind ? `&kind=${encodeURIComponent(kind)}` : ''}`, undefined, { report: false })
};

export function statusOf(err: unknown): number | undefined {
  return err instanceof ApiError ? err.status : undefined;
}

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
