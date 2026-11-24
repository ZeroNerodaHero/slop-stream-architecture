import { atom } from 'jotai';

import { api, messageOf, type Notification, type NotifySettings, roomOf, statusOf } from '@/infra/api';
import { meAtom } from '@/infra/atoms/auth-atoms';
import { chatChannelAtom } from '@/infra/atoms/chat-atoms';
import { dmActiveAtom, dmOpenAtom } from '@/infra/atoms/dm-atoms';
import { roomAtom } from '@/infra/atoms/room-atoms';
import { onEvents } from '@/infra/events';
import type { NotificationKind } from '@/infra/frames';
import { store } from '@/infra/store';

export const KEEP = 30;

const ALL_ON: NotifySettings = { live: true, follow: true, dm: true, chat: true, mention: true };

function inRoom(n: Pick<Notification, 'kind'>): boolean {
  return n.kind === 'chat' || n.kind === 'mention';
}

function withEveryKind(settings: Partial<NotifySettings>): NotifySettings {
  return { ...ALL_ON, ...settings };
}

export const notificationsAtom = atom<Notification[] | undefined>(undefined);
export const unreadNotificationsAtom = atom((get) => (get(notificationsAtom) ?? []).filter((n) => !n.read).length);
export const notificationsOpenAtom = atom(false);
export const notifySettingsAtom = atom<NotifySettings>(ALL_ON);
export const notifySettingsLoadedAtom = atom(false);
export const notifySettingsNoteAtom = atom('');

let asking: { me: string; promise: Promise<void> } | null = null;

let settingsGen = 0;

let pending: Notification[] = [];

let readTo = 0;

let removedDuring = new Set<number>();

export function loadNotifications(): Promise<void> {
  const me = store.get(meAtom);
  if (!me) {
    store.set(notificationsAtom, []);
    return Promise.resolve();
  }
  if (asking?.me === me) return asking.promise;
  const asked = settingsGen;
  const promise = api
    .notifications()
    .then(({ settings, items }) => {
      if (store.get(meAtom) !== me) return;
      if (asking?.promise !== promise) return;
      if (asked === settingsGen) {
        store.set(notifySettingsAtom, withEveryKind(settings));
        store.set(notifySettingsLoadedAtom, true);
      }
      const remembered = pending;
      const removed = removedDuring;
      pending = [];
      removedDuring = new Set();
      store.set(
        notificationsAtom,
        foldIn(items, remembered).filter((n) => !removed.has(n.id))
      );
      const viewed = viewedRoom();
      if (viewed) readChannelNotifications(viewed.server, viewed.channel);
    })
    .catch(() => {
    })
    .finally(() => {
      if (asking?.promise === promise) asking = null;
    });
  asking = { me, promise };
  return promise;
}

export function forgetNotifications() {
  asking = null;
  pending = [];
  readTo = 0;
  removedDuring = new Set();
  settingsGen += 1;
  store.set(notificationsAtom, undefined);
  store.set(notificationsOpenAtom, false);
  store.set(notifySettingsAtom, ALL_ON);
  store.set(notifySettingsLoadedAtom, false);
  store.set(notifySettingsNoteAtom, '');
}

export function closeNotifications() {
  store.set(notificationsOpenAtom, false);
}

export function toggleNotifications() {
  store.set(notificationsOpenAtom, !store.get(notificationsOpenAtom));
}

let readHeld = false;

store.sub(notificationsOpenAtom, () => {
  if (!store.get(notificationsOpenAtom)) readHeld = false;
});

export function markNotificationsRead() {
  if (readHeld) return;
  const list = store.get(notificationsAtom);
  const newest = list?.[0];
  if (!list || !newest || !list.some((n) => !n.read)) return;
  const unreadIds = new Set(list.filter((n) => !n.read).map((n) => n.id));
  store.set(
    notificationsAtom,
    list.map((n) => (n.read ? n : { ...n, read: true }))
  );
  api.readNotifications(newest.id).catch(() => {
    const current = store.get(notificationsAtom);
    if (!current || !current.some((n) => unreadIds.has(n.id))) return;
    if (store.get(notificationsOpenAtom)) readHeld = true;
    store.set(
      notificationsAtom,
      current.map((n) => (unreadIds.has(n.id) ? { ...n, read: false } : n))
    );
  });
}

