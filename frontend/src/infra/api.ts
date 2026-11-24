import type { ChatLine } from '@/infra/atoms/chat-atoms';
import type { ChatVideo } from '@/infra/chat-video';
import type { Emote, GroupEmote } from '@/infra/emotes';
import type { NotificationKind, Presence, PresenceChoice } from '@/infra/frames';
import { report } from '@/infra/report';
import type { Socials } from '@/infra/socials';
import type { Reaction } from '@/shared-components/reaction-list';

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
  verified: boolean;
  avatar: number | null;
  thumbs?: number[];
  viewers: number | null;
  badge?: GroupBadge | null;
}

interface OAuthVerified {
  oauth_verified?: boolean;
}

export interface Streamer extends OAuthVerified {
  name: string;
  bio: string;
  verified: boolean;
  avatar: number | null;
  thumbs?: number[];
  offline?: number | null;
  offline_note?: string;
  socials?: Socials;
  about?: string;
  welcome_on?: boolean;
  welcome?: string;
  presence: Presence;
  followers?: number;
  following?: boolean;
  follows_you?: boolean;
  last_live?: string | null;
  joined_at?: string | null;
  badge?: GroupBadge | null;
}

export interface DmLine {
  id: number;
  from: string;
  text: string;
  at: number;
  images: string[];
  video?: ChatVideo | null;
  reply?: DmReply | null;
  reactions?: Reaction[];
}

export interface DmReply {
  id: number;
  from?: string;
  text?: string;
  avatar?: number | null;
  images?: number;
  video?: boolean;
  gone?: boolean;
}

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
  badge?: GroupBadge | null;
}

export function roomOf(n: { kind: NotificationKind; room?: string | null }): { server: string; channel: string } | null {
  if (n.kind !== 'chat' || !n.room) return null;
  const slash = n.room.indexOf('/');
  if (slash <= 0 || slash === n.room.length - 1) return null;
  return { server: n.room.slice(0, slash), channel: n.room.slice(slash + 1) };
}

export interface NotifySettings {
  live: boolean;
  follow: boolean;
  dm: boolean;
  chat: boolean;
}

export interface Followed extends OAuthVerified {
  name: string;
  verified: boolean;
  avatar: number | null;
  bio: string;
  live: boolean;
  presence: Presence;
  followed_at: string;
  mutual?: boolean;
}

export interface Person extends OAuthVerified {
  name: string;
  verified: boolean;
  avatar: number | null;
  bio: string;
  presence: Presence;
  following: boolean;
}

export interface Recent extends OAuthVerified {
  name: string;
  verified: boolean;
  avatar: number | null;
  bio: string;
  presence: Presence;
  following: boolean;
  ended_at: string;
  followers: number;
}

export interface SearchHit extends OAuthVerified {
  name: string;
  verified: boolean;
  avatar: number | null;
  bio: string;
  live: boolean;
  presence: Presence;
  following: boolean;
}

export const SEARCH_LIMIT = 20;
export const SEARCH_ANYWHERE_FROM = 3;

export function cleanSearch(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 32);
}

export function nameMatches(name: string, q: string): boolean {
  return q.length < SEARCH_ANYWHERE_FROM ? name.startsWith(q) : name.includes(q);
}

export interface DemoModel {
  id: string;
  name: string;
  author: string;
  licence: string;
  vrm: string;
  bytes: number;
  v: string;
  thumb: boolean;
}

export interface GroupBadge {
  name: string;
  badge: string;
  color: string;
  icon?: number | null;
  about?: string | null;
  members?: number | null;
  banner?: number | null;
}

export interface Group extends GroupBadge {
  about: string;
  made_by: string | null;
  members: number;
  mine: boolean;
  public?: boolean;
  title?: string | null;
  tag?: number | null;
  automatic: boolean;
  primary?: boolean;
}

export interface NewGroup {
  name: string;
  badge: string;
  color: string;
  about: string;
  public?: boolean;
}

export interface Channel {
  name: string;
  about: string;
  home?: boolean;
  can_delete: boolean;
  can_edit?: boolean;
  made_by?: string | null;
  cooldown?: number;
  kind?: ChannelKind;
  user_limit?: number;
}

export type ChannelKind = 'text' | 'voice';

export const isVoice = (channel: { kind?: string }): boolean => channel.kind === 'voice';

export const homeChannel = (channels: Channel[] | undefined): string => (channels ?? []).find((c) => c.home)?.name ?? 'general';

