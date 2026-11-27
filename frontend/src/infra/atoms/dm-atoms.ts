import { atom } from 'jotai';

import { api, type DmLine, messageOf } from '@/infra/api';
import { meAtom } from '@/infra/atoms/auth-atoms';
import { keepDmWindow, keptDmWindow } from '@/infra/atoms/chat-layout-atoms';
import { followingAtom } from '@/infra/atoms/follow-atoms';
import type { Presence } from '@/infra/atoms/presence-atoms';
import { Attachments, wordsOf } from '@/infra/chat-attach';
import { audioOf, type ChatAudio } from '@/infra/chat-audio';
import { type ChatVideo, videoOf } from '@/infra/chat-video';
import { callMarkOf } from '@/infra/dm-call';
import { encodeEmotes } from '@/infra/emotes';
import { type LinkEmbed, linkEmbedOf } from '@/infra/link-embed';
import { onEvents } from '@/infra/events';
import { store } from '@/infra/store';
import { applyReaction, type Reaction, reacted, reactionsOf } from '@/shared-components/reaction-list';

export interface Dm {
  id: string;
  name: string;
  avatar: number | null;
  verified: boolean;
  bio: string;
  presence: Presence;
  unread: number;
  last?: DmLine;
}

export type Person = Omit<Dm, 'unread'>;

export interface Thread {
  lines: DmLine[];
  loaded: boolean;
  start: boolean;
}

const PAGE = 50;
const NOTICE_MS = 4000;

export const dmsAtom = atom<Dm[]>([]);
export const dmActiveAtom = atom<string | null>(null);
export const dmOpenAtom = atom(false);
export const dmThreadsAtom = atom<Record<string, Thread>>({});
export const dmNoticeAtom = atom('');

export const dmResultsAtom = atom<{ name: string; query: string; lines: DmLine[] } | null>(null);
export const dmJumpAtom = atom<{ name: string; id: number; n: number } | null>(null);
let jumps = 0;
let asks = 0;

let restoredFor: string | null = null;

const loading = new Set<string>();
let noticeTimer: ReturnType<typeof setTimeout> | null = null;

function find(name: string): Dm | undefined {
  return store.get(dmsAtom).find((d) => d.name === name);
}

function upsert(person: Person, unread?: number) {
  const dms = store.get(dmsAtom);
  const there = dms.find((d) => d.name === person.name);
  if (there)
    store.set(
      dmsAtom,
      dms.map((d) => (d.name === person.name ? { ...d, ...person, id: person.id || d.id, unread: unread ?? d.unread } : d))
    );
  else store.set(dmsAtom, [...dms, { ...person, unread: unread ?? 0 }]);
}

function setUnread(name: string, unread: number) {
  const dms = store.get(dmsAtom);
  if (dms.some((d) => d.name === name && d.unread !== unread))
    store.set(
      dmsAtom,
      dms.map((d) => (d.name === name ? { ...d, unread } : d))
    );
}

function personFor(name: string): Person {
  const row = store.get(followingAtom)?.find((f) => f.name === name);
  return row
    ? { id: '', name, avatar: row.avatar, verified: row.verified, bio: row.bio, presence: row.presence }
    : { id: '', name, avatar: null, verified: true, bio: '', presence: 'offline' };
}

function viewing(name: string): boolean {
  return store.get(dmOpenAtom) && store.get(dmActiveAtom) === name && document.visibilityState === 'visible';
}

export function openDm(person: Person) {
  upsert(person);
  store.set(dmActiveAtom, person.name);
  store.set(dmOpenAtom, true);
  void loadThread(person.name);
  markRead(person.name);
}

export function openDmWith(name: string) {
  openDm(find(name) ?? personFor(name));
}

export function selectDm(name: string) {
  if (!find(name)) return;
  store.set(dmActiveAtom, name);
  void loadThread(name);
  markRead(name);
}

export function removeDm(name: string) {
  const dms = store.get(dmsAtom);
  const at = dms.findIndex((d) => d.name === name);
  if (at < 0) return;
  const rest = dms.filter((d) => d.name !== name);
  store.set(dmsAtom, rest);
  if (store.get(dmActiveAtom) === name) store.set(dmActiveAtom, rest[Math.min(at, rest.length - 1)]?.name ?? null);
  if (store.get(dmResultsAtom)?.name === name) clearDmResults();
}

export function showDms() {
  store.set(dmOpenAtom, true);
  const active = store.get(dmActiveAtom) ?? store.get(dmsAtom)[0]?.name;
  if (active) selectDm(active);
}

