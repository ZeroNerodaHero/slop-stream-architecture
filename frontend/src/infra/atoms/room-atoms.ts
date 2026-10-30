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

import { api, type GroupMember, type GroupRoom, messageOf, statusOf } from '@/infra/api';
import { meAtom } from '@/infra/atoms/auth-atoms';
import { dropChannel, followChannel, seedChannels } from '@/infra/atoms/chat-atoms';
import { onEvents, unwatchPresence, watchPresence } from '@/infra/events';
import { type GroupChange, groupTopic } from '@/infra/frames';
import { store } from '@/infra/store';

/** The room on screen, as loaded and then patched. `null` before the first answer, and off the page. */
export const roomAtom = atom<GroupRoom | null>(null);
/** Why there is no room: `no such group`, or what the api said. '' while there is one, or none has been asked yet. */
export const roomErrorAtom = atom('');
/** The group was deleted while its room was on screen. */
export const roomGoneAtom = atom(false);

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
  watchPresence(groupTopic(server));
  void loadRoom();
  void loadLines();
}

/** The room page left: the feed off. The room is dropped; the next arrival asks again. */
export function leaveRoom(): void {
  if (!open) return;
  unwatchPresence(groupTopic(open));
  open = '';
  attempt++;
  store.set(roomAtom, null);
  store.set(roomErrorAtom, '');
  store.set(roomGoneAtom, false);
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

/** The room as the api has it. The one pull behind the push, for what the socket cannot carry per viewer. */
async function loadRoom(): Promise<void> {
  const server = open;
  const mine = attempt;
  try {
    const room = await api.group(server);
    if (mine !== attempt) return;
    store.set(roomAtom, room);
    store.set(roomErrorAtom, '');
  } catch (err) {
    if (mine !== attempt) return;
    store.set(roomErrorAtom, statusOf(err) === 404 ? 'no such group' : messageOf(err));
  }
}

/** The last lines of every channel, onto the chat's shelf. A failure is not the room's: the socket still brings new lines. */
async function loadLines(): Promise<void> {
  const server = open;
  const mine = attempt;
  try {
    const lines = await api.groupMessages(server);
    if (mine !== attempt) return;
    seedChannels(server, lines);
  } catch {
    // older lines still scroll in from the history routes; nothing to say here
  }
}

/** Owners first, then the group's order: `name`, `newest` or `oldest` by when they joined. */
function sortMembers(list: GroupMember[], order: string | undefined): GroupMember[] {
  const by = order === 'newest' || order === 'oldest' ? order : 'name';
  return [...list].sort((a, b) => {
    if (a.owner !== b.owner) return a.owner ? -1 : 1;
    if (by === 'newest') return (b.joined ?? 0) - (a.joined ?? 0) || a.name.localeCompare(b.name);
    if (by === 'oldest') return (a.joined ?? 0) - (b.joined ?? 0) || a.name.localeCompare(b.name);
    return a.name.localeCompare(b.name);
  });
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
      if (roster) roster.push({ name: change.who, owner: false, avatar: change.avatar, joined: change.joined, roles: [] });
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
      const can_delete = change.channel.name !== 'general' && (mine || room.perms.channels);
      store.set(roomAtom, { ...room, channels: [...channels, { ...change.channel, can_delete }] });
      followChannel(change.channel.name);
      return;
    }
    case 'unchannel':
      // the mute went with the channel (the api's table says so): a channel made again under the name starts unmuted
      store.set(roomAtom, {
        ...room,
        channels: (room.channels ?? []).filter((c) => c.name !== change.channel),
        muted: room.muted?.filter((c) => c !== change.channel) ?? room.muted
      });
      dropChannel(change.channel);
      return;
    case 'about':
      store.set(roomAtom, { ...room, about: change.about });
      return;
    case 'access':
      store.set(roomAtom, { ...room, public: change.public });
      return;
    case 'order':
      store.set(roomAtom, { ...room, member_order: change.order, roster: room.roster ? sortMembers(room.roster, change.order) : room.roster });
      return;
    case 'icon':
      store.set(roomAtom, { ...room, icon: change.icon });
      return;
    case 'banner':
      store.set(roomAtom, { ...room, banner: change.banner });
      return;
    case 'role': {
      // made or changed: the list, and the name and colour on everyone who holds it
      const roles = room.roles.some((r) => r.id === change.role.id) ? room.roles.map((r) => (r.id === change.role.id ? change.role : r)) : [...room.roles, change.role];
      const roster =
        room.roster?.map((m) => ({ ...m, roles: m.roles.map((r) => (r.id === change.role.id ? { id: r.id, name: change.role.name, color: change.role.color } : r)) })) ??
        room.roster;
      const held = room.roster?.find((m) => m.name === me)?.roles.some((r) => r.id === change.role.id) ?? false;
      store.set(roomAtom, { ...room, roles, roster });
      // its powers changed, and I hold it: what I may do did too
      if (held) void loadRoom();
      return;
    }
    case 'unrole': {
      const held = room.roster?.find((m) => m.name === me)?.roles.some((r) => r.id === change.id) ?? false;
      store.set(roomAtom, {
        ...room,
        roles: room.roles.filter((r) => r.id !== change.id),
        roster: room.roster?.map((m) => ({ ...m, roles: m.roles.filter((r) => r.id !== change.id) })) ?? room.roster
      });
      if (held) void loadRoom();
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
      const roster = room.roster?.map((m) => (m.name === change.who ? { ...m, owner: change.owner } : m));
      store.set(roomAtom, { ...room, roster: roster ? sortMembers(roster, room.member_order) : room.roster });
      return;
    }
    case 'live': {
      const live = room.live ?? [];
      if (!live.includes(change.who)) store.set(roomAtom, { ...room, live: [...live, change.who] });
      return;
    }
    case 'ended':
      if (room.live?.includes(change.who)) store.set(roomAtom, { ...room, live: room.live.filter((n) => n !== change.who) });
      return;
    case 'deleted':
      store.set(roomGoneAtom, true);
      return;
    default:
      return;
  }
}

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
