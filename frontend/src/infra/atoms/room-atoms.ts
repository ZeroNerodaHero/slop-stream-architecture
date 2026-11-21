/**
 * A group's room (docs/groups.md), loaded once and then kept by the socket. Arriving on
 * `/groups/<server>` asks the api twice, in parallel: the room (`GET /api/groups/:group`:
 * the group, the channels, who is live, the roster and the bans this login may see) and the
 * last lines of every channel (`GET .../messages`, into the chat's shelf). From then on the
 * events socket is the only source: `watch group:<server>` brings a `group` frame for every
 * change (someone joined, a channel was added, a role was given, a member went live…) and
 * this module patches the room in place. Changing channels asks nothing of anyone. The one
 * pull behind the push: a change about the login itself (its own membership, powers or roles)
 * asks the room again, since what it may see depends on them; and the socket coming back
 * after a gap does too, since the facts of the gap are gone. Same shape as the other atom
 * modules: atoms for what renders, module handles, action functions.
 */

import { atom } from 'jotai';

import { api, type Channel, type GroupMember, type GroupRoom, isVoice, messageOf, statusOf, type VoiceMember } from '@/infra/api';
import { meAtom } from '@/infra/atoms/auth-atoms';
import { type ChatLine, findServerChat, serverChat } from '@/infra/atoms/chat-atoms';
import { voiceCallAtom, voiceUidsAtom } from '@/infra/atoms/voice-atoms';
import { holdPresence, onEvents, releasePresence, unwatchPresence, watchPresence } from '@/infra/events';
import { type GroupChange, groupTopic } from '@/infra/frames';
import { onPrefetch, prefetch, takePrefetched } from '@/infra/prefetch';
import { store } from '@/infra/store';

/** The room on screen, as loaded and then patched. `null` before the first answer, and off the page. */
export const roomAtom = atom<GroupRoom | null>(null);
/** Why there is no room: `no such group`, or what the api said. '' while there is one, or none has been asked yet. */
export const roomErrorAtom = atom('');
/** The group was deleted while its room was on screen. */
export const roomGoneAtom = atom(false);
/** A channel was renamed while the room was on screen: the page on `from` moves to `to`, and clears this. */
export const channelRenamedAtom = atom<{ from: string; to: string } | null>(null);

/** Where the next page of the roster stands: being asked for, or refused the last time (a scroll back to the end asks again). */
export const rosterMoreAtom = atom<'idle' | 'busy' | 'failed'>('idle');

/** The shortest a roster row is (ServerRoom.tsx `Member`: a 28px face and its border, no roles), so a page of them is never short of its height. */
export const MEMBER_ROW_PX = 30;
/** The shortest a chat line is (ChatPanel.tsx: one line of text and the gap under it), the same way. */
const LINE_PX = 22;
/** The fewest rows a page asks for, however short the box: one scroll's worth is not worth a round trip each. */
const MIN_PAGE = 20;
/** The most a page asks for: the api's cap on both the roster's pages and the lines of each channel. */
const MAX_PAGE = 100;

/**
 * How many rows of `rowPx` fill twice `height` (the box they scroll in; the window's while the
 * box is not on screen yet, which is what the box is at its tallest): the first page fills the
 * box and a scroll's worth under it, and the next is asked for before the end comes into view.
 */
export function pageFor(rowPx: number, height: number = window.innerHeight): number {
  return Math.min(MAX_PAGE, Math.max(MIN_PAGE, Math.ceil((2 * height) / rowPx)));
}

/** The server whose room is open. '' off the page. */
let open = '';
/** Which load is the current one: an answer to an older one, or to a page since left, is dropped. */
let attempt = 0;

/** The room page arrived: the feed on, the room and its lines asked. */
export function enterRoom(server: string): void {
  if (open === server) return;
  if (open) unwatchPresence(groupTopic(open));
  open = server;
  attempt++;
  store.set(roomAtom, null);
  store.set(roomErrorAtom, '');
  store.set(roomGoneAtom, false);
  store.set(channelRenamedAtom, null);
  watchPresence(groupTopic(server));
  void loadRoom();
  void loadLines();
}