export const canEditChannel = (channel: Channel): boolean => channel.can_edit ?? channel.can_delete;

export interface VoiceMember {
  name: string;
  uid: string;
  since: number;
  muted?: boolean;
}

export interface VoiceGrant {
  url: string;
  grant: string;
  ttl: number;
}

export const CHANNEL_CAP = 20;

export const VOICE_CHANNEL_CAP = 4;

export interface Server {
  name: string;
  badge: string;
  color: string;
  about: string;
  members: number;
  mine: boolean;
  owner?: boolean;
  public?: boolean;
  title?: string | null;
  tag?: number | null;
  icon?: number | null;
  banner?: number | null;
  can_channels?: boolean;
  live?: string[];
  channels: Channel[];
}

export interface RolePerms {
  appearance: boolean;
  roles: boolean;
  channels: boolean;
  kick: boolean;
  ban: boolean;
  emotes?: boolean;
}

export interface GroupRole {
  id: string;
  name: string;
  color: string;
  perms: RolePerms;
  channels?: string[];
  cooldown?: number;
}

export interface RoleBody {
  name: string;
  color: string;
  perms: RolePerms;
  channels: string[];
  cooldown: number;
}

export interface GroupRoom {
  name: string;
  badge: string;
  color: string;
  about: string;
  members: number;
  mine: boolean;
  owner: boolean;
  owner_role?: string;
  admin?: boolean;
  public?: boolean;
  adult?: boolean;
  adult_locked?: boolean;
  title?: string | null;
  tag?: number | null;
  member_order?: string;
  icon: number | null;
  banner: number | null;
  perms: RolePerms;
  roles: GroupRole[];
  channels?: Channel[];
  muted?: string[];
  pins?: Record<string, string[]>;
  live?: string[];
  voice?: Record<string, VoiceMember[]>;
  roster?: GroupMember[] | null;
  roster_next?: string | null;
  holders?: Record<string, string[]> | null;
  bans?: GroupBan[] | null;
}

export type PinnedLine = ChatLine & { pinned_by: string | null; pinned_at: number };

export interface GroupMember {
  name: string;
  owner: boolean;
  avatar?: number | null;
  joined?: number;
  roles: { id: string; name: string; color: string }[];
  timeout?: number | null;
}

export type MemberLine = ChatLine & { channel: string };

export interface GroupBan {
  name: string;
  reason: string;
}

export interface GroupTimeout {
  name: string;
  avatar: number | null;
  until: number;
  reason: string;
  by: string | null;
  member: boolean;
}

export function groupWords(group: { name: string; title?: string | null; tag?: number | null }): { title: string; tag: string | null } {
  const title = group.title && group.title.length > 0 ? group.title : group.name;
  const tag = group.tag == null ? null : String(group.tag).padStart(4, '0');
  return { title, tag };
}

export function groupMatches(group: { name: string; badge: string; about: string; title?: string | null; tag?: number | null }, query: string): boolean {
  if (!query) return true;
  const { title, tag } = groupWords(group);
  const named = tag ? `${title} #${tag} ${title}#${tag}` : title;
  return `${named} ${group.name} ${group.badge} ${group.about}`.toLowerCase().includes(query);
}

export function groupImage(name: string, kind: 'icon' | 'banner', version?: number | null): string | null {
  if (version == null) return null;
  return `/api/groups/${encodeURIComponent(name)}/${kind}?v=${version}`;
}

export interface Explore {
  yours: Server[];
  discover: Server[];
  groups_per_owner?: number;
}

export function mayMakeGroup(found: Explore): boolean {
  const owned = found.yours.filter((server) => server.owner === true).length;
  return owned < (found.groups_per_owner ?? 1);
}

export interface Grant {
  url: string;
  session: number;
  token: number;
}

export interface WatchGrant extends OAuthVerified {
  url: string;
  name?: string;
  bio: string;
  live: boolean;
  verified: boolean;
  avatar: number | null;
  presence: Presence;
  offline?: number | null;
  offline_note?: string;
  socials?: Socials;
  about?: string;
  welcome_on?: boolean;
  welcome?: string;
  followers?: number;
  following?: boolean;
  joined_at?: string | null;
  badge?: GroupBadge | null;
  can_moderate?: boolean;
}

export interface Janny {
  name: string;
  added_at: string;
}

export interface StreamBans {
  bans: { name: string; by: string | null; reason: string; at: string }[];
  timeouts: { name: string; by: string | null; until: string }[];
}

