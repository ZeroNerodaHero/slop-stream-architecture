import { atom } from 'jotai';

import { api, type Channel, type GroupMember, type GroupRoom, isVoice, messageOf, statusOf, type VoiceMember } from '@/infra/api';
import { meAtom } from '@/infra/atoms/auth-atoms';
import { paletteAtom } from '@/infra/atoms/settings-atoms';
import { type ChatLine, findServerChat, serverChat } from '@/infra/atoms/chat-atoms';
import { voiceCallAtom, voiceUidsAtom } from '@/infra/atoms/voice-state';
import { holdPresence, onEvents, releasePresence, unwatchPresence, watchPresence } from '@/infra/events';
import { type GroupChange, groupTopic } from '@/infra/frames';
import { onPrefetch, prefetch, takePrefetched } from '@/infra/prefetch';
import { store } from '@/infra/store';
import { ensureContrast, fromHex, hex, isHex } from '@/infra/theme';

export const roomAtom = atom<GroupRoom | null>(null);
export const roomErrorAtom = atom('');
export const roomGoneAtom = atom(false);
export const channelRenamedAtom = atom<{ from: string; to: string } | null>(null);

export const roleColorsAtom = atom((get) => {
  const room = get(roomAtom);
  const colors = new Map<string, string>();
  if (!room) return { server: null, colors };
  const page = get(paletteAtom).backgroundTertiary;
  for (const role of room.roles) {
    if (!isHex(role.color)) continue;
    const names = room.holders ? (room.holders[role.id] ?? []) : (room.roster ?? []).filter((m) => m.roles.some((r) => r.id === role.id)).map((m) => m.name);
    const fresh = names.filter((name) => !colors.has(name));
    if (!fresh.length) continue;
    const color = hex(ensureContrast(fromHex(role.color), page, 4.5));
    for (const name of fresh) colors.set(name, color);
  }
  return { server: room.name, colors };
});

export const rosterMoreAtom = atom<'idle' | 'busy' | 'failed'>('idle');

export const MEMBER_ROW_PX = 30;
const LINE_PX = 22;
const MIN_PAGE = 20;
const MAX_PAGE = 100;

export function pageFor(rowPx: number, height: number = window.innerHeight): number {
  return Math.min(MAX_PAGE, Math.max(MIN_PAGE, Math.ceil((2 * height) / rowPx)));
}

let open = '';
let attempt = 0;

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

const roomKey = (server: string, roster: number) => `group:${server}?roster=${roster}`;
const linesKey = (server: string, limit: number) => `group-lines:${server}?limit=${limit}`;

onPrefetch('group', (server) => {
  if (open === server) return;
  const topic = groupTopic(server);
  const roster = pageFor(MEMBER_ROW_PX);
  const limit = pageFor(LINE_PX);
  prefetch(roomKey(server, roster), topic, 'drop', () => api.group(server, roster));
  prefetch(linesKey(server, limit), null, 'drop', () => api.groupMessages(server, limit));
});

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

export function reloadRoom(): Promise<void> {
  return open ? loadRoom() : Promise.resolve();
}

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

function withPin(pins: Record<string, string[]> | undefined, channel: string, id: string, on: boolean): Record<string, string[]> {
  const was = pins?.[channel] ?? [];
  const now = on ? (was.includes(id) ? was : [id, ...was]) : was.filter((p) => p !== id);
  const out = { ...pins };
  if (now.length > 0) out[channel] = now;
  else delete out[channel];
  return out;
}

export const pinsTickAtom = atom(0);

export const timeoutsTickAtom = atom(0);

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

function sortChannels(channels: Channel[], order: string[]): Channel[] {
  const at = new Map(order.map((name, i) => [name, i]));
  const named = channels.filter((c) => at.has(c.name)).sort((a, b) => (at.get(a.name) ?? 0) - (at.get(b.name) ?? 0));
  return [...named, ...channels.filter((c) => !at.has(c.name))];
}

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

export async function editChannel(server: string, from: string, edit: { name?: string; about?: string }): Promise<void> {
  const done = await api.editChannel(server, from, edit);
  const room = store.get(roomAtom);
  if (!room || room.name !== server) return;
  applyRename(room, from, done.name);
  applyAbout(store.get(roomAtom) ?? room, done.name, done.about);
}

function applyAbout(room: GroupRoom, channel: string, about: string): void {
  const channels = room.channels ?? [];
  if (!channels.some((c) => c.name === channel && c.about !== about)) return;
  store.set(roomAtom, { ...room, channels: channels.map((c) => (c.name === channel ? { ...c, about } : c)) });
}