/** The room's and the lines' keys in the press's cache (prefetch.ts): the roster's first page is in the room's, so a window of another height asks for itself. */
const roomKey = (server: string, roster: number) => `group:${server}?roster=${roster}`;
const linesKey = (server: string, limit: number) => `group-lines:${server}?limit=${limit}`;

// a press on a way to `/groups/<server>`: the room and the last lines, the two things the page
// asks first, as it asks them (`loadRoom` with no roster on screen yet, `loadLines`). a group
// fact meanwhile drops the room; the lines are the chat's to reconcile (the socket is told the
// newest id it has, `seedChannels`), so they are kept. nothing for the room already open
onPrefetch('group', (server) => {
  if (open === server) return;
  const topic = groupTopic(server);
  const roster = pageFor(MEMBER_ROW_PX);
  const limit = pageFor(LINE_PX);
  prefetch(roomKey(server, roster), topic, 'drop', () => api.group(server, roster));
  prefetch(linesKey(server, limit), null, 'drop', () => api.groupMessages(server, limit));
});

/** The room page left: the feed off. The room is dropped; the next arrival asks again. */
export function leaveRoom(): void {
  if (!open) return;
  unwatchPresence(groupTopic(open));
  open = '';
  attempt++;
  store.set(roomAtom, null);
  store.set(roomErrorAtom, '');
  store.set(roomGoneAtom, false);
  store.set(channelRenamedAtom, null);
}

/** The room again, after this login's own join or leave: a member's room is not a stranger's, and the answer is theirs to see at once. */
export function reloadRoom(): Promise<void> {
  return open ? loadRoom() : Promise.resolve();
}

/**
 * This login mutes `channel`, or unmutes it (docs/notifications.md): no inbox row for its lines,
 * or rows again. The list says so at once; the api is told, and a refusal puts it back and
 * throws, for the page to say why. A mute is one login's and rides on no `group` fact: another
 * device of the login sees it on its next load of the room.
 */
export async function setChannelMuted(server: string, channel: string, muted: boolean): Promise<void> {
  const room = store.get(roomAtom);
  if (!room || room.name !== server) return;
  const was = room.muted ?? [];
  const now = muted ? (was.includes(channel) ? was : [...was, channel].sort()) : was.filter((c) => c !== channel);
  store.set(roomAtom, { ...room, muted: now });
  try {
    if (muted) await api.muteChannel(server, channel);
    else await api.unmuteChannel(server, channel);
  } catch (err) {
    const current = store.get(roomAtom);
    if (current && current.name === server) store.set(roomAtom, { ...current, muted: was });
    throw err;
  }
}

/** `room.pins` with `id` pinned in `channel` (first: the newest pin), or unpinned. A channel left with none drops out. */
function withPin(pins: Record<string, string[]> | undefined, channel: string, id: string, on: boolean): Record<string, string[]> {
  const was = pins?.[channel] ?? [];
  const now = on ? (was.includes(id) ? was : [id, ...was]) : was.filter((p) => p !== id);
  const out = { ...pins };
  if (now.length > 0) out[channel] = now;
  else delete out[channel];
  return out;
}

/** Bumped on every pin or unpin of the room on screen: an open pins panel asks its list again. */
export const pinsTickAtom = atom(0);

/**
 * The channels power pins a line of `channel`, or unpins it (docs/groups.md "pins"). The mark
 * and the count move at once; the api is told, and the fact it sends lands on every other room
 * open. A refusal (the cap among them) puts it back and throws, for the page to say why.
 */
