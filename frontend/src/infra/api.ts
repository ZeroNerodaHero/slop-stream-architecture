/** The json api behind /api. Same origin, so the dev server and caddy both forward it. */

import type { ChatLine } from '@/infra/atoms/chat-atoms';
import type { NotificationKind, Presence, PresenceChoice } from '@/infra/frames';
import { report } from '@/infra/report';
import type { Socials } from '@/infra/socials';

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
  /** Pictures on the home card, oldest first. Empty or missing: the card shows the camera. */
  thumbs?: number[];
  /** Different addresses receiving the stream, from video. `null`: video did not answer, nobody knows. */
  viewers: number | null;
}

export interface Streamer {
  name: string;
  /** The status: one line about them, beside the name. `bio` on the wire (the word `status` is the presence choice's, docs/status.md). */
  bio: string;
  verified: boolean;
  avatar: number | null;
  /** Pictures on the home card, oldest first. Empty when they have put none. */
  thumbs?: number[];
  /** The offline picture's upload time (the `?v=` of its url): on the watch page where the player would be while not live. `null`: none. Absent on an older api. */
  offline?: number | null;
  /** The line under the word while not live. Empty for none. Absent on an older api. */
  offline_note?: string;
  /** Where else to find them (docs/socials.md). The empty document for none; absent on an older api. Read through `cleanSocials` before drawing. */
  socials?: Socials;
  /** About me (docs/about.md): the words first on the about tab. Empty for none; absent on an older api. */
  about?: string;
  /** The word next to the name: `offline` `online` `dnd` `streaming`. See docs/status.md. */
  presence: Presence;
  /** How many follow the name (docs/follows.md). Absent on an older api. */
  followers?: number;
  /** The asking login follows it. false for nobody. */
  following?: boolean;
  /** The name follows the asking login. false for nobody. Absent on an older api. */
  follows_you?: boolean;
  /** When their last stream ended, rfc3339; null when none has. Absent on an older api. */
  last_live?: string | null;
  /** When the account was made, rfc3339; null for a free name. Absent on an older api. */
  joined_at?: string | null;
}

/** One line of a direct message thread (docs/dms.md). `from` is the writer's name now; `at` unix milliseconds. */
export interface DmLine {
  id: number;
  from: string;
  text: string;
  at: number;
}

/** A thread the login is in, as `GET /api/dms` lists them, newest line first: the other side as the sidebar has people (`id` is that account), the last line, and how many of theirs are new. */
export interface DmThread {
  id: string;
  name: string;
  verified: boolean;
  avatar: number | null;
  bio: string;
  live: boolean;
  presence: Presence;
  last: DmLine;
  unread: number;
}

/**
 * One row of the login's inbox (docs/notifications.md), as `GET /api/notifications` lists them, newest first:
 * who did it (`name`, as they are now, with the ✓ and the picture; `actor`, their id, which a rename does not
 * change), when (`at`, unix ms), whether it has been seen. `text` is a dm's or a channel line's words (clipped);
 * `session` a go-live's, null for the rest; `room` a `chat` row's `<server>/<channel>`, null for the rest
 * (absent on an older api).
 */
export interface Notification {
  id: number;
  kind: NotificationKind;
  name: string;
  actor: string;
  verified: boolean;
  avatar: number | null;
  at: number;
  read: boolean;
  text: string;
  session: number | null;
  room?: string | null;
}

/** A `chat` row's room, split: the server and the channel. Null for a row that is not one. */
export function roomOf(n: { kind: NotificationKind; room?: string | null }): { server: string; channel: string } | null {
  if (n.kind !== 'chat' || !n.room) return null;
  const slash = n.room.indexOf('/');
  if (slash <= 0 || slash === n.room.length - 1) return null;
  return { server: n.room.slice(0, slash), channel: n.room.slice(slash + 1) };
}

/** Which kinds the login keeps, the notifications tab's switches. Kept with the account. `chat` is absent on an older api, which means on. */
export interface NotifySettings {
  live: boolean;
  follow: boolean;
  dm: boolean;
  chat: boolean;
}