export function hideDms() {
  store.set(dmOpenAtom, false);
}

export function pickDm() {
  store.set(dmActiveAtom, null);
}

export function closeAllDms() {
  restoredFor = null;
  store.set(dmsAtom, []);
  store.set(dmActiveAtom, null);
  store.set(dmOpenAtom, false);
  store.set(dmThreadsAtom, {});
  for (const attach of dmAttachments.values()) attach.clear();
  dmAttachments.clear();
  store.set(dmNoticeAtom, '');
  store.set(dmResultsAtom, null);
  store.set(dmJumpAtom, null);
  loading.clear();
  asks++;
}

export async function loadDms(): Promise<void> {
  const me = store.get(meAtom);
  if (!me) return;
  let list;
  try {
    list = await api.dms();
  } catch {
    return;
  }
  if (store.get(meAtom) !== me) return;
  const have = store.get(dmsAtom);
  const fresh: Dm[] = list.map((t) => {
    const here = have.find((d) => d.name === t.name);
    return { id: t.id, name: t.name, avatar: t.avatar, verified: t.verified, bio: t.bio, presence: t.presence, unread: Math.max(t.unread, here?.unread ?? 0), last: t.last ? lineOf(t.last) : undefined };
  });
  const names = new Set(fresh.map((d) => d.name));
  store.set(dmsAtom, [...fresh, ...have.filter((d) => !names.has(d.name))]);
  if (restoredFor !== me) restoreDmWindow(me);
}

function restoreDmWindow(me: string) {
  restoredFor = me;
  const kept = keptDmWindow(me);
  if (kept && !store.get(dmOpenAtom)) {
    if (kept.active && find(kept.active)) store.set(dmActiveAtom, kept.active);
    if (kept.open) showDms();
  }
  keepWindow();
}

function keepWindow() {
  const me = store.get(meAtom);
  if (!me || restoredFor !== me) return;
  keepDmWindow({ me, open: store.get(dmOpenAtom), active: store.get(dmActiveAtom) });
}
store.sub(dmOpenAtom, keepWindow);
store.sub(dmActiveAtom, keepWindow);

function setThread(name: string, next: (prev: Thread | undefined) => Thread) {
  const threads = store.get(dmThreadsAtom);
  store.set(dmThreadsAtom, { ...threads, [name]: next(threads[name]) });
}

function lineOf(line: Omit<DmLine, 'images' | 'call' | 'embed'> & { images?: unknown; call?: unknown; embed?: unknown }): DmLine {
  const images = Array.isArray(line.images) ? line.images.filter((id): id is string => typeof id === 'string' && id.length > 0) : [];
  const reply = line.reply && typeof line.reply === 'object' && typeof line.reply.id === 'number' ? line.reply : null;
  const video = videoOf(line.video);
  const audio = audioOf(line.audio);
  const mentions = Array.isArray(line.mentions) ? line.mentions.filter((m): m is string => typeof m === 'string') : [];
  const call = callMarkOf(line.call);
  const embed = linkEmbedOf(line.embed);
  const base = {
    id: line.id,
    from: line.from,
    text: line.text,
    at: line.at,
    images,
    reply,
    ...(video ? { video } : {}),
    ...(audio ? { audio } : {}),
    ...(mentions.length > 0 ? { mentions } : {}),
    ...(call ? { call } : {}),
    ...(embed ? { embed } : {})
  };
  return 'reactions' in line ? { ...base, reactions: reactionsOf(line.reactions) } : base;
}

function merge(a: DmLine[], b: DmLine[]): DmLine[] {
  const byId = new Map<number, DmLine>();
  for (const line of a) byId.set(line.id, line);
  for (const line of b) {
    const had = byId.get(line.id);
    const fresh = line.reactions === undefined;
    byId.set(line.id, fresh && had ? { ...line, ...(had.reactions ? { reactions: had.reactions } : {}), ...(had.embed !== undefined ? { embed: had.embed } : {}) } : line);
  }
  return [...byId.values()].sort((x, y) => x.id - y.id);
}

export async function loadThread(name: string): Promise<void> {
  if (store.get(dmThreadsAtom)[name]?.loaded || loading.has(name)) return;
  const me = store.get(meAtom);
  loading.add(name);
  try {
    const lines = (await api.dmThread(name)).lines.map(lineOf);
    if (store.get(meAtom) !== me) return;
    setThread(name, (prev) => ({ lines: merge(prev?.lines ?? [], lines), loaded: true, start: lines.length < PAGE }));
    if (viewing(name)) markRead(name);
  } catch (err) {
    showDmNotice(`could not load the chat: ${messageOf(err)}`);
  } finally {
    loading.delete(name);
  }
}