export async function setPinned(server: string, channel: string, id: string, on: boolean): Promise<void> {
  const room = store.get(roomAtom);
  if (!room || room.name !== server) return;
  const was = room.pins;
  store.set(roomAtom, { ...room, pins: withPin(was, channel, id, on) });
  try {
    if (on) await api.pinLine(server, channel, id);
    else await api.unpinLine(server, channel, id);
    store.set(pinsTickAtom, store.get(pinsTickAtom) + 1);
  } catch (err) {
    const current = store.get(roomAtom);
    if (current && current.name === server) store.set(roomAtom, { ...current, pins: was });
    throw err;
  }
}

/**
 * The channels in `order`, from the top. One the order does not name (added since the order
 * was drawn up) keeps its place after the named ones, as the api puts it.
 */
function sortChannels(channels: Channel[], order: string[]): Channel[] {
  const at = new Map(order.map((name, i) => [name, i]));
  const named = channels.filter((c) => at.has(c.name)).sort((a, b) => (at.get(a.name) ?? 0) - (at.get(b.name) ?? 0));
  return [...named, ...channels.filter((c) => !at.has(c.name))];
}

/**
 * The channels power puts the channels in `order` (the manage dialog's channels tab): the list
 * moves at once, here and on the page under the dialog; the api is told, and the fact it sends
 * back lands on every other room open. A refusal puts the list back as it was and throws, for
 * the dialog to say why.
 */
export async function setChannelOrder(server: string, order: string[]): Promise<void> {
  const room = store.get(roomAtom);
  if (!room || room.name !== server) return;
  const was = room.channels ?? [];
  store.set(roomAtom, { ...room, channels: sortChannels(was, order) });
  try {
    await api.setChannelOrder(server, order);
  } catch (err) {
    const current = store.get(roomAtom);
    if (current && current.name === server)
      store.set(roomAtom, {
        ...current,
        channels: sortChannels(
          current.channels ?? [],
          was.map((c) => c.name)
        )
      });
    throw err;
  }
}

/**
 * The channel `from` is called `edit.name` and its line is `edit.about` (the channels tab's
 * pencil, the edit dialog of the channel list and the voice panel); either may be left out.
 * The api is asked first, since the name is checked at its door (taken, reserved) and the lines,
 * mutes and inbox rows move with it there; on its yes the room follows at once, as it would on
 * the facts, which then find nothing left to do. A refusal throws, for the dialog to say why.
 */
export async function editChannel(server: string, from: string, edit: { name?: string; about?: string }): Promise<void> {
  const done = await api.editChannel(server, from, edit);
  const room = store.get(roomAtom);
  if (!room || room.name !== server) return;
  applyRename(room, from, done.name);
  applyAbout(store.get(roomAtom) ?? room, done.name, done.about);
}

/** The channel's line about it is `about` now. */
function applyAbout(room: GroupRoom, channel: string, about: string): void {
  const channels = room.channels ?? [];
  if (!channels.some((c) => c.name === channel && c.about !== about)) return;
  store.set(roomAtom, { ...room, channels: channels.map((c) => (c.name === channel ? { ...c, about } : c)) });
}

/**
 * `from` is `to` now: in the list (its place kept), in the mutes, on the chat's shelf, and the
 * socket follows the new name for the lines to come. `channelRenamedAtom` tells the page, which
 * moves to the new address when `from` is the channel on screen. Nothing when `from` is gone
 * already (the api answered before the fact came).
 */