/** Somebody the login follows, as `GET /api/following` lists them: streaming first. See docs/follows.md. */
export interface Followed {
  name: string;
  verified: boolean;
  avatar: number | null;
  bio: string;
  live: boolean;
  presence: Presence;
  followed_at: string;
  /** They follow this login back. Absent on an older api, which means they do not. */
  mutual?: boolean;
}

/** One of home's people (`GET /api/people`): a name with a row who is not live, with the word beside it. */
export interface Person {
  name: string;
  verified: boolean;
  avatar: number | null;
  bio: string;
  presence: Presence;
  following: boolean;
}

/** One of home's recently offline (`GET /api/recent`): a name whose last stream ended lately, and when. Not live now. */
export interface Recent {
  name: string;
  verified: boolean;
  avatar: number | null;
  bio: string;
  presence: Presence;
  following: boolean;
  /** When their last stream ended, rfc3339. */
  ended_at: string;
}

/** One answer of `GET /api/search?q=`: a name holding the letters, and whether the login follows it. */
export interface SearchHit {
  name: string;
  verified: boolean;
  avatar: number | null;
  bio: string;
  live: boolean;
  presence: Presence;
  following: boolean;
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
  /** On the lists for someone who has not joined. Absent on an older api: treated as public. */
  public?: boolean;
  /** The words they typed. Absent, or null, on a group made before the digits: the name is the words. */
  title?: string | null;
  /** Four digits so two groups can share a title. Absent, or null, when there are none. */
  tag?: number | null;
  /** `bot`: nobody joins it, a chat socket that says `bot: true` wears it. */
  automatic: boolean;
}

export interface NewGroup {
  name: string;
  badge: string;
  color: string;
  about: string;
  /** Left off the lists when false. Omitted means public. */
  public?: boolean;
}

/** One room inside a server. `general` is the one a group starts with. */
export interface Channel {
  name: string;
  about: string;
  /** The login can delete it: they made it, or they may manage channels. Never `general`. */
  can_delete: boolean;
  /** Who made it, as they are now. Null for `general`, and absent on an older api. A room keeps `can_delete` right as channels come and go. */
  made_by?: string | null;
}

/** Channels on one server, `general` included. Matches `CHANNELS_PER_SERVER` in the api. */
export const CHANNEL_CAP = 20;

/** A group as a server: the explorer splits these into yours and the rest. */
export interface Server {
  name: string;
  badge: string;
  color: string;
  about: string;
  members: number;
  mine: boolean;
  /** This login owns it. Counted against `groups_per_owner`: at the cap a page offers no `create` (`mayMakeGroup`). Absent on an older api. */
  owner?: boolean;
  /** On the lists for someone who has not joined. Absent on an older api: treated as public. */
  public?: boolean;
  /** The words they typed. Absent, or null, on a group made before the digits. */
  title?: string | null;
  /** Four digits. Absent, or null, when there are none. */
  tag?: number | null;
  /** Unix seconds, the `?v=` of the picture. Null, or absent on an older api: none. */
  icon?: number | null;
  banner?: number | null;
  /** This login may add a channel. Absent on an older api, which let any member. */
  can_channels?: boolean;
  /** Members streaming now. Empty when nobody is, and on an older api that does not say. */
  live?: string[];
  channels: Channel[];
}

/** The five powers a custom role can hold. An owner has every one. Owner itself is not one of them. */
export interface RolePerms {
  appearance: boolean;
  roles: boolean;
  channels: boolean;
  kick: boolean;
  ban: boolean;
}

/** A custom role. `id` is a uuid the api made: what the role is known by, so a rename is a save like any other. */
export interface GroupRole {
  id: string;
  name: string;
  color: string;
  perms: RolePerms;
}

/**
 * `GET /api/groups/:group`: the whole room in one answer, asked once when the page arrives
 * and then kept current by the `group` frames (docs/groups.md). Absent fields are an older api.
 */