export async function loadOlderDm(name: string): Promise<boolean> {
  const thread = store.get(dmThreadsAtom)[name];
  const oldest = thread?.lines[0];
  if (!thread?.loaded || thread.start || !oldest || loading.has(name)) return false;
  const me = store.get(meAtom);
  loading.add(name);
  try {
    const lines = (await api.dmThread(name, oldest.id)).lines.map(lineOf);
    if (store.get(meAtom) !== me) return false;
    setThread(name, (prev) => ({ lines: merge(lines, prev?.lines ?? []), loaded: true, start: lines.length < PAGE }));
    return lines.length > 0;
  } catch (err) {
    showDmNotice(`could not load older lines: ${messageOf(err)}`);
    return false;
  } finally {
    loading.delete(name);
  }
}

function append(name: string, line: DmLine) {
  setThread(name, (prev) => ({ lines: merge(prev?.lines ?? [], [line]), loaded: prev?.loaded ?? false, start: prev?.start ?? false }));
}

export async function sendDm(
  name: string,
  raw: string,
  images: string[] = [],
  reply: number | null = null,
  video: string | null = null,
  audio: string | null = null
): Promise<string | null> {
  const text = raw.trim();
  if (!text && images.length === 0 && !video && !audio) return 'nothing to say';
  try {
    const line = await api.sendDm(name, encodeEmotes(text), images, reply, video, audio);
    append(name, lineOf(line));
    return null;
  } catch (err) {
    const error = messageOf(err);
    showDmNotice(error);
    return error;
  }
}

const dmAttachments = new Map<string, Attachments>();

export function dmAttach(name: string): Attachments {
  let attach = dmAttachments.get(name);
  if (!attach) {
    attach = new Attachments(showDmNotice);
    dmAttachments.set(name, attach);
  }
  return attach;
}

export function markRead(name: string) {
  const dm = find(name);
  const last = store.get(dmThreadsAtom)[name]?.lines.at(-1);
  if (!dm || !last || (dm.unread === 0 && !viewing(name))) return;
  setUnread(name, 0);
  api.readDm(name, last.id).catch(() => undefined);
}

export async function searchDm(name: string, raw: string): Promise<void> {
  const q = raw.trim();
  if (!q) return;
  const ask = ++asks;
  const me = store.get(meAtom);
  const stale = () => ask !== asks || store.get(meAtom) !== me;
  try {
    const lines = (await api.searchDm(name, q)).lines.map(lineOf);
    if (stale()) return;
    store.set(dmResultsAtom, { name, query: q, lines });
  } catch (err) {
    if (stale()) return;
    store.set(dmResultsAtom, null);
    showDmNotice(messageOf(err));
  }
}

export function clearDmResults() {
  asks++;
  store.set(dmResultsAtom, null);
}

export async function openDmLine(name: string, id: number): Promise<boolean> {
  const lines = () => store.get(dmThreadsAtom)[name]?.lines ?? [];
  const loaded = () => lines().some((l) => l.id === id);
  while (!loaded()) {
    const thread = store.get(dmThreadsAtom)[name];
    const oldest = thread?.lines[0];
    if (!thread?.loaded || thread.start || !oldest || oldest.id < id) break;
    if (loading.has(name)) {
      await new Promise((done) => setTimeout(done, 100));
      continue;
    }
    if (!(await loadOlderDm(name))) break;
  }
  if (!loaded()) return false;
  store.set(dmJumpAtom, { name, id, n: ++jumps });
  return true;
}

export async function reactDm(name: string, line: DmLine, emoji: string): Promise<void> {
  const me = store.get(meAtom);
  const on = !(line.reactions ?? []).some((r) => r.emoji === emoji && reacted(r, me));
  try {
    const answer = await api.reactDm(name, line.id, emoji, on);
    const reactions = reactionsOf(answer.reactions);
    touchLine(name, line.id, () => reactions);
  } catch (err) {
    showDmNotice(messageOf(err));
  }
}

function patchLine(name: string, id: number, next: (line: DmLine) => DmLine) {
  const thread = store.get(dmThreadsAtom)[name];
  if (thread?.lines.some((l) => l.id === id)) setThread(name, () => ({ ...thread, lines: thread.lines.map((l) => (l.id === id ? next(l) : l)) }));
  const results = store.get(dmResultsAtom);
  if (results?.name === name && results.lines.some((l) => l.id === id)) store.set(dmResultsAtom, { ...results, lines: results.lines.map((l) => (l.id === id ? next(l) : l)) });
}