function applyRename(room: GroupRoom, from: string, to: string): void {
  const channels = room.channels ?? [];
  if (from === to || !channels.some((c) => c.name === from)) return;
  store.set(roomAtom, {
    ...room,
    channels: channels.filter((c) => c.name !== to).map((c) => (c.name === from ? { ...c, name: to } : c)),
    muted: room.muted?.map((c) => (c === from ? to : c)) ?? room.muted,
    // the pins follow the channel (the api's table moves them with it)
    pins: room.pins && from in room.pins ? Object.fromEntries(Object.entries(room.pins).map(([c, ids]) => [c === from ? to : c, ids])) : room.pins,
    // and who is in a voice one
    voice: room.voice && from in room.voice ? Object.fromEntries(Object.entries(room.voice).map(([c, people]) => [c === from ? to : c, people])) : room.voice
  });
  const chat = findServerChat(room.name);
  chat?.moveChannelLines(from, to);
  // a voice channel has no lines for the chat to follow; a call in it carries on under the new name
  if (!channels.some((c) => c.name === from && isVoice(c))) chat?.followChannel(to);
  const call = store.get(voiceCallAtom);
  if (call.server === room.name && call.channel === from) store.set(voiceCallAtom, { ...call, channel: to });
  store.set(channelRenamedAtom, { from, to });
}

/**
 * The room as the api has it. The one pull behind the push, for what the socket cannot carry
 * per viewer: among it, which channels this login sees (docs/groups.md: a channel kept to roles
 * is seen by their holders, the owners and the channels power). Asked again, the channels are
 * reconciled with the chat (`reconcileChannels`).
 */
async function loadRoom(): Promise<void> {
  const server = open;
  const mine = attempt;
  // the roster's first page; asked again, as much of it as was on screen, so a long scroll down it does not jump back to the top
  const had = store.get(roomAtom);
  const shown = had?.name === server ? (had.roster?.length ?? 0) : 0;
  try {
    const roster = Math.min(MAX_PAGE, Math.max(pageFor(MEMBER_ROW_PX), shown));
    // the one asked for on the press, when there was one and no fact has come about the group since
    const room = await (takePrefetched<GroupRoom>(roomKey(server, roster))?.answer ?? api.group(server, roster));
    if (mine !== attempt) return;
    const before = store.get(roomAtom);
    rosterAsk++;
    store.set(rosterMoreAtom, 'idle');
    store.set(roomAtom, room);
    store.set(roomErrorAtom, '');
    if (before && before.name === server) reconcileChannels(server, before.channels ?? [], room.channels ?? []);
  } catch (err) {
    if (mine !== attempt) return;
    store.set(roomErrorAtom, statusOf(err) === 404 ? 'no such group' : messageOf(err));
  }
}

/** The last lines again (`loadLines`): for a page that took its chat down and put it back, with the shelf gone with it. */
export function reloadLines(): void {
  if (open) void loadLines();
}

/**
 * The channels this login sees, as the room had them and as it has them now (a role given or
 * taken, a channel kept to a role or let go of): one that appeared is followed on the chat
 * socket and the lines are asked for, so it has its last lines like the others; one that went
 * takes its lines off the shelf, and the socket is opened again, since the chat joins what the
 * login sees as the socket opens and keeps carrying a channel until then.
 */
function reconcileChannels(server: string, was: Channel[], now: Channel[]): void {
  const had = new Set(was.map((c) => c.name));
  const has = new Set(now.map((c) => c.name));
  const came = now.filter((c) => !had.has(c.name));
  const went = was.filter((c) => !has.has(c.name));
  // this server's socket alone: a stream's room in the corner is no business of the group's
  const chat = findServerChat(server);
  for (const c of went) chat?.dropChannel(c.name);
  if (went.length > 0) chat?.reconnect();
  else for (const c of came) if (!isVoice(c)) chat?.followChannel(c.name);
  if (came.length > 0) void loadLines();
}

/** Two lists of channel names as sets. */
function sameNames(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((name) => b.includes(name));
}

/** The last lines of every channel, onto the chat's shelf. A failure is not the room's: the socket still brings new lines. */
async function loadLines(): Promise<void> {
  const server = open;
  const mine = attempt;
  try {
    // enough of each channel to fill the chat twice; the rest scrolls in from the top (chat-atoms `loadOlder`)
    const limit = pageFor(LINE_PX);
    const lines = await (takePrefetched<Record<string, ChatLine[]>>(linesKey(server, limit))?.answer ?? api.groupMessages(server, limit));
    if (mine !== attempt) return;
    serverChat(server).seedChannels(lines);
  } catch {
    if (mine !== attempt) return;
    // nothing to say here: older lines still scroll in from the history routes. seeded with nothing, so the panel stops standing grey lines for an answer that is not coming
    serverChat(server).seedChannels({});
  }
}