function dropRow(id: number): boolean {
  if (asking) removedDuring.add(id);
  pending = pending.filter((n) => n.id !== id);
  const list = store.get(notificationsAtom);
  if (!list?.some((n) => n.id === id)) return false;
  store.set(
    notificationsAtom,
    list.filter((n) => n.id !== id)
  );
  return true;
}

export function dismissNotification(id: number) {
  const me = store.get(meAtom);
  const row = store.get(notificationsAtom)?.find((n) => n.id === id);
  if (!me || !row || !dropRow(id)) return;
  api.dismissNotification(id).catch((err) => {
    if (statusOf(err) === 404) return;
    if (store.get(meAtom) !== me) return;
    removedDuring.delete(id);
    const current = store.get(notificationsAtom);
    if (!current || current.some((n) => n.id === id)) return;
    store.set(notificationsAtom, [...current, row].toSorted((a, b) => b.id - a.id).slice(0, KEEP));
  });
}

export async function setNotifySetting(kind: NotificationKind, on: boolean): Promise<void> {
  if (!store.get(notifySettingsLoadedAtom)) return;
  settingsGen += 1;
  const bumped = settingsGen;
  const me = store.get(meAtom);
  const before = store.get(notifySettingsAtom);
  store.set(notifySettingsAtom, { ...before, [kind]: on });
  store.set(notifySettingsNoteAtom, 'saving');
  try {
    const { settings } = await api.notifications();
    if (settingsGen !== bumped) return;
    if (store.get(meAtom) !== me) return;
    const saved = await api.saveNotifySettings({ ...withEveryKind(settings), [kind]: on });
    if (settingsGen !== bumped) return;
    if (store.get(meAtom) !== me) return;
    store.set(notifySettingsAtom, withEveryKind(saved));
    store.set(notifySettingsNoteAtom, 'saved');
  } catch (err) {
    if (settingsGen !== bumped) return;
    if (store.get(meAtom) !== me) return;
    store.set(notifySettingsAtom, before);
    store.set(notifySettingsNoteAtom, `not saved: ${messageOf(err)}`);
  }
}

export function clearNotifySettingsNote() {
  store.set(notifySettingsNoteAtom, '');
}

function viewedRoom(): { server: string; channel: string } | null {
  const room = store.get(roomAtom);
  const channel = store.get(chatChannelAtom);
  if (!room || !channel || document.visibilityState !== 'visible') return null;
  return { server: room.name, channel };
}

function viewingRoom(n: Pick<Notification, 'kind' | 'room'>): boolean {
  const viewed = viewedRoom();
  return viewed !== null && inRoom(n) && n.room === `${viewed.server}/${viewed.channel}`;
}

function readChannelNotifications(server: string, channel: string) {
  if (!store.get(meAtom)) return;
  const list = store.get(notificationsAtom);
  const room = `${server}/${channel}`;
  const hit = (n: Notification) => inRoom(n) && n.room === room && !n.read;
  if (!list?.some(hit)) return;
  const ids = new Set(list.filter(hit).map((n) => n.id));
  store.set(
    notificationsAtom,
    list.map((n) => (ids.has(n.id) ? { ...n, read: true } : n))
  );
  api.readChannel(server, channel).catch(() => {
    const current = store.get(notificationsAtom);
    if (!current?.some((n) => ids.has(n.id))) return;
    store.set(
      notificationsAtom,
      current.map((n) => (ids.has(n.id) ? { ...n, read: false } : n))
    );
  });
}

store.sub(chatChannelAtom, () => {
  const viewed = viewedRoom();
  if (viewed) readChannelNotifications(viewed.server, viewed.channel);
});

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    const viewed = viewedRoom();
    if (viewed) readChannelNotifications(viewed.server, viewed.channel);
  });
}

function viewingDm(name: string): boolean {
  return store.get(dmOpenAtom) && store.get(dmActiveAtom) === name && document.visibilityState === 'visible';
}

