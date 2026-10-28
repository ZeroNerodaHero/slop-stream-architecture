/**
 * Direct messages with friends (docs/dms.md): the threads the login is in, their lines, and
 * the window that shows them (FriendChat.tsx). The api keeps the lines; this module asks for
 * them a page at a time, sends new ones over http, hears them come back on the events socket
 * (to every device of both sides, so a line sent here lands in your other tabs too), and
 * counts what is new. One window, a tab per friend down its side; it hides and shows with
 * its tabs kept, and with no tab shown it offers the friends to pick from. Same shape as the
 * other atom modules: atoms for what renders, action functions for every transition.
 */

import { atom } from 'jotai';

import { api, type DmLine, messageOf } from '@/infra/api';
import { meAtom } from '@/infra/atoms/auth-atoms';
import { followingAtom } from '@/infra/atoms/follow-atoms';
import type { Presence } from '@/infra/atoms/presence-atoms';
import { onEvents } from '@/infra/events';
import { store } from '@/infra/store';

/** Who a tab is with, as the api or the sidebar had them, and how many of their lines are new. */
export interface Dm {
  name: string;
  avatar: number | null;
  verified: boolean;
  bio: string;
  presence: Presence;
  unread: number;
}

/** Somebody to open a chat with: a sidebar row, a pick from the grid. */
export type Person = Omit<Dm, 'unread'>;

/** One thread's lines as loaded, oldest first. `loaded`: the newest page has been asked for. `start`: the first line here is the first there was. */
export interface Thread {
  lines: DmLine[];
  loaded: boolean;
  start: boolean;
}

/** Lines in one page, the api's `PAGE`. A shorter page is the start of the thread. */
const PAGE = 50;
const NOTICE_MS = 4000;

/** The open chats, in the order they were opened: the tabs down the side of the window. From the api on load, newest thread first. */
export const dmsAtom = atom<Dm[]>([]);
/** The tab that is showing. `null`: none, and the window shows the friends to pick from. */
export const dmActiveAtom = atom<string | null>(null);
/** The window is on screen. Hidden, the tabs and their lines wait for the sidebar's chat button. */
export const dmOpenAtom = atom(false);
/** Every thread's lines, by the other side's name. */
export const dmThreadsAtom = atom<Record<string, Thread>>({});
/** What the last send or load said when it failed; '' otherwise. The window shows it under the box. */
export const dmNoticeAtom = atom('');
/** New lines across every thread: the number on the sidebar's chat button. */
export const dmUnreadAtom = atom((get) => get(dmsAtom).reduce((n, d) => n + d.unread, 0));

/** Threads with a page in flight. */
const loading = new Set<string>();
let noticeTimer: ReturnType<typeof setTimeout> | null = null;

// ---- the tabs --------------------------------------------------------------------------------

function find(name: string): Dm | undefined {
  return store.get(dmsAtom).find((d) => d.name === name);
}