/** Owners first, then the group's order: `name`, `newest` or `oldest` by when they joined. */
function memberOrder(order: string | undefined): (a: GroupMember, b: GroupMember) => number {
  const by = order === 'newest' || order === 'oldest' ? order : 'name';
  return (a, b) => {
    if (a.owner !== b.owner) return a.owner ? -1 : 1;
    if (by === 'newest') return (b.joined ?? 0) - (a.joined ?? 0) || a.name.localeCompare(b.name);
    if (by === 'oldest') return (a.joined ?? 0) - (b.joined ?? 0) || a.name.localeCompare(b.name);
    return a.name.localeCompare(b.name);
  };
}

function sortMembers(list: GroupMember[], order: string | undefined): GroupMember[] {
  return [...list].sort(memberOrder(order));
}

/** Which roster page is the current one to ask for: a room asked again starts the pages over, and an answer to the old ones is dropped. */
let rosterAsk = 0;

/**
 * The roster's next page (`GET .../members?after=`), onto the end of what the room has: asked
 * when the end of the list scrolls near (ServerRoom.tsx `MoreRow`), `height` the box it
 * scrolls in. Nothing when the roster is whole or a page is on its way. One that a fact put
 * there already is not drawn twice.
 */
export async function loadMoreMembers(height?: number): Promise<void> {
  const room = store.get(roomAtom);
  if (!room?.roster || !room.roster_next || store.get(rosterMoreAtom) === 'busy') return;
  const server = room.name;
  const mine = attempt;
  const ask = rosterAsk;
  store.set(rosterMoreAtom, 'busy');
  try {
    const page = await api.groupMembersPage(server, { limit: pageFor(MEMBER_ROW_PX, height), after: room.roster_next });
    const now = store.get(roomAtom);
    if (mine !== attempt || ask !== rosterAsk || !now?.roster || now.name !== server) return;
    const have = new Set(now.roster.map((m) => m.name));
    const roster = sortMembers([...now.roster, ...page.members.filter((m) => !have.has(m.name))], now.member_order);
    store.set(roomAtom, { ...now, roster, roster_next: page.next });
    store.set(rosterMoreAtom, 'idle');
  } catch {
    if (mine === attempt && ask === rosterAsk) store.set(rosterMoreAtom, 'failed');
  }
}

/** The roster's first page again, in the group's order as it is now: the pages so far were cut in the old one. */
async function reloadRoster(): Promise<void> {
  const room = store.get(roomAtom);
  if (!room?.roster) return;
  const server = room.name;
  const mine = attempt;
  const ask = ++rosterAsk;
  store.set(rosterMoreAtom, 'idle');
  try {
    const page = await api.groupMembersPage(server, { limit: pageFor(MEMBER_ROW_PX) });
    const now = store.get(roomAtom);
    if (mine !== attempt || ask !== rosterAsk || !now || now.name !== server) return;
    store.set(roomAtom, { ...now, roster: page.members, roster_next: page.next });
  } catch {
    // the room keeps the old pages, sorted the new way; the next fact or reload puts it right
  }
}

/**
 * Whether `member` belongs among the rows loaded so far: always when the roster is whole; on a
 * page of it, only when they sort before the last row loaded, since after it is the next
 * page's, which will bring them.
 */
function withinLoaded(room: GroupRoom, roster: GroupMember[], member: GroupMember): boolean {
  if (!room.roster_next) return true;
  const last = roster[roster.length - 1];
  return !last || memberOrder(room.member_order)(member, last) < 0;
}