export interface ModLogRow {
  at: string;
  actor: string;
  action: 'delete' | 'ban' | 'unban' | 'timeout' | 'untimeout' | 'janny' | 'unjanny' | string;
  target: string;
  line_id: string | null;
  snapshot: (Partial<ChatLine> & { reason?: string; seconds?: number }) | null;
}

export interface SessionRow {
  id: number;
  name: string;
  started_at: string;
  ended_at: string | null;
  last_beat_at?: string | null;
  ended_by?: 'stop' | 'video' | 'sweep' | null;
}

export interface MeInfo {
  id: string | null;
  name: string | null;
  renamed_at: string | null;
  has_password?: boolean | null;
  oauth_verified?: boolean | null;
  held?: string[];
}

export type OAuthProvider = string;

export interface OAuthIdentities {
  has_password: boolean;
  oauth_verified?: boolean;
  identities: { provider: OAuthProvider; linked_at: string; name?: string | null; avatar?: string | null }[];
}

export interface Owner {
  name: string;
  session: number;
  token: number;
}

export interface Health {
  ok: boolean;
  env: string;
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
  s3?: boolean;
  s3_bucket?: string;
  s3_endpoint?: string;
  errors_dropped: number;
}

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
  report?: boolean;
  timeoutMs?: number;
  cache?: RequestCache;
}

async function request<T>(method: string, path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
  const raw = body instanceof Blob;
  const res = fetch(path, {
    method,
    headers: body === undefined ? {} : { 'content-type': raw ? body.type : 'application/json' },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    signal: options.timeoutMs === undefined ? undefined : AbortSignal.timeout(options.timeoutMs),
    cache: options.cache
  });
  return answerOf<T>(method, path, res, options);
}

