/** The json api behind /api. Same origin, so the dev server and caddy both forward it. */

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
  /** The name has an account, so only its owner can be behind it. */
  verified: boolean;
  /** When the picture was saved (unix seconds), the `?v=` of its url. `null`: no picture. */
  avatar: number | null;
  /** Pictures on the home card, oldest first. Empty or missing: the card shows the camera. */
  thumbs?: number[];
  /** Different addresses receiving the stream, from video. `null`: video did not answer, nobody knows. */
  viewers: number | null;
  /** The group badge after the name, the one their chat lines wear (primary, else the first joined). null: no group, or a stream without the ✓. Absent on an older api. */
  badge?: GroupBadge | null;
}

/** The account has a Google, Discord (any provider) login linked: the verified mark beside the ✓ (`OAuthMark`). Absent on an older api, which means not. */
interface OAuthVerified {
  oauth_verified?: boolean;
}

export interface Streamer extends OAuthVerified {
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
  /** The chat welcome (welcome-atoms.ts): whether the bot `Eques` says it when a viewer opens the chat, and the words. Absent on an older api: none said. */
  welcome_on?: boolean;
  welcome?: string;
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
  /** The one group badge the card shows under the name: their primary group, else the first they joined (the first their chat lines wear). null: no group. Absent on an older api. */
  badge?: GroupBadge | null;
}

/** One line of a direct message thread (docs/dms.md). `from` is the writer's name now; `at` unix milliseconds; `images` the pictures on it, the ids from `POST /api/chat-images`, empty for none (an older api leaves it off; `dm-atoms` fills it). */
export interface DmLine {
  id: number;
  from: string;
  text: string;
  at: number;
  images: string[];
  /** The video on it (`uploadChatVideo`'s id) and its poster. Absent or null for none. */
  video?: ChatVideo | null;
  /** The line of the thread this one answers (dms.rs `quote_json`): who wrote it as they are named now, the start of its words, their face, how many pictures; `gone` for one not there any more. Null or absent for none. */
  reply?: DmReply | null;
  /** The emoji on the line and who put them there (dms.rs, reactions.rs), as they are now; `dm_react` frames keep it so. Absent from a frame, which carries a new line: none yet. */
  reactions?: Reaction[];
}