/** A tab for `person`: new at the end, or theirs with the newer words. `unread` is kept unless given. */
function upsert(person: Person, unread?: number) {
  const dms = store.get(dmsAtom);
  const there = dms.find((d) => d.name === person.name);
  if (there)
    store.set(
      dmsAtom,
      dms.map((d) => (d.name === person.name ? { ...d, ...person, unread: unread ?? d.unread } : d))
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

/** Somebody the sidebar knows, as it has them now; a bare tab otherwise, filled in by the next `loadDms`. */
function personFor(name: string): Person {
  const row = store.get(followingAtom)?.find((f) => f.name === name);
  return row
    ? { name, avatar: row.avatar, verified: row.verified, bio: row.bio, presence: row.presence }
    : { name, avatar: null, verified: true, bio: '', presence: 'offline' };
}

/** The thread with `name` is on screen, in a tab the person is looking at. */
function viewing(name: string): boolean {
  return store.get(dmOpenAtom) && store.get(dmActiveAtom) === name && document.visibilityState === 'visible';
}

/** Open a chat with somebody: a new tab, or the one they already have, shown, in a window brought on screen. */
export function openDm(person: Person) {
  upsert(person);
  store.set(dmActiveAtom, person.name);
  store.set(dmOpenAtom, true);
  void loadThread(person.name);
  markRead(person.name);
}

/** Show one of the open tabs. */
export function selectDm(name: string) {
  if (!find(name)) return;
  store.set(dmActiveAtom, name);
  void loadThread(name);
  markRead(name);
}

/**
 * Take one chat's tab off the column for this visit. Shown, the tab that took its place (or
 * the last one) is shown instead; the last tab going leaves the friends to pick from. The
 * lines are the api's: the thread is back on the next load, and at once when a line comes.
 */
export function removeDm(name: string) {
  const dms = store.get(dmsAtom);
  const at = dms.findIndex((d) => d.name === name);
  if (at < 0) return;
  const rest = dms.filter((d) => d.name !== name);
  store.set(dmsAtom, rest);
  if (store.get(dmActiveAtom) === name) store.set(dmActiveAtom, rest[Math.min(at, rest.length - 1)]?.name ?? null);
}

/**
 * The window on screen as it was left: the shown tab (read, now that it is looked at); with
 * none shown yet, the newest thread, which is the first tab; with no tab at all, the friends
 * to pick from. The sidebar's chat button.
 */
export function showDms() {
  store.set(dmOpenAtom, true);
  const active = store.get(dmActiveAtom) ?? store.get(dmsAtom)[0]?.name;
  if (active) selectDm(active);
}

/** The window off screen, its tabs kept: the × on its header. */
export function hideDms() {
  store.set(dmOpenAtom, false);
}

/** The friends to pick from, where the thread was: the + under the tabs. */
export function pickDm() {
  store.set(dmActiveAtom, null);
}

/** Everything, on a logout or a change of login: another person's threads are not this one's. */
export function closeAllDms() {
  store.set(dmsAtom, []);
  store.set(dmActiveAtom, null);
  store.set(dmOpenAtom, false);
  store.set(dmThreadsAtom, {});
  store.set(dmNoticeAtom, '');
  loading.clear();
}

// ---- the api ---------------------------------------------------------------------------------

/**
 * `GET /api/dms`: the login's threads, newest first, each with how many lines are new. Over
 * what is here: a tab opened from the grid with nothing said yet is kept, a tab taken off the
 * column this visit comes back only when it has a new line. Nobody: nothing to ask.
 */
export async function loadDms(): Promise<void> {
  if (!store.get(meAtom)) return;
  let list;
  try {
    list = await api.dms();
  } catch {
    // the api is away: what is shown stays, the next open of the window asks again
    return;
  }
  const have = store.get(dmsAtom);
  const fresh: Dm[] = list.map((t) => {
    const here = have.find((d) => d.name === t.name);
    // a line counted new since the list was asked for stays counted: the api's number is the floor
    return { name: t.name, avatar: t.avatar, verified: t.verified, bio: t.bio, presence: t.presence, unread: Math.max(t.unread, here?.unread ?? 0) };
  });
  const names = new Set(fresh.map((d) => d.name));
  store.set(dmsAtom, [...fresh, ...have.filter((d) => !names.has(d.name))]);
}

function setThread(name: string, next: (prev: Thread | undefined) => Thread) {
  const threads = store.get(dmThreadsAtom);
  store.set(dmThreadsAtom, { ...threads, [name]: next(threads[name]) });
}

/** Both sets of lines as one, by id, oldest first: a page over the lines already here, a frame over a page. */
function merge(a: DmLine[], b: DmLine[]): DmLine[] {
  const byId = new Map<number, DmLine>();
  for (const line of a) byId.set(line.id, line);
  for (const line of b) byId.set(line.id, line);
  return [...byId.values()].sort((x, y) => x.id - y.id);
}

/** The newest page of the thread with `name`, once. Looked at, it is read. */
export async function loadThread(name: string): Promise<void> {
  if (store.get(dmThreadsAtom)[name]?.loaded || loading.has(name)) return;
  loading.add(name);
  try {
    const { lines } = await api.dmThread(name);
    setThread(name, (prev) => ({ lines: merge(prev?.lines ?? [], lines), loaded: true, start: lines.length < PAGE }));
    if (viewing(name)) markRead(name);
  } catch (err) {
    notice(`could not load the chat: ${messageOf(err)}`);
  } finally {
    loading.delete(name);
  }
}

/** The page before the oldest line on screen. True when lines came. */
export async function loadOlderDm(name: string): Promise<boolean> {
  const thread = store.get(dmThreadsAtom)[name];
  const oldest = thread?.lines[0];
  if (!thread?.loaded || thread.start || !oldest || loading.has(name)) return false;
  loading.add(name);
  try {
    const { lines } = await api.dmThread(name, oldest.id);
    setThread(name, (prev) => ({ lines: merge(lines, prev?.lines ?? []), loaded: true, start: lines.length < PAGE }));
    return lines.length > 0;
  } catch (err) {
    notice(`could not load older lines: ${messageOf(err)}`);
    return false;
  } finally {
    loading.delete(name);
  }
}

/** One line into a thread, in id order; a line already there (the api's answer, then the frame) is one line. */
function append(name: string, line: DmLine) {
  setThread(name, (prev) => ({ lines: merge(prev?.lines ?? [], [line]), loaded: prev?.loaded ?? false, start: prev?.start ?? false }));
}

/**
 * A line to `name`: `POST /api/dm/<name>`. The api's answer goes in at once (the socket may be
 * down; the box must still work), and the same line coming back on the socket is dropped by
 * id. False, with the api's words under the box, when it was not kept: not friends, too long,
 * too fast.
 */
export async function sendDm(name: string, raw: string): Promise<boolean> {
  const text = raw.trim();
  if (!text) return false;
  try {
    const line = await api.sendDm(name, text);
    append(name, { id: line.id, from: line.from, text: line.text, at: line.at });
    return true;
  } catch (err) {
    notice(messageOf(err));
    return false;
  }
}

/**
 * The thread with `name` is being looked at: nothing in it is new any more. Tells the api,
 * which tells this login's other devices. A thread on screen still tells the api when the
 * local count is already 0, so a line that just arrived is read on the other devices too.
 * Nothing to say when there is no thread, no last line, or nothing was new and the thread
 * is not on screen (`loadThread` calls back here when the lines have arrived).
 */
export function markRead(name: string) {
  const dm = find(name);
  const last = store.get(dmThreadsAtom)[name]?.lines.at(-1);
  if (!dm || !last || (dm.unread === 0 && !viewing(name))) return;
  setUnread(name, 0);
  api.readDm(name, last.id).catch(() => undefined);
}

function notice(text: string) {
  store.set(dmNoticeAtom, text);
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => store.set(dmNoticeAtom, ''), NOTICE_MS);
}

// ---- the socket --------------------------------------------------------------------------------

/**
 * A `dm` frame: a line between this login and somebody, from either side (the gateway sends it
 * to both names' sockets). Into the thread; a tab for them if there is none; counted as new
 * unless it is ours or the thread is on screen.
 */
function arrived(frame: { id: number; from: string; to: string; text: string; at: number }) {
  const me = store.get(meAtom);
  if (!me || (frame.from !== me && frame.to !== me)) return;
  const peer = frame.from === me ? frame.to : frame.from;
  if (!find(peer)) {
    upsert(personFor(peer));
    // the api's words for them (the picture, the bio), behind the line
    void loadDms();
  }
  append(peer, { id: frame.id, from: frame.from, text: frame.text, at: frame.at });
  if (frame.from === me) return;
  if (viewing(peer)) markRead(peer);
  else {
    const dm = find(peer);
    if (dm) setUnread(peer, dm.unread + 1);
  }
}

/** A `dm_read` frame: this login read a thread somewhere, up to a line. What is new here is what came after it. */
function readElsewhere(frame: { name: string; peer: string; id: number }) {
  if (frame.name !== store.get(meAtom)) return;
  const lines = store.get(dmThreadsAtom)[frame.peer]?.lines ?? [];
  setUnread(frame.peer, lines.filter((l) => l.from === frame.peer && l.id > frame.id).length);
}

let linkWasOpen = false;
onEvents((event) => {
  if (event.type === 'dm') arrived(event);
  else if (event.type === 'dm_read') readElsewhere(event);
  else if (event.type === 'link') {
    if (event.phase !== 'open') return;
    // the socket is back after a drop: lines may have come meanwhile. the counts again, and every
    // thread's newest page again when it is next looked at (the shown one now)
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