function applyRename(room: GroupRoom, from: string, to: string): void {
  const channels = room.channels ?? [];
  if (from === to || !channels.some((c) => c.name === from)) return;
  store.set(roomAtom, {
    ...room,
    channels: channels.filter((c) => c.name !== to).map((c) => (c.name === from ? { ...c, name: to } : c)),
    muted: room.muted?.map((c) => (c === from ? to : c)) ?? room.muted,
    pins: room.pins && from in room.pins ? Object.fromEntries(Object.entries(room.pins).map(([c, ids]) => [c === from ? to : c, ids])) : room.pins,
    voice: room.voice && from in room.voice ? Object.fromEntries(Object.entries(room.voice).map(([c, people]) => [c === from ? to : c, people])) : room.voice
  });
  const chat = findServerChat(room.name);
  chat?.moveChannelLines(from, to);
  if (!channels.some((c) => c.name === from && isVoice(c))) chat?.followChannel(to);
  const call = store.get(voiceCallAtom);
  if (call.server === room.name && call.channel === from) store.set(voiceCallAtom, { ...call, channel: to });
  store.set(channelRenamedAtom, { from, to });
}

async function loadRoom(): Promise<void> {
  const server = open;
  const mine = attempt;
  const had = store.get(roomAtom);
  const shown = had?.name === server ? (had.roster?.length ?? 0) : 0;
  try {
    const roster = Math.min(MAX_PAGE, Math.max(pageFor(MEMBER_ROW_PX), shown));
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

export function reloadLines(): void {
  if (open) void loadLines();
}

function reconcileChannels(server: string, was: Channel[], now: Channel[]): void {
  const had = new Set(was.map((c) => c.name));
  const has = new Set(now.map((c) => c.name));
  const came = now.filter((c) => !had.has(c.name));
  const went = was.filter((c) => !has.has(c.name));
  const chat = findServerChat(server);
  for (const c of went) chat?.dropChannel(c.name);
  if (went.length > 0) chat?.reconnect();
  else for (const c of came) if (!isVoice(c)) chat?.followChannel(c.name);
  if (came.length > 0) void loadLines();
}

function sameNames(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((name) => b.includes(name));
}

async function loadLines(): Promise<void> {
  const server = open;
  const mine = attempt;
  try {
    const limit = pageFor(LINE_PX);
    const lines = await (takePrefetched<Record<string, ChatLine[]>>(linesKey(server, limit))?.answer ?? api.groupMessages(server, limit));
    if (mine !== attempt) return;
    serverChat(server).seedChannels(lines);
  } catch {
    if (mine !== attempt) return;
    serverChat(server).seedChannels({});
  }
}

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

let rosterAsk = 0;

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
  }
}

function withinLoaded(room: GroupRoom, roster: GroupMember[], member: GroupMember): boolean {
  if (!room.roster_next) return true;
  const last = roster[roster.length - 1];
  return !last || memberOrder(room.member_order)(member, last) < 0;
}

function iHold(room: GroupRoom, me: string | null, id: string): boolean {
  if (!me || !room.mine) return false;
  const row = room.roster?.find((m) => m.name === me);
  return row ? row.roles.some((r) => r.id === id) : !!room.roster_next;
}

function withoutVoice(voice: Record<string, VoiceMember[]>, out: (p: VoiceMember, channel: string) => boolean): Record<string, VoiceMember[]> {
  const next: Record<string, VoiceMember[]> = {};
  for (const [channel, people] of Object.entries(voice)) {
    const left = people.filter((p) => !out(p, channel));
    if (left.length > 0) next[channel] = left;
  }
  return next;
}