function touchLine(name: string, id: number, next: (now: Reaction[] | undefined) => Reaction[]) {
  patchLine(name, id, (l) => ({ ...l, reactions: next(l.reactions) }));
}

function setDmEmbed(peer: string, id: number, embed: LinkEmbed | null) {
  patchLine(peer, id, (l) => ({ ...l, embed }));
}

function embeddedOn(frame: { id: number; from: string; to: string; embed?: unknown }) {
  const me = store.get(meAtom);
  if (!me || (frame.from !== me && frame.to !== me)) return;
  setDmEmbed(frame.from === me ? frame.to : frame.from, frame.id, linkEmbedOf(frame.embed));
}

export function hideDmEmbed(peer: string, line: DmLine) {
  const was = line.embed ?? null;
  setDmEmbed(peer, line.id, null);
  api.hideDmEmbed(peer, line.id).catch((err: unknown) => {
    setDmEmbed(peer, line.id, was);
    showDmNotice(messageOf(err));
  });
}

export function showDmNotice(text: string) {
  store.set(dmNoticeAtom, wordsOf(text));
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => store.set(dmNoticeAtom, ''), NOTICE_MS);
}

function retarget(fromId: string, peer: string) {
  const dms = store.get(dmsAtom);
  const prior = dms.find((d) => d.id === fromId && d.name !== peer);
  if (!prior) return;
  const old = prior.name;
  const threads = store.get(dmThreadsAtom);
  const moved = threads[old];
  if (moved) {
    const next = { ...threads };
    delete next[old];
    const there = next[peer];
    next[peer] = there ? { lines: merge(there.lines, moved.lines), loaded: there.loaded || moved.loaded, start: there.start && moved.start } : moved;
    store.set(dmThreadsAtom, next);
  }
  store.set(
    dmsAtom,
    dms.flatMap((d) => {
      if (d === prior) return [{ ...prior, name: peer }];
      if (d.name === peer || d.name === old) return [];
      return [d];
    })
  );
  if (store.get(dmActiveAtom) === old) store.set(dmActiveAtom, peer);
  const results = store.get(dmResultsAtom);
  if (results?.name === old) store.set(dmResultsAtom, { ...results, name: peer });
}

function arrived(frame: { id: number; from: string; to: string; text: string; at: number; from_id?: string; images?: string[]; video?: ChatVideo; audio?: ChatAudio; mentions?: string[]; call?: unknown }) {
  const me = store.get(meAtom);
  if (!me || (frame.from !== me && frame.to !== me)) return;
  const peer = frame.from === me ? frame.to : frame.from;
  if (frame.from_id) retarget(frame.from_id, peer);
  if (!find(peer)) {
    upsert(personFor(peer));
    void loadDms();
  }
  append(peer, lineOf(frame));
  if (frame.from === me) return;
  if (viewing(peer)) markRead(peer);
  else {
    const dm = find(peer);
    if (dm) setUnread(peer, dm.unread + 1);
  }
}

function readElsewhere(frame: { name: string; peer: string; id: number }) {
  if (frame.name !== store.get(meAtom)) return;
  const lines = store.get(dmThreadsAtom)[frame.peer]?.lines ?? [];
  setUnread(frame.peer, lines.filter((l) => l.from === frame.peer && l.id > frame.id).length);
}

function reactedOn(frame: { id: number; from: string; to: string; emoji: string; on: boolean }) {
  const me = store.get(meAtom);
  if (!me || (frame.from !== me && frame.to !== me)) return;
  const peer = frame.from === me ? frame.to : frame.from;
  touchLine(peer, frame.id, (now) => applyReaction(now, frame.emoji, frame.from, frame.on, me));
}

let linkWasOpen = false;
onEvents((event) => {
  if (event.type === 'dm') arrived(event);
  else if (event.type === 'dm_react') reactedOn(event);
  else if (event.type === 'dm_embed') embeddedOn(event);
  else if (event.type === 'dm_read') readElsewhere(event);
  else if (event.type === 'link') {
    if (event.phase !== 'open') return;
    if (linkWasOpen && store.get(meAtom)) {
      void loadDms();
      const threads = store.get(dmThreadsAtom);
      store.set(dmThreadsAtom, Object.fromEntries(Object.entries(threads).map(([name, t]) => [name, { ...t, loaded: false }])));
      const active = store.get(dmActiveAtom);
      if (active) void loadThread(active);
    }
    linkWasOpen = true;
  }
});