/** Whether `me` holds role `id`, from the roster. Not on the pages loaded so far: maybe, and the caller asks the room. */
function iHold(room: GroupRoom, me: string | null, id: string): boolean {
  if (!me || !room.mine) return false;
  const row = room.roster?.find((m) => m.name === me);
  return row ? row.roles.some((r) => r.id === id) : !!room.roster_next;
}

/** `voice` without the people `out` picks; a channel left empty goes. */
function withoutVoice(voice: Record<string, VoiceMember[]>, out: (p: VoiceMember, channel: string) => boolean): Record<string, VoiceMember[]> {
  const next: Record<string, VoiceMember[]> = {};
  for (const [channel, people] of Object.entries(voice)) {
    const left = people.filter((p) => !out(p, channel));
    if (left.length > 0) next[channel] = left;
  }
  return next;
}

/**
 * One change onto the room. A change about me is asked of the api instead: the roster, the
 * bans and my powers are mine to see or not, and the frame says the same thing to everyone.
 */
function apply(change: GroupChange): void {
  const room = store.get(roomAtom);
  if (!room) return;
  const me = store.get(meAtom) ?? null;
  const about = (who: string) => me !== null && who === me;
  switch (change.what) {
    case 'joined': {
      if (about(change.who)) return void loadRoom();
      const roster = room.roster ? room.roster.filter((m) => m.name !== change.who) : null;
      const came: GroupMember = { name: change.who, owner: false, avatar: change.avatar, joined: change.joined, roles: [] };
      // on a page of the roster, one who sorts past its end comes with a later page
      if (roster && withinLoaded(room, roster, came)) roster.push(came);
      store.set(roomAtom, { ...room, members: change.members, roster: roster ? sortMembers(roster, room.member_order) : room.roster });
      return;
    }
    case 'left':
    case 'banned': {
      if (about(change.who)) return void loadRoom();
      const roster = room.roster ? room.roster.filter((m) => m.name !== change.who) : room.roster;
      let bans = room.bans;
      if (change.what === 'banned' && bans) bans = [{ name: change.who, reason: change.reason }, ...bans.filter((b) => b.name !== change.who)];
      store.set(roomAtom, { ...room, members: change.members, roster, bans });
      return;
    }
    case 'unbanned':
      if (room.bans) store.set(roomAtom, { ...room, bans: room.bans.filter((b) => b.name !== change.who) });
      return;
    case 'channel': {
      const channels = room.channels ?? [];
      if (channels.some((c) => c.name === change.channel.name)) return;
      const mine = about(change.channel.made_by ?? '');
      const can_edit = mine || room.perms.channels;
      store.set(roomAtom, { ...room, channels: [...channels, { ...change.channel, can_delete: !change.channel.home && can_edit, can_edit }] });
      if (!isVoice(change.channel)) findServerChat(room.name)?.followChannel(change.channel.name);
      return;
    }
    case 'unchannel':
      // the mute went with the channel (the api's table says so): a channel made again under the name starts unmuted
      store.set(roomAtom, {
        ...room,
        channels: (room.channels ?? []).filter((c) => c.name !== change.channel),
        muted: room.muted?.filter((c) => c !== change.channel) ?? room.muted,
        // its pins went with it too
        pins: room.pins ? Object.fromEntries(Object.entries(room.pins).filter(([c]) => c !== change.channel)) : room.pins,
        voice: room.voice ? withoutVoice(room.voice, (_, c) => c === change.channel) : room.voice
      });
      findServerChat(room.name)?.dropChannel(change.channel);
      return;
    case 'pin':
    case 'unpin':
      // a channel this login does not see has no list here to keep
      if (!(room.channels ?? []).some((c) => c.name === change.channel)) return;
      store.set(roomAtom, { ...room, pins: withPin(room.pins, change.channel, change.id, change.what === 'pin') });
      store.set(pinsTickAtom, store.get(pinsTickAtom) + 1);
      return;
    case 'channel_renamed':
      applyRename(room, change.channel, change.name);
      return;
    case 'channel_about':
      applyAbout(room, change.channel, change.about);
      return;
    case 'channel_cooldown':
      store.set(roomAtom, { ...room, channels: (room.channels ?? []).map((c) => (c.name === change.channel ? { ...c, cooldown: change.cooldown } : c)) });
      return;
    case 'channel_order':
      store.set(roomAtom, { ...room, channels: sortChannels(room.channels ?? [], change.order) });
      return;
    case 'about':
      store.set(roomAtom, { ...room, about: change.about });
      return;
    case 'color':
      // the lists the page holds follow the room (groups-atoms.ts)
      store.set(roomAtom, { ...room, color: change.color });
      return;
    case 'access':
      store.set(roomAtom, { ...room, public: change.public });
      return;
    case 'order':
      store.set(roomAtom, { ...room, member_order: change.order, roster: room.roster ? sortMembers(room.roster, change.order) : room.roster });
      // pages of it were cut in the old order: the first one of the new
      if (room.roster_next) void reloadRoster();
      return;
    case 'icon':
      store.set(roomAtom, { ...room, icon: change.icon });
      return;
    case 'banner':
      store.set(roomAtom, { ...room, banner: change.banner });
      return;
    case 'role': {
      // made or changed: the list, and the name and colour on everyone who holds it
      const was = room.roles.find((r) => r.id === change.role.id);
      const roles = was ? room.roles.map((r) => (r.id === change.role.id ? change.role : r)) : [...room.roles, change.role];
      const roster =
        room.roster?.map((m) => ({ ...m, roles: m.roles.map((r) => (r.id === change.role.id ? { id: r.id, name: change.role.name, color: change.role.color } : r)) })) ??
        room.roster;
      const held = iHold(room, me, change.role.id);
      // the channels kept to it changed (or it came with some): which channels anyone sees may have too
      const kept = was ? !sameNames(was.channels ?? [], change.role.channels ?? []) : (change.role.channels?.length ?? 0) > 0;
      store.set(roomAtom, { ...room, roles, roster });
      // its powers changed, and I hold it: what I may do did too
      if (held || kept) void loadRoom();
      return;
    }
    case 'unrole': {
      const was = room.roles.find((r) => r.id === change.id);
      const held = iHold(room, me, change.id);
      store.set(roomAtom, {
        ...room,
        roles: room.roles.filter((r) => r.id !== change.id),
        roster: room.roster?.map((m) => ({ ...m, roles: m.roles.filter((r) => r.id !== change.id) })) ?? room.roster
      });
      // a role that kept channels is gone: they are everyone's now, or still another role's
      if (held || (was?.channels?.length ?? 0) > 0) void loadRoom();
      return;
    }
    case 'held':
      if (about(change.who)) return void loadRoom();
      store.set(roomAtom, {
        ...room,
        roster:
          room.roster?.map((m) => (m.name === change.who && !m.roles.some((r) => r.id === change.role.id) ? { ...m, roles: [...m.roles, change.role] } : m)) ??
          room.roster
      });
      return;
    case 'unheld':
      if (about(change.who)) return void loadRoom();
      store.set(roomAtom, {
        ...room,
        roster: room.roster?.map((m) => (m.name === change.who ? { ...m, roles: m.roles.filter((r) => r.id !== change.id) } : m)) ?? room.roster
      });
      return;
    case 'owner': {
      if (about(change.who)) return void loadRoom();
      if (!room.roster) return;
      const row = room.roster.find((m) => m.name === change.who);
      const others = room.roster.filter((m) => m.name !== change.who);
      const moved = row ? { ...row, owner: change.owner } : null;
      // on a page of the roster, a row that now sorts past its end comes with a later page
      const roster = moved && withinLoaded(room, others, moved) ? [...others, moved] : others;
      store.set(roomAtom, { ...room, roster: sortMembers(roster, room.member_order) });
      // an owner made from past the pages loaded so far: the owners lead the first page, so it is asked again
      if (!row && change.owner && room.roster_next) void reloadRoster();
      return;
    }
    case 'owner_role':
      store.set(roomAtom, { ...room, owner_role: change.name });
      return;
    case 'timeout':
      // the roster's mark; the chat itself refuses a timed-out login's lines, whatever the page knows
      store.set(roomAtom, { ...room, roster: room.roster?.map((m) => (m.name === change.who ? { ...m, timeout: change.until } : m)) ?? room.roster });
      return;
    case 'live': {
      const live = room.live ?? [];
      if (!live.includes(change.who)) store.set(roomAtom, { ...room, live: [...live, change.who] });
      return;
    }
    case 'ended':
      if (room.live?.includes(change.who)) store.set(roomAtom, { ...room, live: room.live.filter((n) => n !== change.who) });
      return;
    case 'voice': {
      // one channel at a time: a move is a voice in the new one, so they leave any other
      const voice = withoutVoice(room.voice ?? {}, (p) => p.uid === change.uid);
      const came: VoiceMember = { name: change.who, uid: change.uid, since: Date.now(), muted: change.muted };
      const kept = (room.voice?.[change.channel] ?? []).find((p) => p.uid === change.uid);
      // a channel this login does not see keeps its people out of this room, as the api's room does
      if ((room.channels ?? []).some((c) => c.name === change.channel)) voice[change.channel] = [...(voice[change.channel] ?? []), kept ?? came];
      store.set(roomAtom, { ...room, voice });
      return;
    }
    case 'voice_left':
      if (room.voice) store.set(roomAtom, { ...room, voice: withoutVoice(room.voice, (p) => p.uid === change.uid) });
      return;
    case 'voice_mute': {
      // the seat's mark; the voice server itself carries nothing of a muted mic, whatever the page knows
      if (!room.voice) return;
      const voice: Record<string, VoiceMember[]> = {};
      for (const [channel, people] of Object.entries(room.voice)) voice[channel] = people.map((p) => (p.uid === change.uid ? { ...p, muted: change.muted } : p));
      store.set(roomAtom, { ...room, voice });
      return;
    }
    case 'deleted':
      store.set(roomGoneAtom, true);
      return;
    default:
      return;
  }
}