function arrived(frame: {
  id: number;
  kind: NotificationKind;
  name: string;
  verified: boolean;
  avatar: number | null;
  at: number;
  text: string;
  session: number | null;
  actor?: string;
  room?: string;
}) {
  if (!store.get(meAtom)) return;
  const list = store.get(notificationsAtom);
  const row = rowOf(frame);
  if (inRoom(row) && row.read) {
    const at = roomOf(row);
    if (at) api.readChannel(at.server, at.channel).catch(() => undefined);
  }
  if (list === undefined) {
    if (!pending.some((n) => n.id === row.id)) pending.push(row);
    return;
  }
  if (list.some((n) => n.id === row.id)) return;
  if (asking && !pending.some((n) => n.id === row.id)) pending.push(row);
  store.set(notificationsAtom, place(list, row));
  if (store.get(notificationsOpenAtom)) markNotificationsRead();
}

function rowOf(frame: {
  id: number;
  kind: NotificationKind;
  name: string;
  verified: boolean;
  avatar: number | null;
  at: number;
  text: string;
  session: number | null;
  actor?: string;
  room?: string;
}): Notification {
  const room = frame.room ?? null;
  return {
    id: frame.id,
    kind: frame.kind,
    name: frame.name,
    actor: frame.actor || '',
    verified: frame.verified,
    avatar: frame.avatar,
    at: frame.at,
    read: (frame.kind === 'dm' && viewingDm(frame.name)) || viewingRoom({ kind: frame.kind, room }),
    text: frame.text,
    session: frame.session,
    room
  };
}

function place(list: Notification[], row: Notification): Notification[] {
  if (list.some((n) => n.id === row.id)) return list;
  const actor = row.actor;
  let rest = list;
  if (actor) rest = rest.map((n) => (n.actor === actor && n.name !== row.name ? { ...n, name: row.name } : n));
  if (row.kind === 'dm') {
    rest = rest.filter((n) => !(n.kind === 'dm' && !n.read && (actor ? n.actor === actor : n.name === row.name)));
  } else if (inRoom(row) && row.room) {
    rest = rest.filter((n) => !(n.kind === row.kind && !n.read && n.room === row.room));
  }
  return [row, ...rest].slice(0, KEEP);
}

function foldIn(snapshot: Notification[], remembered: readonly Notification[]): Notification[] {
  let list = snapshot.slice(0, KEEP);
  for (const row of remembered) list = place(list, row);
  if (readTo && list.some((n) => n.id <= readTo && !n.read)) {
    list = list.map((n) => (n.id <= readTo && !n.read ? { ...n, read: true } : n));
  }
  return list;
}

function readElsewhere(frame: { name: string; id: number }) {
  if (frame.name !== store.get(meAtom)) return;
  if (asking) readTo = Math.max(readTo, frame.id);
  const list = store.get(notificationsAtom);
  if (!list?.some((n) => n.id <= frame.id && !n.read)) return;
  store.set(
    notificationsAtom,
    list.map((n) => (n.id <= frame.id && !n.read ? { ...n, read: true } : n))
  );
}

function removedElsewhere(frame: { name: string; id: number }) {
  if (frame.name !== store.get(meAtom)) return;
  dropRow(frame.id);
}

function dmReadElsewhere(frame: { name: string; peer: string; peer_id?: string }) {
  if (frame.name !== store.get(meAtom)) return;
  const list = store.get(notificationsAtom);
  const peerId = frame.peer_id || '';
  const hit = (n: Notification) => n.kind === 'dm' && !n.read && (peerId ? n.actor === peerId : n.name === frame.peer);
  if (!list?.some(hit)) return;
  store.set(
    notificationsAtom,
    list.map((n) => (hit(n) ? { ...n, read: true } : n))
  );
}

function chatReadElsewhere(frame: { name: string; room: string }) {
  if (frame.name !== store.get(meAtom)) return;
  const list = store.get(notificationsAtom);
  const hit = (n: Notification) => inRoom(n) && !n.read && n.room === frame.room;
  if (!list?.some(hit)) return;
  store.set(
    notificationsAtom,
    list.map((n) => (hit(n) ? { ...n, read: true } : n))
  );
}

let linkWasOpen = false;
onEvents((event) => {
  if (event.type === 'notification') arrived(event);
  else if (event.type === 'notify_read') readElsewhere(event);
  else if (event.type === 'notify_removed') removedElsewhere(event);
  else if (event.type === 'dm_read') dmReadElsewhere(event);
  else if (event.type === 'chat_read') chatReadElsewhere(event);
  else if (event.type === 'link') {
    if (event.phase !== 'open') return;
    if (linkWasOpen && store.get(meAtom)) void loadNotifications();
    linkWasOpen = true;
  }
});