function withHolder(holders: GroupRoom['holders'], who: string, keeps: (id: string) => boolean, add?: string): GroupRoom['holders'] {
  if (!holders) return holders;
  const next: Record<string, string[]> = {};
  for (const [id, names] of Object.entries(holders)) {
    const kept = names.filter((name) => name !== who || keeps(id));
    if (kept.length) next[id] = kept;
  }
  if (add !== undefined && !next[add]?.includes(who)) next[add] = [...(next[add] ?? []), who];
  return next;
}

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
      store.set(roomAtom, { ...room, members: change.members, roster, bans, holders: withHolder(room.holders, change.who, () => false) });
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
      store.set(roomAtom, {
        ...room,
        channels: (room.channels ?? []).filter((c) => c.name !== change.channel),
        muted: room.muted?.filter((c) => c !== change.channel) ?? room.muted,
        pins: room.pins ? Object.fromEntries(Object.entries(room.pins).filter(([c]) => c !== change.channel)) : room.pins,
        voice: room.voice ? withoutVoice(room.voice, (_, c) => c === change.channel) : room.voice
      });
      findServerChat(room.name)?.dropChannel(change.channel);
      return;
    case 'pin':
    case 'unpin':
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
      store.set(roomAtom, { ...room, color: change.color });
      return;
    case 'access':
      store.set(roomAtom, { ...room, public: change.public });
      return;
    case 'adult':
      store.set(roomAtom, { ...room, adult: change.adult, adult_locked: change.locked ?? room.adult_locked });
      return;
    case 'order':
      store.set(roomAtom, { ...room, member_order: change.order, roster: room.roster ? sortMembers(room.roster, change.order) : room.roster });
      if (room.roster_next) void reloadRoster();
      return;
    case 'icon':
      store.set(roomAtom, { ...room, icon: change.icon });
      return;
    case 'banner':
      store.set(roomAtom, { ...room, banner: change.banner });
      return;
    case 'role': {
      const was = room.roles.find((r) => r.id === change.role.id);
      const roles = was ? room.roles.map((r) => (r.id === change.role.id ? change.role : r)) : [...room.roles, change.role];
      const roster =
        room.roster?.map((m) => ({ ...m, roles: m.roles.map((r) => (r.id === change.role.id ? { id: r.id, name: change.role.name, color: change.role.color } : r)) })) ??
        room.roster;
      const held = iHold(room, me, change.role.id);
      const kept = was ? !sameNames(was.channels ?? [], change.role.channels ?? []) : (change.role.channels?.length ?? 0) > 0;
      store.set(roomAtom, { ...room, roles, roster });
      if (held || kept) void loadRoom();
      return;
    }
    case 'unrole': {
      const was = room.roles.find((r) => r.id === change.id);
      const held = iHold(room, me, change.id);
      store.set(roomAtom, {
        ...room,
        roles: room.roles.filter((r) => r.id !== change.id),
        roster: room.roster?.map((m) => ({ ...m, roles: m.roles.filter((r) => r.id !== change.id) })) ?? room.roster,
        holders: room.holders ? Object.fromEntries(Object.entries(room.holders).filter(([id]) => id !== change.id)) : room.holders
      });
      if (held || (was?.channels?.length ?? 0) > 0) void loadRoom();
      return;
    }
    case 'held':
      if (about(change.who)) return void loadRoom();
      store.set(roomAtom, {
        ...room,
        roster:
          room.roster?.map((m) => (m.name === change.who && !m.roles.some((r) => r.id === change.role.id) ? { ...m, roles: [...m.roles, change.role] } : m)) ??
          room.roster,
        holders: withHolder(room.holders, change.who, (id) => id === change.role.id, change.role.id)
      });
      return;
    case 'unheld':
      if (about(change.who)) return void loadRoom();
      store.set(roomAtom, {
        ...room,
        roster: room.roster?.map((m) => (m.name === change.who ? { ...m, roles: m.roles.filter((r) => r.id !== change.id) } : m)) ?? room.roster,
        holders: withHolder(room.holders, change.who, (id) => id !== change.id)
      });
      return;
    case 'owner': {
      if (about(change.who)) return void loadRoom();
      if (!room.roster) return;
      const row = room.roster.find((m) => m.name === change.who);
      const others = room.roster.filter((m) => m.name !== change.who);
      const moved = row ? { ...row, owner: change.owner } : null;
      const roster = moved && withinLoaded(room, others, moved) ? [...others, moved] : others;
      store.set(roomAtom, { ...room, roster: sortMembers(roster, room.member_order) });
      if (!row && change.owner && room.roster_next) void reloadRoster();
      return;
    }
    case 'owner_role':
      store.set(roomAtom, { ...room, owner_role: change.name });
      return;
    case 'timeout':
      store.set(roomAtom, { ...room, roster: room.roster?.map((m) => (m.name === change.who ? { ...m, timeout: change.until } : m)) ?? room.roster });
      store.set(timeoutsTickAtom, store.get(timeoutsTickAtom) + 1);
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
      const voice = withoutVoice(room.voice ?? {}, (p) => p.uid === change.uid);
      const came: VoiceMember = { name: change.who, uid: change.uid, since: Date.now(), muted: change.muted };
      const kept = (room.voice?.[change.channel] ?? []).find((p) => p.uid === change.uid);
      if ((room.channels ?? []).some((c) => c.name === change.channel)) voice[change.channel] = [...(voice[change.channel] ?? []), kept ?? came];
      store.set(roomAtom, { ...room, voice });
      return;
    }
    case 'voice_left':
      if (room.voice) store.set(roomAtom, { ...room, voice: withoutVoice(room.voice, (p) => p.uid === change.uid) });
      return;
    case 'voice_mute': {
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

let heldMembers = new Set<string>();
store.sub(roomAtom, () => {
  const names = new Set((store.get(roomAtom)?.roster ?? []).map((member) => member.name));
  for (const name of heldMembers) if (!names.has(name)) releasePresence(name);
  for (const name of names) if (!heldMembers.has(name)) holdPresence(name);
  heldMembers = names;
});

store.sub(roomAtom, () => {
  const people = Object.values(store.get(roomAtom)?.voice ?? {}).flat();
  const was = store.get(voiceUidsAtom);
  if (people.length === was.size && people.every((p) => was.get(p.name) === p.uid)) return;
  store.set(voiceUidsAtom, new Map(people.map((p) => [p.name, p.uid])));
});

onEvents((event) => {
  if (!open) return;
  if (event.type === 'group') {
    if (event.group === open) apply(event);
  } else if (event.type === 'link' && event.phase === 'open') {
    if (store.get(roomAtom)) void loadRoom();
  }
});