async function answerOf<T>(method: string, path: string, response: Promise<Response>, options: RequestOptions = {}): Promise<T> {
  const res = await response;
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

export type StatsDays = 7 | 30;

export interface StreamStatsRow {
  id: number;
  name: string;
  started_at: string;
  ended_at: string | null;
  live: boolean;
  duration_secs: number;
  peak_viewers: number;
  avg_viewers: number | null;
  watch_secs: number;
  unique_viewers: number;
}

export interface StreamDetail extends StreamStatsRow {
  points: [number, number][];
  account_viewers: number;
  anon_viewers: number;
  new_follows: number;
  chat_messages: number;
  chatters: number;
}

export interface StatsSummary {
  days: StatsDays;
  streams: number;
  live_secs: number;
  avg_viewers: number | null;
  peak_viewers: number;
  watch_secs: number;
  unique_viewers: number;
  new_follows: number;
}

export interface Stats {
  summary: StatsSummary;
  streams: StreamStatsRow[];
  last: StreamDetail | null;
}

function ownerQuery(owner: Owner): string {
  return `session=${owner.session}&token=${owner.token}`;
}

export interface PageWire {
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
  me: () => request<MeInfo>('GET', '/api/me'),
  signup: (name: string, password: string, turnstile_token?: string) =>
    request<{ name: string }>('POST', '/api/signup', { name, password, turnstile_token }),
  login: (name: string, password: string, turnstile_token?: string) =>
    request<{ name: string }>('POST', '/api/login', { name, password, turnstile_token }),
  turnstileConfig: () => request<{ enabled: boolean; siteKey: string | null }>('GET', '/api/config/turnstile'),
  logout: () => request<null>('POST', '/api/logout'),
  logoutAll: () => request<null>('POST', '/api/logout-all'),
  changePassword: (old: string, next: string) => request<null>('POST', '/api/password', { old, new: next }),
  oauthProviders: () => request<{ providers: OAuthProvider[] }>('GET', '/api/oauth/providers'),
  oauthIdentities: () => request<OAuthIdentities>('GET', '/api/oauth/identities'),
  oauthUnlink: (provider: OAuthProvider) => request<null>('POST', `/api/oauth/${provider}/unlink`),
  oauthSignupInfo: () => request<{ provider: OAuthProvider; suggested: string }>('GET', '/api/oauth/signup'),
  oauthSignup: (name: string, turnstile_token?: string) =>
    request<{ id: string; name: string }>('POST', '/api/oauth/signup', { name, turnstile_token }),
  rename: (name: string, password: string) => request<{ id: string; name: string; renamed_at: string }>('POST', '/api/name', { name, password }),
  groups: () => request<Group[]>('GET', '/api/groups'),
  createGroup: (group: NewGroup) => request<Group>('POST', '/api/groups', group),
  joinGroup: (name: string) => request<null>('POST', `/api/groups/${encodeURIComponent(name)}/join`),
  leaveGroup: (name: string) => request<null>('POST', `/api/groups/${encodeURIComponent(name)}/leave`),
  setPrimaryGroup: (name: string) => request<null>('PUT', `/api/groups/${encodeURIComponent(name)}/primary`),
  clearPrimaryGroup: (name: string) => request<null>('DELETE', `/api/groups/${encodeURIComponent(name)}/primary`),
  deleteGroup: (name: string) => request<null>('DELETE', `/api/groups/${encodeURIComponent(name)}`),
  group: (name: string, roster?: number) => request<GroupRoom>('GET', `/api/groups/${encodeURIComponent(name)}${roster === undefined ? '' : `?roster=${roster}`}`),
  groupMessages: (name: string, limit?: number) =>
    request<Record<string, ChatLine[]>>('GET', `/api/groups/${encodeURIComponent(name)}/messages${limit === undefined ? '' : `?limit=${limit}`}`),
  explore: () => request<Explore>('GET', '/api/explore'),
  createChannel: (server: string, name: string, about = '', kind: ChannelKind = 'text') =>
    request<Channel>('POST', `/api/groups/${encodeURIComponent(server)}/channels`, { name, about, kind }),
  joinVoice: (server: string, channel: string, tab: string) =>
    request<VoiceGrant>('POST', `/api/groups/${encodeURIComponent(server)}/voice/${encodeURIComponent(channel)}/join`, { tab }, { report: false }),
  setChannelOrder: (server: string, order: string[]) => request<{ order: string[] }>('PUT', `/api/groups/${encodeURIComponent(server)}/channels`, { order }),
  editChannel: (server: string, channel: string, edit: { name?: string; about?: string }) =>
    request<Channel>('PUT', `/api/groups/${encodeURIComponent(server)}/channels/${encodeURIComponent(channel)}`, edit),
  deleteChannel: (server: string, channel: string) => request<null>('DELETE', `/api/groups/${encodeURIComponent(server)}/channels/${encodeURIComponent(channel)}`),
  setChannelCooldown: (server: string, channel: string, seconds: number) =>
    request<{ cooldown: number }>('PUT', `/api/groups/${encodeURIComponent(server)}/channels/${encodeURIComponent(channel)}/cooldown`, { seconds }),
  setChannelRoles: (server: string, channel: string, roles: string[]) =>
    request<{ channel: string; roles: string[] }>('PUT', `/api/groups/${encodeURIComponent(server)}/channels/${encodeURIComponent(channel)}/roles`, { roles }),
  muteChannel: (server: string, channel: string) => request<null>('PUT', `/api/groups/${encodeURIComponent(server)}/channels/${encodeURIComponent(channel)}/mute`),
  channelPins: (server: string, channel: string) =>
    request<{ pins: PinnedLine[] }>('GET', `/api/groups/${encodeURIComponent(server)}/channels/${encodeURIComponent(channel)}/pins`),
  pinLine: (server: string, channel: string, id: string) =>
    request<PinnedLine>('POST', `/api/groups/${encodeURIComponent(server)}/channels/${encodeURIComponent(channel)}/pins/${encodeURIComponent(id)}`),
  unpinLine: (server: string, channel: string, id: string) =>
    request<null>('DELETE', `/api/groups/${encodeURIComponent(server)}/channels/${encodeURIComponent(channel)}/pins/${encodeURIComponent(id)}`),
  unmuteChannel: (server: string, channel: string) => request<null>('DELETE', `/api/groups/${encodeURIComponent(server)}/channels/${encodeURIComponent(channel)}/mute`),
  readChannel: (server: string, channel: string) => request<null>('PUT', `/api/groups/${encodeURIComponent(server)}/channels/${encodeURIComponent(channel)}/read`),
  saveGroupAbout: (name: string, about: string) => request<{ about: string }>('PUT', `/api/groups/${encodeURIComponent(name)}/about`, { about }),
  saveGroupColor: (name: string, color: string) => request<{ color: string }>('PUT', `/api/groups/${encodeURIComponent(name)}/color`, { color }),
  setGroupPublic: (name: string, isPublic: boolean) => request<{ public: boolean }>('PUT', `/api/groups/${encodeURIComponent(name)}/access`, { public: isPublic }),
  setGroupAdult: (name: string, adult: boolean) => request<{ adult: boolean; locked: boolean }>('PUT', `/api/groups/${encodeURIComponent(name)}/adult`, { adult }),
  liftGroupAdultLock: (name: string) => request<{ adult: boolean; locked: boolean }>('DELETE', `/api/groups/${encodeURIComponent(name)}/adult/lock`),
  setMemberOrder: (name: string, order: 'name' | 'newest' | 'oldest') => request<{ order: string }>('PUT', `/api/groups/${encodeURIComponent(name)}/order`, { order }),
  saveGroupIcon: (name: string, jpeg: Blob) => request<{ icon: number }>('PUT', `/api/groups/${encodeURIComponent(name)}/icon`, jpeg),
  saveGroupBanner: (name: string, jpeg: Blob) => request<{ banner: number }>('PUT', `/api/groups/${encodeURIComponent(name)}/banner`, jpeg),
  groupEmotes: (group: string) => request<{ emotes: GroupEmote[]; max: number; manage: boolean }>('GET', `/api/groups/${encodeURIComponent(group)}/emotes`),
  uploadEmote: (group: string, picture: Blob, name: string) => {
    const form = new FormData();
    form.set('name', name);
    form.set('image', picture, 'emote');
    const path = `/api/groups/${encodeURIComponent(group)}/emotes`;
    return answerOf<GroupEmote>('POST', path, fetch(path, { method: 'POST', body: form }));
  },
  renameEmote: (group: string, id: string, name: string) =>
    request<GroupEmote>('PATCH', `/api/groups/${encodeURIComponent(group)}/emotes/${encodeURIComponent(id)}`, { name }),
  deleteEmote: (group: string, id: string) => request<null>('DELETE', `/api/groups/${encodeURIComponent(group)}/emotes/${encodeURIComponent(id)}`),
  myEmotes: () => request<{ emotes: Emote[] }>('GET', '/api/emotes/mine'),
  emotes: (ids: readonly string[]) => request<{ emotes: Emote[] }>('GET', `/api/emotes?ids=${ids.map(encodeURIComponent).join(',')}`),
  groupMembers: (name: string) => request<GroupMember[]>('GET', `/api/groups/${encodeURIComponent(name)}/members`),
  groupMembersPage: (name: string, page: { limit: number; after?: string | null; q?: string }) => {
    const query = new URLSearchParams({ limit: String(page.limit) });
    if (page.after) query.set('after', page.after);
    if (page.q) query.set('q', page.q);
    return request<{ members: GroupMember[]; next: string | null }>('GET', `/api/groups/${encodeURIComponent(name)}/members?${query}`);
  },
  groupBans: (name: string) => request<GroupBan[]>('GET', `/api/groups/${encodeURIComponent(name)}/bans`),
  createRole: (group: string, role: RoleBody) => request<GroupRole>('POST', `/api/groups/${encodeURIComponent(group)}/roles`, role),
  saveRole: (group: string, id: string, role: RoleBody) => request<GroupRole>('PUT', `/api/groups/${encodeURIComponent(group)}/roles/${id}`, role),
  deleteRole: (group: string, id: string) => request<null>('DELETE', `/api/groups/${encodeURIComponent(group)}/roles/${id}`),
  giveRole: (group: string, id: string, name: string) => request<null>('POST', `/api/groups/${encodeURIComponent(group)}/roles/${id}/members`, { name }),
  takeRole: (group: string, id: string, name: string) =>
    request<null>('DELETE', `/api/groups/${encodeURIComponent(group)}/roles/${id}/members/${encodeURIComponent(name)}`),
  timeoutMember: (group: string, name: string, seconds: number, reason = '') =>
    request<null>('POST', `/api/groups/${encodeURIComponent(group)}/timeout`, { name, seconds, reason }),
  liftTimeout: (group: string, name: string) => request<null>('DELETE', `/api/groups/${encodeURIComponent(group)}/timeout/${encodeURIComponent(name)}`),
  groupTimeouts: (group: string) => request<GroupTimeout[]>('GET', `/api/groups/${encodeURIComponent(group)}/timeouts`),
  transferOwnership: (group: string, name: string) => request<null>('POST', `/api/groups/${encodeURIComponent(group)}/transfer`, { name }),
  renameOwnerRole: (group: string, name: string) => request<{ name: string }>('PUT', `/api/groups/${encodeURIComponent(group)}/owner-role`, { name }),
  revokeOwner: (group: string, name: string) => request<null>('DELETE', `/api/groups/${encodeURIComponent(group)}/owners/${encodeURIComponent(name)}`),
  kickMember: (group: string, name: string) => request<null>('POST', `/api/groups/${encodeURIComponent(group)}/kick`, { name }),
  groupMember: (group: string, name: string) => request<GroupMember>('GET', `/api/groups/${encodeURIComponent(group)}/members/${encodeURIComponent(name)}`),
  groupMemberMessages: (group: string, name: string, before?: string | null) => {
    const query = before ? `?before=${encodeURIComponent(before)}` : '';
    return request<{ lines: MemberLine[]; next: string | null }>('GET', `/api/groups/${encodeURIComponent(group)}/members/${encodeURIComponent(name)}/messages${query}`);
  },
  deleteGroupMessage: (group: string, channel: string, id: string) =>
    request<null>('DELETE', `/api/groups/${encodeURIComponent(group)}/channels/${encodeURIComponent(channel)}/messages/${encodeURIComponent(id)}`),
  voiceMute: (group: string, name: string, muted: boolean) =>
    request<{ muted: boolean }>('POST', `/api/groups/${encodeURIComponent(group)}/voice-mute`, { name, muted }),
  voiceDisconnect: (group: string, name: string) => request<null>('POST', `/api/groups/${encodeURIComponent(group)}/voice-disconnect`, { name }),
  banMember: (group: string, name: string, reason: string) => request<null>('POST', `/api/groups/${encodeURIComponent(group)}/ban`, { name, reason }),
  unbanMember: (group: string, name: string) => request<null>('DELETE', `/api/groups/${encodeURIComponent(group)}/bans/${encodeURIComponent(name)}`),
  deleteChatLine: (name: string, id: string) => request<null>('DELETE', `/api/streams/${encodeURIComponent(name)}/chat/${encodeURIComponent(id)}`),
  banFromChat: (name: string, who: string, reason = '') => request<null>('POST', `/api/streams/${encodeURIComponent(name)}/bans`, { name: who, reason }),
  unbanFromChat: (name: string, who: string) => request<null>('DELETE', `/api/streams/${encodeURIComponent(name)}/bans/${encodeURIComponent(who)}`),
  timeoutInChat: (name: string, who: string, seconds: number) => request<null>('POST', `/api/streams/${encodeURIComponent(name)}/timeouts`, { name: who, seconds }),
  liftChatTimeout: (name: string, who: string) => request<null>('DELETE', `/api/streams/${encodeURIComponent(name)}/timeouts/${encodeURIComponent(who)}`),
  chatBans: (name: string) => request<StreamBans>('GET', `/api/streams/${encodeURIComponent(name)}/bans`),
  modLog: (name: string) => request<ModLogRow[]>('GET', `/api/streams/${encodeURIComponent(name)}/mod-log`),
  streamJannies: (name: string) => request<Janny[]>('GET', `/api/streams/${encodeURIComponent(name)}/jannies`),
  addStreamJanny: (name: string, who: string) => request<null>('POST', `/api/streams/${encodeURIComponent(name)}/jannies`, { name: who }),
  removeStreamJanny: (name: string, who: string) => request<null>('DELETE', `/api/streams/${encodeURIComponent(name)}/jannies/${encodeURIComponent(who)}`),
  siteJannies: () => request<Janny[]>('GET', '/api/jannies'),
  addSiteJanny: (who: string) => request<null>('POST', '/api/jannies', { name: who }),
  removeSiteJanny: (who: string) => request<null>('DELETE', `/api/jannies/${encodeURIComponent(who)}`),
  streams: () => request<LiveStream[]>('GET', '/api/streams', undefined, { cache: 'no-store' }),
  streamer: (name: string) => request<Streamer>('GET', `/api/streamers/${name}`),
  sessions: (name: string, from: Date, to: Date) =>
    request<SessionRow[]>(
      'GET',
      `/api/streamers/${encodeURIComponent(name)}/sessions?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`
    ),
  following: () => request<Followed[]>('GET', '/api/following'),
  follow: (name: string) => request<null>('POST', `/api/streamers/${encodeURIComponent(name)}/follow`),
  unfollow: (name: string) => request<null>('POST', `/api/streamers/${encodeURIComponent(name)}/unfollow`),
  search: (q: string) => request<SearchHit[]>('GET', `/api/search?q=${encodeURIComponent(q)}`),
  uploadChatImage: (picture: Blob) => request<{ id: string }>('POST', '/api/chat-images', picture),
  uploadChatVideo: (video: Blob, onProgress?: (sent: number) => void) =>
    new Promise<{ id: string; poster: string; duration_ms: number }>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/chat-videos');
      if (video.type) xhr.setRequestHeader('content-type', video.type);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && e.total > 0) onProgress?.(e.loaded / e.total);
      };
      xhr.onload = () => {
        let data: unknown = null;
        try {
          data = xhr.responseText ? JSON.parse(xhr.responseText) : null;
        } catch {
          data = null;
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(data as { id: string; poster: string; duration_ms: number });
          return;
        }
        const said = data && typeof data === 'object' && 'error' in data ? String((data as { error: unknown }).error) : '';
        reject(new ApiError(said || (xhr.status === 413 ? 'video too big. 10 mb at most' : `http ${xhr.status}`), xhr.status));
      };
      xhr.onerror = () => reject(new ApiError('could not send the video', 0));
      xhr.send(video);
    }),
  people: () => request<Person[]>('GET', '/api/people'),
  recent: () => request<Recent[]>('GET', '/api/recent'),
  dms: () => request<DmThread[]>('GET', '/api/dms'),
  dmThread: (name: string, before?: number) =>
    request<{ name: string; friends: boolean; lines: DmLine[] }>('GET', `/api/dm/${encodeURIComponent(name)}${before === undefined ? '' : `?before=${before}`}`),
  sendDm: (name: string, text: string, images: string[] = [], reply: number | null = null, video: string | null = null) =>
    request<DmLine & { to: string }>('POST', `/api/dm/${encodeURIComponent(name)}`, {
      text,
      images,
      ...(reply === null ? {} : { reply }),
      ...(video === null ? {} : { video })
    }),
  reactDm: (name: string, id: number, emoji: string, on: boolean) =>
    request<{ id: number; reactions: unknown }>('PUT', `/api/dm/${encodeURIComponent(name)}/react`, { id, emoji, on }),
  readDm: (name: string, id: number) => request<null>('PUT', `/api/dm/${encodeURIComponent(name)}/read`, { id }),
  searchDm: (name: string, q: string) => request<{ lines: DmLine[] }>('GET', `/api/dm/${encodeURIComponent(name)}/search?q=${encodeURIComponent(q)}`),
  notifications: () => request<{ settings: NotifySettings; items: Notification[] }>('GET', '/api/notifications'),
  readNotifications: (id: number) => request<null>('PUT', '/api/notifications/read', { id }),
  dismissNotification: (id: number) => request<null>('DELETE', `/api/notifications/${id}`),
  saveNotifySettings: (settings: NotifySettings) => request<NotifySettings>('PUT', '/api/notifications/settings', settings),
  saveBio: (name: string, bio: string) => request<{ name: string; bio: string }>('PUT', `/api/streamers/${name}`, { bio }),
  aboutPage: (name: string) => request<{ blocks: PageWire[] }>('GET', `/api/streamers/${encodeURIComponent(name)}/about-page`),
  saveAboutPage: (name: string, blocks: PageWire[]) => request<{ blocks: PageWire[] }>('PUT', `/api/streamers/${encodeURIComponent(name)}/about-page`, { blocks }),
  saveAboutFile: (name: string, type: 'image' | 'video' | 'sound', file: Blob) =>
    request<{ id: number; type: string; src: string }>('PUT', `/api/streamers/${encodeURIComponent(name)}/about-file?type=${type}`, file),
  saveAvatar: (name: string, jpeg: Blob) => request<{ name: string; avatar: number }>('PUT', `/api/streamers/${name}/avatar`, jpeg),
  deleteAvatar: (name: string) => request<null>('DELETE', `/api/streamers/${name}/avatar`),
  saveStreamThumb: (name: string, jpeg: Blob) => request<{ id: number }>('PUT', `/api/streamers/${name}/thumbs`, jpeg),
  deleteStreamThumb: (name: string, id: number) => request<null>('DELETE', `/api/streamers/${name}/thumbs/${id}`),
  streamThumbUrl: (name: string, id: number) => `/api/streamers/${encodeURIComponent(name)}/thumbs/${id}`,
  saveAsset: (name: string, file: Blob) => request<{ id: number; mime: string; bytes: number }>('PUT', `/api/streamers/${name}/assets`, file),
  deleteAsset: (name: string, id: number) => request<null>('DELETE', `/api/streamers/${name}/assets/${id}`),
  listAssets: (name: string) => request<{ assets: { id: number; mime: string; bytes: number }[] }>('GET', `/api/streamers/${name}/assets`),
  assetUrl: (name: string, id: number) => `/api/streamers/${encodeURIComponent(name)}/assets/${id}`,
  demoModels: () => request<{ models: DemoModel[] }>('GET', '/api/models'),
  demoModelUrl: (model: Pick<DemoModel, 'id' | 'v'>) => `/api/models/${encodeURIComponent(model.id)}?v=${encodeURIComponent(model.v)}`,
  demoModelThumbUrl: (model: Pick<DemoModel, 'id' | 'v'>) => `/api/models/${encodeURIComponent(model.id)}/thumb?v=${encodeURIComponent(model.v)}`,
  saveOffline: (name: string, jpeg: Blob) => request<{ name: string; offline: number }>('PUT', `/api/streamers/${name}/offline`, jpeg),
  deleteOffline: (name: string) => request<null>('DELETE', `/api/streamers/${name}/offline`),
  offlineUrl: (name: string, version: number) => `/api/streamers/${encodeURIComponent(name)}/offline?v=${version}`,
  saveOfflineNote: (name: string, note: string) => request<{ name: string; offline_note: string }>('PUT', `/api/streamers/${name}/offline-note`, { note }),
  saveWelcome: (name: string, welcome: { on: boolean; message: string }) =>
    request<{ name: string; welcome_on: boolean; welcome: string }>('PUT', `/api/streamers/${name}/welcome`, welcome),
  saveSocials: (name: string, socials: Socials) => request<{ name: string; socials: Socials }>('PUT', `/api/streamers/${name}/socials`, socials),
  setPresence: (name: string, status: PresenceChoice) => request<{ status: PresenceChoice; presence: Presence }>('PUT', `/api/streamers/${name}/presence`, { status }),
  avatarUrl: (name: string, version: number) => `/api/streamers/${encodeURIComponent(name)}/avatar?v=${version}`,
  goLive: (name: string) => request<Grant>('POST', `/api/streams/${name}/go-live`),
  heartbeat: (owner: Owner) => request<{ ok: boolean }>('POST', `/api/streams/${owner.name}/heartbeat?${ownerQuery(owner)}`),
  stop: (owner: Owner) => request<{ ok: boolean }>('POST', `/api/streams/${owner.name}/stop?${ownerQuery(owner)}`),
  stopBeacon: (owner: Owner) => navigator.sendBeacon(`/api/streams/${owner.name}/stop?${ownerQuery(owner)}`),
  watch: (name: string) => request<WatchGrant>('POST', `/api/streams/${name}/watch`, undefined, { timeoutMs: 15000 }),
  watchAsked: (name: string, response: Promise<Response>) => answerOf<WatchGrant>('POST', `/api/streams/${name}/watch`, response),
  watching: (name: string, anon: string) =>
    request<{ ok: boolean; counted: boolean }>('POST', `/api/streams/${name}/watching?anon=${encodeURIComponent(anon)}`, undefined, { report: false }),
  watchingBeacon: (name: string, anon: string) => navigator.sendBeacon(`/api/streams/${name}/watching?anon=${encodeURIComponent(anon)}&leave=1`),
  stats: (days: StatsDays) => request<Stats>('GET', `/api/stats?days=${days}`),
  statsStream: (id: number) => request<StreamDetail>('GET', `/api/stats/streams/${id}`),
  thumbUrl: (name: string, bucket: number) => `/thumb/${encodeURIComponent(name)}.jpg?t=${bucket}`,
  health: async (): Promise<Health> => {
    const res = await fetch('/api/health', { cache: 'no-store' });
    if (!res.headers.get('content-type')?.includes('json')) throw new ApiError(`http ${res.status}`, res.status);
    return (await res.json()) as Health;
  },
  errors: (kind?: string, limit = 200) =>
    request<ClientError[]>('GET', `/api/errors?limit=${limit}${kind ? `&kind=${encodeURIComponent(kind)}` : ''}`, undefined, { report: false })
};

export function statusOf(err: unknown): number | undefined {
  return err instanceof ApiError ? err.status : undefined;
}

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