export interface GroupRoom {
  name: string;
  badge: string;
  color: string;
  about: string;
  members: number;
  mine: boolean;
  owner: boolean;
  /** A site admin: every power, whatever the roles say. Absent on an older api. */
  admin?: boolean;
  /** Absent on an older api. */
  public?: boolean;
  /** The words they typed. Absent, or null, on a group made before the digits. */
  title?: string | null;
  /** Four digits. Absent, or null, when there are none. */
  tag?: number | null;
  /** `name`, `newest`, or `oldest`. Absent on an older api. Owners stay first. */
  member_order?: string;
  icon: number | null;
  banner: number | null;
  perms: RolePerms;
  roles: GroupRole[];
  /** The channels in their order: as the channels power last put them, oldest first until then. Absent on an older api. */
  channels?: Channel[];
  /** The channels this login has muted (docs/notifications.md): no inbox row for their lines. Empty for nobody; absent on an older api. */
  muted?: string[];
  /** Members streaming right now. Absent on an older api. */
  live?: string[];
  /** The roster, for a member or a site admin. Null for anyone else; absent on an older api. */
  roster?: GroupMember[] | null;
  /** Who is banned, for the ban power. Null for anyone else; absent on an older api. */
  bans?: GroupBan[] | null;
}

export interface GroupMember {
  name: string;
  owner: boolean;
  /** Absent on an older api. */
  avatar?: number | null;
  /** When they joined, unix seconds, so the room keeps the group's order as people come. Absent on an older api. */
  joined?: number;
  roles: { id: string; name: string; color: string }[];
}

export interface GroupBan {
  name: string;
  reason: string;
}

/** The words on the square, and the four digits when the group has them. */
export function groupWords(group: { name: string; title?: string | null; tag?: number | null }): { title: string; tag: string | null } {
  const title = group.title && group.title.length > 0 ? group.title : group.name;
  const tag = group.tag == null ? null : String(group.tag).padStart(4, '0');
  return { title, tag };
}

/** The picture or the banner, cache-busted. Null when the group has none. */
export function groupImage(name: string, kind: 'icon' | 'banner', version?: number | null): string | null {
  if (version == null) return null;
  return `/api/groups/${encodeURIComponent(name)}/${kind}?v=${version}`;
}

export interface Explore {
  yours: Server[];
  discover: Server[];
  /** How many groups one login may own (`GROUPS_PER_OWNER` in the box's `.env`). Absent on an older api: one each. */
  groups_per_owner?: number;
}

/** Whether a login may make another group: it owns fewer than the api's cap. The pages offer `create` on this alone; the api refuses past it anyway. */
export function mayMakeGroup(found: Explore): boolean {
  const owned = found.yours.filter((server) => server.owner === true).length;
  return owned < (found.groups_per_owner ?? 1);
}

export interface Grant {
  url: string;
  session: number;
  token: number;
}

export interface WatchGrant {
  url: string;
  /** The name this grant is for. Another than the one asked for: that name was renamed, go there (docs/ids.md). Absent on an older api. */
  name?: string;
  bio: string;
  live: boolean;
  verified: boolean;
  avatar: number | null;
  presence: Presence;
  /** The offline picture and the line under the word, for the page while they are not live. Absent on an older api. */
  offline?: number | null;
  offline_note?: string;
  /** Where else to find them (docs/socials.md), for the socials tab. Absent on an older api. */
  socials?: Socials;
  /** About me (docs/about.md), for the about tab. Absent on an older api. */
  about?: string;
  /** How many follow the name, and whether the asking login does (docs/follows.md). Absent on an older api. */
  followers?: number;
  following?: boolean;
}

/**
 * One `sessions` row: a go-live and how it ended, a block on the calendar (docs/calendar.md).
 * `ended_at` null is a block still open. `last_beat_at` is the last heartbeat (absent on an
 * older api); `ended_by` says who closed it: the page, video (the publisher's peer went), or
 * the sweeper (then the end is the last heartbeat, within one beat of the truth).
 */
export interface SessionRow {
  id: number;
  name: string;
  started_at: string;
  ended_at: string | null;
  last_beat_at?: string | null;
  ended_by?: 'stop' | 'video' | 'sweep' | null;
}