/**
 * The roster's names, held on the events socket while they are on the room: each member's
 * word, for the square on their face (`presenceOfAtom`). The group's topic brings `live` and
 * `ended` for them and nothing of `online` or `do not disturb`; a name watched brings its word
 * at once and then as it changes. Reconciled on every change of the room, so a join is held
 * and a leave let go, and leaving the page (the room goes null) lets go of them all.
 */
let heldMembers = new Set<string>();
store.sub(roomAtom, () => {
  const names = new Set((store.get(roomAtom)?.roster ?? []).map((member) => member.name));
  for (const name of heldMembers) if (!names.has(name)) releasePresence(name);
  for (const name of names) if (!heldMembers.has(name)) holdPresence(name);
  heldMembers = names;
});

/** Who is in voice in the room, name to user id, for voice-atoms: the call's seats say names, and your level for each person is kept by id. Set only when it changes. */
store.sub(roomAtom, () => {
  const people = Object.values(store.get(roomAtom)?.voice ?? {}).flat();
  const was = store.get(voiceUidsAtom);
  if (people.length === was.size && people.every((p) => was.get(p.name) === p.uid)) return;
  store.set(voiceUidsAtom, new Map(people.map((p) => [p.name, p.uid])));
});

// the feed, while a room is up: its group's changes onto the room; the socket opening under
// the page, back after a gap, is the room again, since the facts of the gap never reached it
onEvents((event) => {
  if (!open) return;
  if (event.type === 'group') {
    if (event.group === open) apply(event);
  } else if (event.type === 'link' && event.phase === 'open') {
    if (store.get(roomAtom)) void loadRoom();
  }
});