/** What a direct message answers: the room chat's quote (`ChatReply`), by the thread's numeric id. */
export interface DmReply {
  id: number;
  from?: string;
  text?: string;
  avatar?: number | null;
  images?: number;
  /** The line answered had a video. */
  video?: boolean;
  gone?: boolean;
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
  /** A `chat` row's group, as its badge: on the list's rows (null once the group is gone), absent on a pushed one and on an older api. */
  badge?: GroupBadge | null;
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
export interface Followed extends OAuthVerified {
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
export interface Person extends OAuthVerified {
  name: string;
  verified: boolean;
  avatar: number | null;
  bio: string;
  presence: Presence;
  following: boolean;
}

/** One of home's recently offline (`GET /api/recent`): a name whose last stream ended lately, and when. Not live now. */
export interface Recent extends OAuthVerified {
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
export interface SearchHit extends OAuthVerified {
  name: string;
  verified: boolean;
  avatar: number | null;
  bio: string;
  live: boolean;
  presence: Presence;
  following: boolean;
}

/** `GET /api/search` answers this many at most (`SEARCH_LIMIT` in follows.rs). Fewer is every name the letters find. */
export const SEARCH_LIMIT = 20;
/** Letters fewer than this find names that start with them; from this many, names holding them anywhere (`SEARCH_ANYWHERE_FROM` in follows.rs). */
export const SEARCH_ANYWHERE_FROM = 3;

/** The letters the api searches by (`clean_query` in follows.rs): the name rule's, lowercased, 32 at most, the rest dropped. */
export function cleanSearch(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 32);
}

/** Does `name` answer the cleaned letters `q`, by the api's rule: starting with them under three, holding them from three. */
export function nameMatches(name: string, q: string): boolean {
  return q.length < SEARCH_ANYWHERE_FROM ? name.startsWith(q) : name.includes(q);
}

/**
 * One of the site's demo models (docs/vtuber.md), as `GET /api/models` lists them: a .vrm in the
 * bucket anyone may wear on the go live page. The name, the author and the licence are the
 * file's own words about itself.
 */
export interface DemoModel {
  /** The url: a-z 0-9 - _. */
  id: string;
  name: string;
  /** Empty when the file does not say. */
  author: string;
  licence: string;
  /** `0` (vrm 0.x) or `1` (vrm 1.0). */
  vrm: string;
  bytes: number;
  /** The `?v=` of its urls. */
  v: string;
  /** It has a thumbnail (`demoModelThumbUrl`). */
  thumb: boolean;
}

/** A group as worn on a chat line: enough to draw the badge, and the hover card it opens. */
export interface GroupBadge {
  name: string;
  /** The word on the badge. Shown in capitals. */
  badge: string;
  /** `#rrggbb` */
  color: string;
  /** Unix seconds, the `?v=` of the group's picture (`groupImage`), drawn small beside the word. Null, or absent on a line kept before it was carried and on an older api: none. */
  icon?: number | null;
  /** The line about the group, for the badge's hover card (GroupCard). Absent when empty, on a line kept before it was carried, and on an older api. */
  about?: string | null;
  /** How many are in it, counted when the line was said. Absent on an older line: the card leaves the count off. */
  members?: number | null;
  /** Unix seconds, the `?v=` of the group's banner (`groupImage`), the top of the hover card. Null or absent: none. */
  banner?: number | null;
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
  /** The login's primary group: its name wears this badge alone. Always false for nobody. Absent on an older api: none. */
  primary?: boolean;
}

export interface NewGroup {
  name: string;
  badge: string;
  color: string;
  about: string;
  /** Left off the lists when false. Omitted means public. */
  public?: boolean;
}

/** One room inside a server. The home one (`general` until renamed) is the one a group starts with. */
export interface Channel {
  name: string;
  about: string;
  /** The group's home channel: `/groups/:server` with no channel is it. Never deleted, never kept to a role. Absent on an older api: the one called `general`. */
  home?: boolean;
  /** The login can delete it: they made it, or they may manage channels. Never the home channel. */
  can_delete: boolean;
  /** The login can rename it and change its about line: they made it, or they may manage channels. The home channel too. Absent on an older api: `can_delete`. */
  can_edit?: boolean;
  /** Who made it, as they are now. Null for the home channel, and absent on an older api. A room keeps `can_delete` right as channels come and go. */
  made_by?: string | null;
  /** Seconds a member waits between their lines here (docs/groups.md). 0 or absent: none. The owners and the channels power wait for nobody. */
  cooldown?: number;
  /** `voice`: no lines, people talk in it (docs/voice.md). Absent on an older api: text. */
  kind?: ChannelKind;
  /** How many may be in a voice channel at once; 0 or absent is 16. */
  user_limit?: number;
}

export type ChannelKind = 'text' | 'voice';

/** Whether a channel is a voice one: not listed with the chat's channels, joined from the voice panel. */
export const isVoice = (channel: { kind?: string }): boolean => channel.kind === 'voice';

/** The name of a room's home channel (`home`, or `general` from an older api): the room's page when no channel is asked for. */
export const homeChannel = (channels: Channel[] | undefined): string => (channels ?? []).find((c) => c.home)?.name ?? 'general';

/** Whether the login may rename a channel and change its about line. */
export const canEditChannel = (channel: Channel): boolean => channel.can_edit ?? channel.can_delete;

/** One person in a voice channel, as the room says: `since` unix ms. */
export interface VoiceMember {
  name: string;
  uid: string;
  since: number;
  /** A moderator muted their mic (`voiceMute`): the voice server carries nothing of it until lifted. */
  muted?: boolean;
}

/** `POST .../voice/:channel/join`: the grant to bring to the voice server at `url`, good once and for `ttl` seconds. */
export interface VoiceGrant {
  url: string;
  grant: string;
  ttl: number;
}

/** Text channels on one server, `general` included; the voice ones are counted apart. Matches `TEXT_CHANNELS_PER_SERVER` in the api. */
export const CHANNEL_CAP = 20;

/** Voice channels on one server. Matches `VOICE_CHANNELS_PER_SERVER` in the api: a group with more from before keeps them and adds none. */
export const VOICE_CHANNEL_CAP = 4;

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
  /** Upload, rename and delete the group's custom emotes (emotes.rs). Absent on an older api: no. */
  emotes?: boolean;
}

/** A custom role. `id` is a uuid the api made: what the role is known by, so a rename is a save like any other. */
export interface GroupRole {
  id: string;
  name: string;
  color: string;
  perms: RolePerms;
  /** The channels kept to this role (docs/groups.md): its holders see them; whoever holds none of a channel's roles does not. Never `general`. Absent on an older api: none. */
  channels?: string[];
  /** Seconds its holders wait between lines in the group's channels (docs/groups.md). 0: none. A member waits the longest of their roles'; owners wait for nobody. Absent on an older api: none. */
  cooldown?: number;
}

/** What makes or replaces a role: everything but the id, every field said. */
export interface RoleBody {
  name: string;
  color: string;
  perms: RolePerms;
  channels: string[];
  cooldown: number;
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
  /** What the owner role is called: `owner` until an owner renames it. The word on the roster's crown. Absent on an older api. */
  owner_role?: string;
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
  /** The ids pinned in each channel this login sees, newest pin first (docs/groups.md "pins"). A channel with none is absent; absent on an older api. */
  pins?: Record<string, string[]>;
  /** Members streaming right now. Absent on an older api. */
  live?: string[];
  /** Who is in each voice channel this login sees, first in first (docs/voice.md). A channel nobody is in is absent; absent on an older api. */
  voice?: Record<string, VoiceMember[]>;
  /** The roster: anyone's on a public group, a member's or a site admin's on a private one. Null for anyone else; absent on an older api. */
  roster?: GroupMember[] | null;
  /** Asked for a page of it (`group(name, roster)`): where the next page starts (`groupMembersPage`'s `after`). Null once the roster is whole; absent on an older api. */
  roster_next?: string | null;
  /** Who holds each role, by role id: the names, the whole group's and not a page's, so a chat line's speaker wears their role's colour (ChatPanel.tsx). A role nobody holds is absent. The roster's rule: null when it is; absent on an older api. */
  holders?: Record<string, string[]> | null;
  /** Who is banned, for the ban power. Null for anyone else; absent on an older api. */
  bans?: GroupBan[] | null;
}

/** A channel's pinned line (`GET .../pins`): the line as it was said, its face as it is now, and who pinned it (null for an account since gone) and when (unix ms). */
export type PinnedLine = ChatLine & { pinned_by: string | null; pinned_at: number };

export interface GroupMember {
  name: string;
  owner: boolean;
  /** Absent on an older api. */
  avatar?: number | null;
  /** When they joined, unix seconds, so the room keeps the group's order as people come. Absent on an older api. */
  joined?: number;
  roles: { id: string; name: string; color: string }[];
  /** Timed out (docs/groups.md): until when, unix seconds, while it runs; null or absent otherwise. */
  timeout?: number | null;
}

/** One of a member's lines in the group (`groupMemberMessages`): the line, and the channel it is in. */
export type MemberLine = ChatLine & { channel: string };

export interface GroupBan {
  name: string;
  reason: string;
}

/** A timeout still running (`groupTimeouts`): until when (unix seconds), the reason given, who set it (null when they are gone), and whether they are still a member. */
export interface GroupTimeout {
  name: string;
  avatar: number | null;
  until: number;
  reason: string;
  by: string | null;
  member: boolean;
}

/** The words on the square, and the four digits when the group has them. */
export function groupWords(group: { name: string; title?: string | null; tag?: number | null }): { title: string; tag: string | null } {
  const title = group.title && group.title.length > 0 ? group.title : group.name;
  const tag = group.tag == null ? null : String(group.tag).padStart(4, '0');
  return { title, tag };
}

/**
 * Whether a search's letters are somewhere in the group's words: the title, the four digits
 * (with or without the `#`, alone or after the title as the rows show them, `gaming #0042`, or
 * run together, `gaming#0042`), the address, the badge, the about. `query` trimmed and
 * lowercased by the caller; empty, it matches everything. The groups page and the sidebar's
 * box share it.
 */
export function groupMatches(group: { name: string; badge: string; about: string; title?: string | null; tag?: number | null }, query: string): boolean {
  if (!query) return true;
  const { title, tag } = groupWords(group);
  const named = tag ? `${title} #${tag} ${title}#${tag}` : title;
  return `${named} ${group.name} ${group.badge} ${group.about}`.toLowerCase().includes(query);
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

export interface WatchGrant extends OAuthVerified {
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
  /** The chat welcome (welcome-atoms.ts): whether the bot `Eques` says it when a viewer opens the chat, and the words. Absent on an older api: none said. */
  welcome_on?: boolean;
  welcome?: string;
  /** How many follow the name, and whether the asking login does (docs/follows.md). Absent on an older api. */
  followers?: number;
  following?: boolean;
  /** When the account was made, rfc3339, for the socials tab's `joined` line; null for a free name. Absent on an older api. */
  joined_at?: string | null;
  /** The group badge beside the name in the header: the one their chat lines wear (primary, else the first joined). null: no group or no account. Absent on an older api. */
  badge?: GroupBadge | null;
  /** This login may clean the chat (docs/jannies.md): the streamer, a janny of theirs, a site janny or an admin. Which buttons to draw; every action asks again. Absent on an older api. */
  can_moderate?: boolean;
}

/** A janny, as the mod tab and /admin list them (docs/jannies.md). */
export interface Janny {
  name: string;
  added_at: string;
}

/** A stream chat's bans and running timeouts (`GET /api/streams/:name/bans`). `by` is null when whoever did it is gone. */
export interface StreamBans {
  bans: { name: string; by: string | null; reason: string; at: string }[];
  timeouts: { name: string; by: string | null; until: string }[];
}

/** One thing done in a stream's chat: a deleted line (its copy in `snapshot`), a ban, a timeout, a janny named or dropped. Newest first. */
export interface ModLogRow {
  at: string;
  actor: string;
  action: 'delete' | 'ban' | 'unban' | 'timeout' | 'untimeout' | 'janny' | 'unjanny' | string;
  target: string;
  line_id: string | null;
  snapshot: (Partial<ChatLine> & { reason?: string; seconds?: number }) | null;
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
  /** false: an account made with a provider (Google, Discord) that has no password yet. null for nobody; absent on an older api (which means true). */
  has_password?: boolean | null;
  /** This account has an outside login linked: the verified mark (`OAuthMark`). null for nobody; absent on an older api. */
  oauth_verified?: boolean | null;
  /** This account's old names still held for it: going back onto one is allowed any time. Absent on an older api. */
  held?: string[];
}

/** A login provider's slug (docs/accounts.md): `google`, `discord`, or one added to the api later. The api turns each on from its env vars; infra/oauth.ts has the words for them. */
export type OAuthProvider = string;

/** `GET /api/oauth/identities`: the providers linked to this login, whether it has a password, and whether it is verified (anything linked). */
export interface OAuthIdentities {
  has_password: boolean;
  /** Absent on an older api: then it is `identities.length > 0`. */
  oauth_verified?: boolean;
  /**
   * `name` and `avatar` are what the provider shows (the picture only ever on its own image
   * host); null for one linked before they were kept, until its next login, and absent on an
   * older api. Never the email.
   */
  identities: { provider: OAuthProvider; linked_at: string; name?: string | null; avatar?: string | null }[];
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
  const res = fetch(path, {
    method,
    headers: body === undefined ? {} : { 'content-type': raw ? body.type : 'application/json' },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    signal: options.timeoutMs === undefined ? undefined : AbortSignal.timeout(options.timeoutMs)
  });
  return answerOf<T>(method, path, res, options);
}

/** `request`'s reading of the answer, for a request already sent: the watch grant index.html's boot script asks before the bundle is here. */
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

/** The two ranges the stats tab offers. */
export type StatsDays = 7 | 30;

/** One of my streams, as the stats list has it (analytics.rs `stream_json`). Times rfc3339, lengths in seconds. */
export interface StreamStatsRow {
  id: number;
  /** The name it went out under (an account renamed since keeps its streams). */
  name: string;
  started_at: string;
  ended_at: string | null;
  live: boolean;
  duration_secs: number;
  peak_viewers: number;
  /** The average of the per-minute samples. null: no sample yet (under a minute, or video never answered). */
  avg_viewers: number | null;
  watch_secs: number;
  /** Different viewers: logins and anonymous browsers both. */
  unique_viewers: number;
}

/** One stream in full: the row, the graph and the rest. */
export interface StreamDetail extends StreamStatsRow {
  /** `[unix ms, viewers]`, one a minute, oldest first. */
  points: [number, number][];
  account_viewers: number;
  anon_viewers: number;
  /** Follows that came while it was live, and are still there. */
  new_follows: number;
  /** Chat lines from anyone but the streamer, while it was live. 0 where chat history is off. */
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
  /** The range's streams, newest first. */
  streams: StreamStatsRow[];
  /** The last stream, whenever it was. null: never live with this account. */
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
  /** The login cookie goes along on its own (httponly, same origin). Every field null for nobody. */
  me: () => request<MeInfo>('GET', '/api/me'),
  signup: (name: string, password: string) => request<{ name: string }>('POST', '/api/signup', { name, password }),
  login: (name: string, password: string) => request<{ name: string }>('POST', '/api/login', { name, password }),
  logout: () => request<null>('POST', '/api/logout'),
  /** Every login of the account, this one included. */
  logoutAll: () => request<null>('POST', '/api/logout-all'),
  changePassword: (old: string, next: string) => request<null>('POST', '/api/password', { old, new: next }),
  /** The providers turned on here, for the "continue with" buttons. Public. */
  oauthProviders: () => request<{ providers: OAuthProvider[] }>('GET', '/api/oauth/providers'),
  oauthIdentities: () => request<OAuthIdentities>('GET', '/api/oauth/identities'),
  /** 409 when it is the last way in (no password, nothing else linked). */
  oauthUnlink: (provider: OAuthProvider) => request<null>('POST', `/api/oauth/${provider}/unlink`),
  /** The pending newcomer (after a provider login nobody here has): which provider, and a name to start from. 404 when there is none. */
  oauthSignupInfo: () => request<{ provider: OAuthProvider; suggested: string }>('GET', '/api/oauth/signup'),
  oauthSignup: (name: string) => request<{ id: string; name: string }>('POST', '/api/oauth/signup', { name }),
  /** The account's name changes; its logins, groups and pictures stay. Once a month, with the password, not while live. See docs/ids.md. */
  rename: (name: string, password: string) => request<{ id: string; name: string; renamed_at: string }>('POST', '/api/name', { name, password }),
  /** Every group, `bot` first; `mine` says which the login is in. See docs/groups.md. */
  groups: () => request<Group[]>('GET', '/api/groups'),
  /** A login makes a group and is in it, as its owner. 400 bad name/badge/colour, 403 at the cap on owned groups (`groups_per_owner`), 409 `name taken`. */
  createGroup: (group: NewGroup) => request<Group>('POST', '/api/groups', group),
  joinGroup: (name: string) => request<null>('POST', `/api/groups/${encodeURIComponent(name)}/join`),
  leaveGroup: (name: string) => request<null>('POST', `/api/groups/${encodeURIComponent(name)}/leave`),
  /** The one group whose badge the login's name wears, in place of every group's. 403 `join it first`. Leaving it clears it. */
  setPrimaryGroup: (name: string) => request<null>('PUT', `/api/groups/${encodeURIComponent(name)}/primary`),
  /** Back to the first joined group's badge. */
  clearPrimaryGroup: (name: string) => request<null>('DELETE', `/api/groups/${encodeURIComponent(name)}/primary`),
  /** An owner, the one who made it, or an admin. Its members are out with it. */
  deleteGroup: (name: string) => request<null>('DELETE', `/api/groups/${encodeURIComponent(name)}`),
  /** The whole room: the group, its roles, what this login may do, the channels, who is live, and the roster and bans it may see. 404 for no such group. */
  group: (name: string, roster?: number) => request<GroupRoom>('GET', `/api/groups/${encodeURIComponent(name)}${roster === undefined ? '' : `?roster=${roster}`}`),
  /** The last lines of every channel (`limit` each, 100 at most and left out), oldest first, keyed by channel. What the room draws before its socket says more. */
  groupMessages: (name: string, limit?: number) =>
    request<Record<string, ChatLine[]>>('GET', `/api/groups/${encodeURIComponent(name)}/messages${limit === undefined ? '' : `?limit=${limit}`}`),
  /** Servers you are in, then the ones you can find. `bot` is not a server. See docs/groups.md. */
  explore: () => request<Explore>('GET', '/api/explore'),
  /** Someone who may add a channel. 403 until they have joined, or without the power. The new channel goes after the last. */
  createChannel: (server: string, name: string, about = '', kind: ChannelKind = 'text') =>
    request<Channel>('POST', `/api/groups/${encodeURIComponent(server)}/channels`, { name, about, kind }),
  /** A grant for the voice server (docs/voice.md). `tab` is this page's id for itself: a join from the same tab takes the seat it still holds. 409 `already in voice` / `channel full`; 503 `voice is off` while the box has no voice. Not reported: a 503 here is a setting, not a fault. */
  joinVoice: (server: string, channel: string, tab: string) =>
    request<VoiceGrant>('POST', `/api/groups/${encodeURIComponent(server)}/voice/${encodeURIComponent(channel)}/join`, { tab }, { report: false }),
  /** The channels in this order, from the top. The channels power. A channel not named keeps its place after these. → the whole order as it now stands. */
  setChannelOrder: (server: string, order: string[]) => request<{ order: string[] }>('PUT', `/api/groups/${encodeURIComponent(server)}/channels`, { order }),
  /** The channel is called `name` from now on (its lines, mutes, pins and inbox rows with it), and `about` is its line; either may be left out. Who made it, or the channels power; text or voice, the home channel too. → the channel as the room lists it. */
  editChannel: (server: string, channel: string, edit: { name?: string; about?: string }) =>
    request<Channel>('PUT', `/api/groups/${encodeURIComponent(server)}/channels/${encodeURIComponent(channel)}`, edit),
  /** Who made the channel, or someone who may manage channels. The home channel stays. */
  deleteChannel: (server: string, channel: string) => request<null>('DELETE', `/api/groups/${encodeURIComponent(server)}/channels/${encodeURIComponent(channel)}`),
  /** A member waits `seconds` (0 to 3600; 0 none) between their lines in the channel. The channels power. */
  setChannelCooldown: (server: string, channel: string, seconds: number) =>
    request<{ cooldown: number }>('PUT', `/api/groups/${encodeURIComponent(server)}/channels/${encodeURIComponent(channel)}/cooldown`, { seconds }),
  /** Who sees the channel (docs/groups.md): kept to exactly these roles, by id, in one go; `[]` is everyone. The channels power; a role carrying a power the login lacks is out of reach. the home channel stays everyone's. */
  setChannelRoles: (server: string, channel: string, roles: string[]) =>
    request<{ channel: string; roles: string[] }>('PUT', `/api/groups/${encodeURIComponent(server)}/channels/${encodeURIComponent(channel)}/roles`, { roles }),
  /** No inbox row for this channel's lines from now on, for this login (docs/notifications.md). 204, also when already muted. */
  muteChannel: (server: string, channel: string) => request<null>('PUT', `/api/groups/${encodeURIComponent(server)}/channels/${encodeURIComponent(channel)}/mute`),
  /** A channel's pinned lines, newest pin first, each a line plus who pinned it and when. Whoever sees the channel. */
  channelPins: (server: string, channel: string) =>
    request<{ pins: PinnedLine[] }>('GET', `/api/groups/${encodeURIComponent(server)}/channels/${encodeURIComponent(channel)}/pins`),
  /** Pin a line of the channel (the channels power). The pin back; the same when it was pinned already. 50 a channel at most. */
  pinLine: (server: string, channel: string, id: string) =>
    request<PinnedLine>('POST', `/api/groups/${encodeURIComponent(server)}/channels/${encodeURIComponent(channel)}/pins/${encodeURIComponent(id)}`),
  /** Unpin it. 204, also when it was not pinned. */
  unpinLine: (server: string, channel: string, id: string) =>
    request<null>('DELETE', `/api/groups/${encodeURIComponent(server)}/channels/${encodeURIComponent(channel)}/pins/${encodeURIComponent(id)}`),
  /** The channel's lines reach the bell again. 204, also when it was not muted. */
  unmuteChannel: (server: string, channel: string) => request<null>('DELETE', `/api/groups/${encodeURIComponent(server)}/channels/${encodeURIComponent(channel)}/mute`),
  /** The login has the channel on screen: its inbox rows for it are read. Its other devices hear it on the socket. */
  readChannel: (server: string, channel: string) => request<null>('PUT', `/api/groups/${encodeURIComponent(server)}/channels/${encodeURIComponent(channel)}/read`),
  saveGroupAbout: (name: string, about: string) => request<{ about: string }>('PUT', `/api/groups/${encodeURIComponent(name)}/about`, { about }),
  /** Appearance, from the manage dialog: `#rrggbb`. The `color` fact repaints the room and the lists. */
  saveGroupColor: (name: string, color: string) => request<{ color: string }>('PUT', `/api/groups/${encodeURIComponent(name)}/color`, { color }),
  /** Appearance, from the manage dialog. A private group stays off the lists. */
  setGroupPublic: (name: string, isPublic: boolean) => request<{ public: boolean }>('PUT', `/api/groups/${encodeURIComponent(name)}/access`, { public: isPublic }),
  /** Appearance. Owners stay first; this is the order after them. */
  setMemberOrder: (name: string, order: 'name' | 'newest' | 'oldest') => request<{ order: string }>('PUT', `/api/groups/${encodeURIComponent(name)}/order`, { order }),
  /** An owner (or a site admin), 403 for anyone else. The crop dialog made the jpeg. There is no remove: a group with a picture keeps one. */
  saveGroupIcon: (name: string, jpeg: Blob) => request<{ icon: number }>('PUT', `/api/groups/${encodeURIComponent(name)}/icon`, jpeg),
  saveGroupBanner: (name: string, jpeg: Blob) => request<{ banner: number }>('PUT', `/api/groups/${encodeURIComponent(name)}/banner`, jpeg),
  /** A group's custom emotes, oldest first, for a member (docs/chat.md "emotes"): the cap, and whether this login manages them (an owner, the emotes power). 403 for anyone else. */
  groupEmotes: (group: string) => request<{ emotes: GroupEmote[]; max: number; manage: boolean }>('GET', `/api/groups/${encodeURIComponent(group)}/emotes`),
  /** A manager's new emote: the crop dialog's square picture and its name. The api draws it again as a 128px webp. 400 the name's rule or not a picture, 409 the name taken or the group full, 413 past 512 kb. */
  uploadEmote: (group: string, picture: Blob, name: string) => {
    const form = new FormData();
    form.set('name', name);
    form.set('image', picture, 'emote');
    const path = `/api/groups/${encodeURIComponent(group)}/emotes`;
    return answerOf<GroupEmote>('POST', path, fetch(path, { method: 'POST', body: form }));
  },
  /** A manager's rename. The lines already sent draw under the new name. 409 the name taken. */
  renameEmote: (group: string, id: string, name: string) =>
    request<GroupEmote>('PATCH', `/api/groups/${encodeURIComponent(group)}/emotes/${encodeURIComponent(id)}`, { name }),
  /** A manager's delete. Its tokens draw as plain `:name:` from now on, and its reactions go. */
  deleteEmote: (group: string, id: string) => request<null>('DELETE', `/api/groups/${encodeURIComponent(group)}/emotes/${encodeURIComponent(id)}`),
  /** Every emote of every group the login is in, by group then name: the composer's `:` list and the reaction picker. Empty for nobody. */
  myEmotes: () => request<{ emotes: Emote[] }>('GET', '/api/emotes/mine'),
  /** What these emote ids are (100 at most): name and group for each one still there; one missing is gone. Anyone's. */
  emotes: (ids: readonly string[]) => request<{ emotes: Emote[] }>('GET', `/api/emotes?ids=${ids.map(encodeURIComponent).join(',')}`),
  groupMembers: (name: string) => request<GroupMember[]>('GET', `/api/groups/${encodeURIComponent(name)}/members`),
  /** One page of the roster in its order: `limit` (100 at most), after the page whose `next` is `after`, and with `q` only the names, or held roles, with the words in them. `next` null at the end. */
  groupMembersPage: (name: string, page: { limit: number; after?: string | null; q?: string }) => {
    const query = new URLSearchParams({ limit: String(page.limit) });
    if (page.after) query.set('after', page.after);
    if (page.q) query.set('q', page.q);
    return request<{ members: GroupMember[]; next: string | null }>('GET', `/api/groups/${encodeURIComponent(name)}/members?${query}`);
  },
  groupBans: (name: string) => request<GroupBan[]>('GET', `/api/groups/${encodeURIComponent(name)}/bans`),
  /** The roles power. 201 the role, with the id the api made. 409 `name taken`, 403 past the cap or out of reach. */
  createRole: (group: string, role: RoleBody) => request<GroupRole>('POST', `/api/groups/${encodeURIComponent(group)}/roles`, role),
  /** The role replaced whole, by id: a rename, a new colour, other powers, all this one call. `channels` replaces the ones kept to it that the login sees: the manage dialog sends them back as they stand, and says who sees a channel from the channel's side (`setChannelRoles`). */
  saveRole: (group: string, id: string, role: RoleBody) => request<GroupRole>('PUT', `/api/groups/${encodeURIComponent(group)}/roles/${id}`, role),
  deleteRole: (group: string, id: string) => request<null>('DELETE', `/api/groups/${encodeURIComponent(group)}/roles/${id}`),
  giveRole: (group: string, id: string, name: string) => request<null>('POST', `/api/groups/${encodeURIComponent(group)}/roles/${id}/members`, { name }),
  takeRole: (group: string, id: string, name: string) =>
    request<null>('DELETE', `/api/groups/${encodeURIComponent(group)}/roles/${id}/members/${encodeURIComponent(name)}`),
  /** No line of `name`'s in the group's channels, and no voice, for `seconds` (10 to a week), `reason` kept with it. The kick power; not an owner unless by an owner. Set again, the new end stands. */
  timeoutMember: (group: string, name: string, seconds: number, reason = '') =>
    request<null>('POST', `/api/groups/${encodeURIComponent(group)}/timeout`, { name, seconds, reason }),
  /** The timeout lifted early. The kick power. */
  liftTimeout: (group: string, name: string) => request<null>('DELETE', `/api/groups/${encodeURIComponent(group)}/timeout/${encodeURIComponent(name)}`),
  /** Every timeout still running, the soonest to end first. The kick power. */
  groupTimeouts: (group: string) => request<GroupTimeout[]>('GET', `/api/groups/${encodeURIComponent(group)}/timeouts`),
  /** The group is `name`'s from now on and not this login's: they are made an owner and the login stops being one, in one go. An owner, for a member who is not one; the cap on owning counts for them. */
  transferOwnership: (group: string, name: string) => request<null>('POST', `/api/groups/${encodeURIComponent(group)}/transfer`, { name }),
  /** What the owner role is called from now on. An owner. 400 a bad name, 409 a custom role's name. */
  renameOwnerRole: (group: string, name: string) => request<{ name: string }>('PUT', `/api/groups/${encodeURIComponent(group)}/owner-role`, { name }),
  revokeOwner: (group: string, name: string) => request<null>('DELETE', `/api/groups/${encodeURIComponent(group)}/owners/${encodeURIComponent(name)}`),
  kickMember: (group: string, name: string) => request<null>('POST', `/api/groups/${encodeURIComponent(group)}/kick`, { name }),
  /** One member as the roster has them (joined, roles, timeout): a page of the roster may not have them. The roster's rule. */
  groupMember: (group: string, name: string) => request<GroupMember>('GET', `/api/groups/${encodeURIComponent(group)}/members/${encodeURIComponent(name)}`),
  /** A member's lines in the channels this login sees, newest first, 50 a page; `before` the last page's `next`. The kick or ban power. */
  groupMemberMessages: (group: string, name: string, before?: string | null) => {
    const query = before ? `?before=${encodeURIComponent(before)}` : '';
    return request<{ lines: MemberLine[]; next: string | null }>('GET', `/api/groups/${encodeURIComponent(group)}/members/${encodeURIComponent(name)}/messages${query}`);
  },
  /** A channel's line out for good, for everyone in the room. Its author, or the kick power for anyone else's. */
  deleteGroupMessage: (group: string, channel: string, id: string) =>
    request<null>('DELETE', `/api/groups/${encodeURIComponent(group)}/channels/${encodeURIComponent(channel)}/messages/${encodeURIComponent(id)}`),
  /** A moderator's mute on `name`'s mic in the group's voice, or its lifting: they cannot lift it themselves. The kick or voice power. */
  voiceMute: (group: string, name: string, muted: boolean) =>
    request<{ muted: boolean }>('POST', `/api/groups/${encodeURIComponent(group)}/voice-mute`, { name, muted }),
  /** `name` out of the group's voice now; they may join again. The kick or voice power. */
  voiceDisconnect: (group: string, name: string) => request<null>('POST', `/api/groups/${encodeURIComponent(group)}/voice-disconnect`, { name }),
  banMember: (group: string, name: string, reason: string) => request<null>('POST', `/api/groups/${encodeURIComponent(group)}/ban`, { name, reason }),
  unbanMember: (group: string, name: string) => request<null>('DELETE', `/api/groups/${encodeURIComponent(group)}/bans/${encodeURIComponent(name)}`),
  // ---- a stream chat's jannies (docs/jannies.md). the streamer, their jannies, site jannies and admins; the api has the last word on who outranks whom
  /** A line out of the stream's chat for good; everyone in the room sees it go. Its copy goes to the mod log. */
  deleteChatLine: (name: string, id: string) => request<null>('DELETE', `/api/streams/${encodeURIComponent(name)}/chat/${encodeURIComponent(id)}`),
  /** No line or reaction of `who`'s in the stream's chat until lifted. An account only. */
  banFromChat: (name: string, who: string, reason = '') => request<null>('POST', `/api/streams/${encodeURIComponent(name)}/bans`, { name: who, reason }),
  unbanFromChat: (name: string, who: string) => request<null>('DELETE', `/api/streams/${encodeURIComponent(name)}/bans/${encodeURIComponent(who)}`),
  /** The same for `seconds` (10 to a week). Set again, the new end stands. */
  timeoutInChat: (name: string, who: string, seconds: number) => request<null>('POST', `/api/streams/${encodeURIComponent(name)}/timeouts`, { name: who, seconds }),
  liftChatTimeout: (name: string, who: string) => request<null>('DELETE', `/api/streams/${encodeURIComponent(name)}/timeouts/${encodeURIComponent(who)}`),
  chatBans: (name: string) => request<StreamBans>('GET', `/api/streams/${encodeURIComponent(name)}/bans`),
  modLog: (name: string) => request<ModLogRow[]>('GET', `/api/streams/${encodeURIComponent(name)}/mod-log`),
  /** The stream's jannies. The streamer or an admin. */
  streamJannies: (name: string) => request<Janny[]>('GET', `/api/streams/${encodeURIComponent(name)}/jannies`),
  addStreamJanny: (name: string, who: string) => request<null>('POST', `/api/streams/${encodeURIComponent(name)}/jannies`, { name: who }),
  removeStreamJanny: (name: string, who: string) => request<null>('DELETE', `/api/streams/${encodeURIComponent(name)}/jannies/${encodeURIComponent(who)}`),
  /** The site jannies: every stream's chat. Admins only. */
  siteJannies: () => request<Janny[]>('GET', '/api/jannies'),
  addSiteJanny: (who: string) => request<null>('POST', '/api/jannies', { name: who }),
  removeSiteJanny: (who: string) => request<null>('DELETE', `/api/jannies/${encodeURIComponent(who)}`),
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
  /**
   * A video for a chat line, the file as it is (an mp4 or a webm, 10 mb and 30 seconds at most). The api measures it,
   * keeps a copy with no metadata and draws its poster, whose id comes back. `onProgress` hears the share sent, 0 to 1:
   * an xhr, since fetch cannot say. 400 the type's, the codecs' or the length's words; 413 too big; 429 `slow down`.
   */
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
  /** Everyone with a row who is not live: home's second half, online first. 100 at most. */
  people: () => request<Person[]>('GET', '/api/people'),
  /** The names whose last stream ended most recently and who are not live again, newest end first, 12 at most: home's recently offline. */
  recent: () => request<Recent[]>('GET', '/api/recent'),
  /** The login's direct message threads, newest line first, with how many lines are new in each. 401 for nobody. See docs/dms.md. */
  dms: () => request<DmThread[]>('GET', '/api/dms'),
  /** One page of the thread with `name`, oldest first: the newest page, or the one before line `before`. A short page is the start. */
  dmThread: (name: string, before?: number) =>
    request<{ name: string; friends: boolean; lines: DmLine[] }>('GET', `/api/dm/${encodeURIComponent(name)}${before === undefined ? '' : `?before=${before}`}`),
  /** A line to a friend: the words, and the pictures on it (`uploadChatImage`'s ids, ten at most; the words may be empty then). 201 with the line as kept; it also comes back on the events socket. 400 `too long`, `nothing to say`, `no such picture`, 403 not friends, 429 `slow down`. */
  sendDm: (name: string, text: string, images: string[] = [], reply: number | null = null, video: string | null = null) =>
    request<DmLine & { to: string }>('POST', `/api/dm/${encodeURIComponent(name)}`, {
      text,
      images,
      ...(reply === null ? {} : { reply }),
      ...(video === null ? {} : { video })
    }),
  /** The login's `emoji` on line `id` of the thread with `name`, or off it. The line's reactions as they are now; both sides' devices hear the change on the socket (`dm_react`). 400 `not a reaction`, `no such line`, `too many reactions`, 403 not friends, 429 `slow down`. */
  reactDm: (name: string, id: number, emoji: string, on: boolean) =>
    request<{ id: number; reactions: unknown }>('PUT', `/api/dm/${encodeURIComponent(name)}/react`, { id, emoji, on }),
  /** The login has seen the thread with `name` up to that line. Its other devices hear it on the socket. */
  readDm: (name: string, id: number) => request<null>('PUT', `/api/dm/${encodeURIComponent(name)}/read`, { id }),
  /** The lines of the thread with `name` that match, newest first, 50 at most. The box is the room chat's (`ChatSearch.tsx`): words, a quoted phrase, and the filters among them. 400 with the words when it cannot be read. */
  searchDm: (name: string, q: string) => request<{ lines: DmLine[] }>('GET', `/api/dm/${encodeURIComponent(name)}/search?q=${encodeURIComponent(q)}`),
  /** The login's inbox, newest first, the last 30, and which kinds it keeps. 401 for nobody. See docs/notifications.md. */
  notifications: () => request<{ settings: NotifySettings; items: Notification[] }>('GET', '/api/notifications'),
  /** The login has seen its inbox up to that row. Its other devices hear it on the socket. */
  readNotifications: (id: number) => request<null>('PUT', '/api/notifications/read', { id }),
  /** One row of the inbox gone, dismissed by hand. 204; 404 when it is not this login's or is gone already. Its other devices hear it on the socket. */
  dismissNotification: (id: number) => request<null>('DELETE', `/api/notifications/${id}`),
  /** Which kinds go in the inbox from now on, replaced whole; the answer is what was kept. */
  saveNotifySettings: (settings: NotifySettings) => request<NotifySettings>('PUT', '/api/notifications/settings', settings),
  /** The status, one line beside the name: runs of whitespace become one space, 200 characters at most (400 past that). `bio` on the wire. */
  saveBio: (name: string, bio: string) => request<{ name: string; bio: string }>('PUT', `/api/streamers/${name}`, { bio }),
  /** The page under that: `{ blocks: [{ type, id, x, y, z, w, h, r?, font?, size?, color?, bg?, stroke?, strokeColor?, align?, html? }] }`. Text html is written to the bucket. A line, a box, and a border have no file. */
  aboutPage: (name: string) => request<{ blocks: PageWire[] }>('GET', `/api/streamers/${encodeURIComponent(name)}/about-page`),
  saveAboutPage: (name: string, blocks: PageWire[]) => request<{ blocks: PageWire[] }>('PUT', `/api/streamers/${encodeURIComponent(name)}/about-page`, { blocks }),
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
  /** The site's demo models (docs/vtuber.md), for the go live page's picker. An api from before them answers 404: no demo models, which is nothing to say. */
  demoModels: () => request<{ models: DemoModel[] }>('GET', '/api/models'),
  /** `v` is the start of the file's hash, so the bytes behind one url never change and it caches for good. */
  demoModelUrl: (model: Pick<DemoModel, 'id' | 'v'>) => `/api/models/${encodeURIComponent(model.id)}?v=${encodeURIComponent(model.v)}`,
  demoModelThumbUrl: (model: Pick<DemoModel, 'id' | 'v'>) => `/api/models/${encodeURIComponent(model.id)}/thumb?v=${encodeURIComponent(model.v)}`,
  /** The jpeg itself as the body. The page has already made it 1920x1080 and under 1 mb. */
  saveOffline: (name: string, jpeg: Blob) => request<{ name: string; offline: number }>('PUT', `/api/streamers/${name}/offline`, jpeg),
  deleteOffline: (name: string) => request<null>('DELETE', `/api/streamers/${name}/offline`),
  /** Like `avatarUrl`: the version makes a new url per upload, so a day of cache is safe. */
  offlineUrl: (name: string, version: number) => `/api/streamers/${encodeURIComponent(name)}/offline?v=${version}`,
  /** The line under the word while not live. One line, 140 characters; empty clears it. */
  saveOfflineNote: (name: string, note: string) => request<{ name: string; offline_note: string }>('PUT', `/api/streamers/${name}/offline-note`, { note }),
  /** The chat welcome, through the bio's gate (welcome-atoms.ts). The words cleaned, 300 characters; empty is the default words. */
  saveWelcome: (name: string, welcome: { on: boolean; message: string }) =>
    request<{ name: string; welcome_on: boolean; welcome: string }>('PUT', `/api/streamers/${name}/welcome`, welcome),
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
  /** The same grant, asked by index.html's boot script (`fetch` of that path, the same timeout): read like `watch`'s. */
  watchAsked: (name: string, response: Promise<Response>) => answerOf<WatchGrant>('POST', `/api/streams/${name}/watch`, response),
  /** The watch page's beat for the streamer's stats (watch-beat.ts). `anon` is this browser's id, ignored for a login. Not reported: a beat lost is a minute less, nothing to fix. */
  watching: (name: string, anon: string) =>
    request<{ ok: boolean; counted: boolean }>('POST', `/api/streams/${name}/watching?anon=${encodeURIComponent(anon)}`, undefined, { report: false }),
  /** The last beat, on the way out: survives page teardown, unlike fetch. */
  watchingBeacon: (name: string, anon: string) => navigator.sendBeacon(`/api/streams/${name}/watching?anon=${encodeURIComponent(anon)}&leave=1`),
  /** My streams' numbers (docs/analytics.md): the range's summary and streams, and the last stream in full. 401 for nobody logged in. */
  stats: (days: StatsDays) => request<Stats>('GET', `/api/stats?days=${days}`),
  /** One of my streams in full, for the graph. 404 for one that is not mine. */
  statsStream: (id: number) => request<StreamDetail>('GET', `/api/stats/streams/${id}`),
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