/** `GET /api/me`: every field null for nobody. `id` is the account's uuid (docs/ids.md); no page needs it. */
export interface MeInfo {
  id: string | null;
  name: string | null;
  /** When the name last changed, rfc3339. null: never. The profile tab says when it may change again. */
  renamed_at: string | null;
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
  /** The release the last deploy.sh run put up: `v12`, or `v12+<commit>` past the last tag. Null before the first. */
  version: string | null;
  deployed_at: string | null;
  build: string;
  up_secs: number;
  postgres: boolean;
  redis: boolean;
  debug_db: boolean;
  video: boolean;
  video_up_secs: number | null;
  video_build: string | null;
  live: number | null;
  /** The bucket answered. Absent on an api older than the s3 container. */
  s3?: boolean;
  s3_bucket?: string;
  s3_endpoint?: string;
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

interface PageWire {
  type: 'text' | 'image' | 'video' | 'sound' | 'line' | 'box' | 'border';
  id: number;
  x: number;
  y: number;
  z: number;
  w?: number;
  h?: number;
  r?: number;
  font?: string;
  size?: number;
  color?: string;
  bg?: string;
  stroke?: number;
  strokeColor?: string;
  align?: 'left' | 'center' | 'right' | '';
  html?: string;
  src?: string;
}

export const api = {
  /** The login cookie goes along on its own (httponly, same origin). Every field null for nobody. */
  me: () => request<MeInfo>('GET', '/api/me'),
  signup: (name: string, password: string) => request<{ name: string }>('POST', '/api/signup', { name, password }),
  login: (name: string, password: string) => request<{ name: string }>('POST', '/api/login', { name, password }),
  logout: () => request<null>('POST', '/api/logout'),
  /** Every login of the account, this one included. */
  logoutAll: () => request<null>('POST', '/api/logout-all'),
  changePassword: (old: string, next: string) => request<null>('POST', '/api/password', { old, new: next }),
  /** The account's name changes; its logins, groups and pictures stay. Once a month, with the password, not while live. See docs/ids.md. */
  rename: (name: string, password: string) => request<{ id: string; name: string; renamed_at: string }>('POST', '/api/name', { name, password }),
  /** Every group, `bot` first; `mine` says which the login is in. See docs/groups.md. */
  groups: () => request<Group[]>('GET', '/api/groups'),
  /** A login makes a group and is in it, as its owner. 400 bad name/badge/colour, 403 at the cap on owned groups (`groups_per_owner`), 409 `name taken`. */
  createGroup: (group: NewGroup) => request<Group>('POST', '/api/groups', group),
  joinGroup: (name: string) => request<null>('POST', `/api/groups/${encodeURIComponent(name)}/join`),
  leaveGroup: (name: string) => request<null>('POST', `/api/groups/${encodeURIComponent(name)}/leave`),
  /** An owner, the one who made it, or an admin. Its members are out with it. */
  deleteGroup: (name: string) => request<null>('DELETE', `/api/groups/${encodeURIComponent(name)}`),
  /** The whole room: the group, its roles, what this login may do, the channels, who is live, and the roster and bans it may see. 404 for no such group. */
  group: (name: string) => request<GroupRoom>('GET', `/api/groups/${encodeURIComponent(name)}`),
  /** The last 100 lines of every channel, oldest first, keyed by channel. What the room draws before its socket says more. */
  groupMessages: (name: string) => request<Record<string, ChatLine[]>>('GET', `/api/groups/${encodeURIComponent(name)}/messages`),
  /** Servers you are in, then the ones you can find. `bot` is not a server. See docs/groups.md. */
  explore: () => request<Explore>('GET', '/api/explore'),
  /** Someone who may add a channel. 403 until they have joined, or without the power. The new channel goes after the last. */
  createChannel: (server: string, name: string, about = '') => request<Channel>('POST', `/api/groups/${encodeURIComponent(server)}/channels`, { name, about }),
  /** The channels in this order, from the top. The channels power. A channel not named keeps its place after these. → the whole order as it now stands. */
  setChannelOrder: (server: string, order: string[]) => request<{ order: string[] }>('PUT', `/api/groups/${encodeURIComponent(server)}/channels`, { order }),
  /** Who made the channel, or someone who may manage channels. `general` stays. */
  deleteChannel: (server: string, channel: string) => request<null>('DELETE', `/api/groups/${encodeURIComponent(server)}/channels/${encodeURIComponent(channel)}`),
  /** No inbox row for this channel's lines from now on, for this login (docs/notifications.md). 204, also when already muted. */
  muteChannel: (server: string, channel: string) => request<null>('PUT', `/api/groups/${encodeURIComponent(server)}/channels/${encodeURIComponent(channel)}/mute`),
  /** The channel's lines reach the bell again. 204, also when it was not muted. */
  unmuteChannel: (server: string, channel: string) => request<null>('DELETE', `/api/groups/${encodeURIComponent(server)}/channels/${encodeURIComponent(channel)}/mute`),
  /** The login has the channel on screen: its inbox rows for it are read. Its other devices hear it on the socket. */
  readChannel: (server: string, channel: string) => request<null>('PUT', `/api/groups/${encodeURIComponent(server)}/channels/${encodeURIComponent(channel)}/read`),
  saveGroupAbout: (name: string, about: string) => request<{ about: string }>('PUT', `/api/groups/${encodeURIComponent(name)}/about`, { about }),
  /** Appearance, from the manage dialog. A private group stays off the lists. */
  setGroupPublic: (name: string, isPublic: boolean) => request<{ public: boolean }>('PUT', `/api/groups/${encodeURIComponent(name)}/access`, { public: isPublic }),
  /** Appearance. Owners stay first; this is the order after them. */
  setMemberOrder: (name: string, order: 'name' | 'newest' | 'oldest') =>
    request<{ order: string }>('PUT', `/api/groups/${encodeURIComponent(name)}/order`, { order }),
  /** An owner (or a site admin), 403 for anyone else. The crop dialog made the jpeg. There is no remove: a group with a picture keeps one. */
  saveGroupIcon: (name: string, jpeg: Blob) => request<{ icon: number }>('PUT', `/api/groups/${encodeURIComponent(name)}/icon`, jpeg),
  saveGroupBanner: (name: string, jpeg: Blob) => request<{ banner: number }>('PUT', `/api/groups/${encodeURIComponent(name)}/banner`, jpeg),
  groupMembers: (name: string) => request<GroupMember[]>('GET', `/api/groups/${encodeURIComponent(name)}/members`),
  groupBans: (name: string) => request<GroupBan[]>('GET', `/api/groups/${encodeURIComponent(name)}/bans`),
  /** The roles power. 201 the role, with the id the api made. 409 `name taken`, 403 past the cap or out of reach. */
  createRole: (group: string, role: { name: string; color: string; perms: RolePerms }) =>
    request<GroupRole>('POST', `/api/groups/${encodeURIComponent(group)}/roles`, role),
  /** The role replaced whole, by id: a rename, a new colour, other powers, all this one call. */
  saveRole: (group: string, id: string, role: { name: string; color: string; perms: RolePerms }) =>
    request<GroupRole>('PUT', `/api/groups/${encodeURIComponent(group)}/roles/${id}`, role),
  deleteRole: (group: string, id: string) => request<null>('DELETE', `/api/groups/${encodeURIComponent(group)}/roles/${id}`),
  giveRole: (group: string, id: string, name: string) => request<null>('POST', `/api/groups/${encodeURIComponent(group)}/roles/${id}/members`, { name }),
  takeRole: (group: string, id: string, name: string) =>
    request<null>('DELETE', `/api/groups/${encodeURIComponent(group)}/roles/${id}/members/${encodeURIComponent(name)}`),
  /** An owner names a member an owner. 403 for anyone else, and for a member who owns as many groups as the cap allows. */
  grantOwner: (group: string, name: string) => request<null>('POST', `/api/groups/${encodeURIComponent(group)}/owners`, { name }),
  revokeOwner: (group: string, name: string) => request<null>('DELETE', `/api/groups/${encodeURIComponent(group)}/owners/${encodeURIComponent(name)}`),
  kickMember: (group: string, name: string) => request<null>('POST', `/api/groups/${encodeURIComponent(group)}/kick`, { name }),
  banMember: (group: string, name: string, reason: string) => request<null>('POST', `/api/groups/${encodeURIComponent(group)}/ban`, { name, reason }),
  unbanMember: (group: string, name: string) => request<null>('DELETE', `/api/groups/${encodeURIComponent(group)}/bans/${encodeURIComponent(name)}`),
  streams: () => request<LiveStream[]>('GET', '/api/streams'),
  streamer: (name: string) => request<Streamer>('GET', `/api/streamers/${name}`),
  /** The name's sessions overlapping `[from, to)`, oldest first: the calendar's blocks. At most 93 days a request, 1000 rows an answer. */
  sessions: (name: string, from: Date, to: Date) =>
    request<SessionRow[]>(
      'GET',
      `/api/streamers/${encodeURIComponent(name)}/sessions?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`
    ),
  /** The login's follows, streaming first, with each one's word. 401 for nobody. See docs/follows.md. */
  following: () => request<Followed[]>('GET', '/api/following'),
  /** 204, also when already. 400 `that is you`, 401 nobody, 403 at the cap, 429 on churn. */
  follow: (name: string) => request<null>('POST', `/api/streamers/${encodeURIComponent(name)}/follow`),
  unfollow: (name: string) => request<null>('POST', `/api/streamers/${encodeURIComponent(name)}/unfollow`),
  /** Names holding the letters, the exact one first, 20 at most. Works for nobody too. */
  search: (q: string) => request<SearchHit[]>('GET', `/api/search?q=${encodeURIComponent(q)}`),
  /** A picture for a chat line, already shrunk. Webp, or jpeg when the browser cannot write webp. */
  uploadChatImage: (picture: Blob) => request<{ id: string }>('POST', '/api/chat-images', picture),
  /** Everyone with a row who is not live: home's second half, online first. 100 at most. */
  people: () => request<Person[]>('GET', '/api/people'),
  /** The names whose last stream ended most recently and who are not live again, newest end first, 12 at most: home's recently offline. */
  recent: () => request<Recent[]>('GET', '/api/recent'),
  /** The login's direct message threads, newest line first, with how many lines are new in each. 401 for nobody. See docs/dms.md. */
  dms: () => request<DmThread[]>('GET', '/api/dms'),
  /** One page of the thread with `name`, oldest first: the newest page, or the one before line `before`. A short page is the start. */
  dmThread: (name: string, before?: number) =>
    request<{ name: string; friends: boolean; lines: DmLine[] }>('GET', `/api/dm/${encodeURIComponent(name)}${before === undefined ? '' : `?before=${before}`}`),
  /** A line to a friend. 201 with the line as kept; it also comes back on the events socket. 400 `too long`, 403 not friends, 429 `slow down`. */
  sendDm: (name: string, text: string) => request<DmLine & { to: string }>('POST', `/api/dm/${encodeURIComponent(name)}`, { text }),
  /** The login has seen the thread with `name` up to that line. Its other devices hear it on the socket. */
  readDm: (name: string, id: number) => request<null>('PUT', `/api/dm/${encodeURIComponent(name)}/read`, { id }),
  /** The login's inbox, newest first, the last 30, and which kinds it keeps. 401 for nobody. See docs/notifications.md. */
  notifications: () => request<{ settings: NotifySettings; items: Notification[] }>('GET', '/api/notifications'),
  /** The login has seen its inbox up to that row. Its other devices hear it on the socket. */
  readNotifications: (id: number) => request<null>('PUT', '/api/notifications/read', { id }),
  /** Which kinds go in the inbox from now on, replaced whole; the answer is what was kept. */
  saveNotifySettings: (settings: NotifySettings) => request<NotifySettings>('PUT', '/api/notifications/settings', settings),
  /** The status, one line beside the name: runs of whitespace become one space, 500 characters at most. `bio` on the wire. */
  saveBio: (name: string, bio: string) => request<{ name: string; bio: string }>('PUT', `/api/streamers/${name}`, { bio }),
  /** The page under that: `{ blocks: [{ type, id, x, y, z, w, h, r?, font?, size?, color?, bg?, stroke?, strokeColor?, align?, html? }] }`. Text html is written to the bucket. A line, a box, and a border have no file. */
  aboutPage: (name: string) =>
    request<{ blocks: PageWire[] }>('GET', `/api/streamers/${encodeURIComponent(name)}/about-page`),
  saveAboutPage: (name: string, blocks: PageWire[]) =>
    request<{ blocks: PageWire[] }>('PUT', `/api/streamers/${encodeURIComponent(name)}/about-page`, { blocks }),
  /** A picture, a clip, or a sound for that page. The bytes go to the bucket. `type` is `image`, `video`, or `sound`. */
  saveAboutFile: (name: string, type: 'image' | 'video' | 'sound', file: Blob) =>
    request<{ id: number; type: string; src: string }>('PUT', `/api/streamers/${encodeURIComponent(name)}/about-file?type=${type}`, file),
  /** The jpeg itself as the body. The page has already made it 256x256. */
  saveAvatar: (name: string, jpeg: Blob) => request<{ name: string; avatar: number }>('PUT', `/api/streamers/${name}/avatar`, jpeg),
  deleteAvatar: (name: string) => request<null>('DELETE', `/api/streamers/${name}/avatar`),
  /** The jpeg itself as the body. The page has already made it 960x540. */
  saveStreamThumb: (name: string, jpeg: Blob) => request<{ id: number }>('PUT', `/api/streamers/${name}/thumbs`, jpeg),
  deleteStreamThumb: (name: string, id: number) => request<null>('DELETE', `/api/streamers/${name}/thumbs/${id}`),
  /** One picture on the home card. The id is the url, so it can be cached. */
  streamThumbUrl: (name: string, id: number) => `/api/streamers/${encodeURIComponent(name)}/thumbs/${id}`,
  /** A layer of the scene (docs/screen.md). The file goes up as it is: png, jpeg, gif or webp, no re-encode, so transparency and animation survive. 2 mb at most, 24 per name. */
  saveAsset: (name: string, file: Blob) => request<{ id: number; mime: string; bytes: number }>('PUT', `/api/streamers/${name}/assets`, file),
  deleteAsset: (name: string, id: number) => request<null>('DELETE', `/api/streamers/${name}/assets/${id}`),
  /** The pictures this name has put up, oldest first. */
  listAssets: (name: string) => request<{ assets: { id: number; mime: string; bytes: number }[] }>('GET', `/api/streamers/${name}/assets`),
  /** An id is never reused and the bytes never change, so this url caches for good. */
  assetUrl: (name: string, id: number) => `/api/streamers/${encodeURIComponent(name)}/assets/${id}`,
  /** The jpeg itself as the body. The page has already made it 1920x1080 and under 1 mb. */
  saveOffline: (name: string, jpeg: Blob) => request<{ name: string; offline: number }>('PUT', `/api/streamers/${name}/offline`, jpeg),
  deleteOffline: (name: string) => request<null>('DELETE', `/api/streamers/${name}/offline`),
  /** Like `avatarUrl`: the version makes a new url per upload, so a day of cache is safe. */
  offlineUrl: (name: string, version: number) => `/api/streamers/${encodeURIComponent(name)}/offline?v=${version}`,
  /** The line under the word while not live. One line, 140 characters; empty clears it. */
  saveOfflineNote: (name: string, note: string) => request<{ name: string; offline_note: string }>('PUT', `/api/streamers/${name}/offline-note`, { note }),
  /** The links under the player, replaced whole, through the bio's gate (docs/socials.md). 400 `bad url…` / `bad kind` / `too many links…`; the answer is the document as kept. */
  saveSocials: (name: string, socials: Socials) => request<{ name: string; socials: Socials }>('PUT', `/api/streamers/${name}/socials`, socials),
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
