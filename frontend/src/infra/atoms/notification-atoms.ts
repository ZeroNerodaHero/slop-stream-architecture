/**
 * The login's inbox (docs/notifications.md): the last 30 things that happened to them, as the
 * api keeps them. Someone they follow went live, someone followed them, a friend wrote, someone
 * wrote in a channel of a group they are in. The list comes from `GET /api/notifications` once
 * the login is known; new rows arrive on the events socket (to every device of the login, so a
 * phone and a laptop hold the same list); opening the bell's list reads everything on it, here
 * and through the api, which tells the other devices. A channel's row is read by having the
 * channel on screen, the way a friend's is by the thread. Which kinds are kept is the account's,
 * saved through the api from the user modal's notifications tab. A click reads the server's
 * settings and changes only that kind, so a save from another page is not turned back on. Same
 * shape as the other atom modules: atoms for what renders, action functions for every transition.
 */

import { atom } from 'jotai';

import { api, messageOf, type Notification, type NotifySettings, roomOf } from '@/infra/api';
import { meAtom } from '@/infra/atoms/auth-atoms';
import { chatChannelAtom } from '@/infra/atoms/chat-atoms';
import { dmActiveAtom, dmOpenAtom } from '@/infra/atoms/dm-atoms';
import { roomAtom } from '@/infra/atoms/room-atoms';
import { onEvents } from '@/infra/events';
import type { NotificationKind } from '@/infra/frames';
import { store } from '@/infra/store';

/** The api keeps this many a login; the list shows the same. */
export const KEEP = 30;

const ALL_ON: NotifySettings = { live: true, follow: true, dm: true, chat: true };

/** The api's document with every kind named: an older api leaves a newer kind off, and off the wire is on. */
function withEveryKind(settings: Partial<NotifySettings>): NotifySettings {
  return { ...ALL_ON, ...settings };
}

/** `undefined` until asked once this page load; `[]` for nobody, or nothing yet. Newest first. */
export const notificationsAtom = atom<Notification[] | undefined>(undefined);
/** How many have not been seen: the number on the bell. */
export const unreadNotificationsAtom = atom((get) => (get(notificationsAtom) ?? []).filter((n) => !n.read).length);
/** The list is open under the bell. */
export const notificationsOpenAtom = atom(false);
/** Which kinds the login keeps, as the api last said. The default until this login's GET applies them. */
export const notifySettingsAtom = atom<NotifySettings>(ALL_ON);
/** That GET has applied this login's document. Until then a switch does not PUT, and the boxes stay disabled. Cleared with the login. */
export const notifySettingsLoadedAtom = atom(false);
/** What the last save of the settings did: `saving`, `saved`, `not saved: <why>`. */
export const notifySettingsNoteAtom = atom('');

/** The in-flight inbox ask, and the login it belongs to. A second caller for that login waits; any other login starts its own. */
let asking: { me: string; promise: Promise<void> } | null = null;

/** Saves started on this page. An inbox ask applies its settings only when this is still the value from when that ask was sent. A save applies its answer, and the `saved` note, only when this is still the value that save bumped to. The login changing moves it too, so a save from the one that left does not match. */
let settingsGen = 0;

/**
 * Rows that arrived during an inbox ask. While this page has no list yet they are not the list:
 * nothing is written until an ask applies, so one pushed row cannot become the whole inbox and
 * cannot be marked read. While a reload is in flight and the list is already showing, the row is
 * here and on the list, so the bell counts it and the older snapshot does not drop it. An id
 * already here is not added again. A failed ask leaves them here for the next apply.
 * `forgetNotifications` drops them.
 */
let pending: Notification[] = [];

/**
 * The greatest id a `notify_read` named while an inbox ask was in flight, or `0` when none has.
 * The snapshot may still list that row unread, including when the list on screen did not have it
 * yet, so the apply marks every row at or below this id read. A failed ask leaves it, and so may
 * a successful one. The login changing drops it.
 */
let readTo = 0;

/** The list and the settings again. One ask at a time for the login that started it; a second caller for that login waits. Logout drops the ask, and a late answer is kept only if that login is still the one here and this ask is still in flight. Its rows are applied then, with any row that arrived during the ask, and every row up to a read that arrived during the ask is marked read; its settings only when no save has started since the ask. A dropped ask writes no list and no settings, and leaves those rows. A failed ask leaves the list unloaded and keeps those rows, and that read id, for the next one. Nobody: an empty list, no request. */
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
      // this answer belongs to the login that asked: once that login has gone, leave the store alone
      if (store.get(meAtom) !== me) return;
      // dropped (logout, or this name logged in again): the snapshot is not the list on screen.
      // rows remembered since belong to the ask still in flight, so they stay. the document stays
      // too: a dropped ask must not write its settings over the login now here
      if (asking?.promise !== promise) return;
      // a save started since this ask: its document and its note stay. the rows are still this login's.
      // applying the document is what lets a switch PUT. until then the atom is the default
      if (asked === settingsGen) {
        store.set(notifySettingsAtom, withEveryKind(settings));
        store.set(notifySettingsLoadedAtom, true);
      }
      const remembered = pending;
      pending = [];
      store.set(notificationsAtom, foldIn(items, remembered));
      // a channel on screen while the ask was out: what the snapshot says is new there is not
      const viewed = viewedRoom();
      if (viewed) readChannelNotifications(viewed.server, viewed.channel);
    })
    .catch(() => {
      // the api is away, or the login died: what is shown stays, and a row remembered during
      // this ask stays for the next apply, and so does a read id kept during it. a list that
      // never loaded is asked again on open
    })
    .finally(() => {
      if (asking?.promise === promise) asking = null;
    });
  asking = { me, promise };
  return promise;
}

/** The login changed (in, out, renamed): another person's inbox is not this one's. The ask in flight is dropped, so the next login fetches its own, and rows remembered during an ask, and a read id kept for it, are dropped with it. A save still in flight is dropped the same way: its answer is not written on the login now here. The settings are the default again, and a switch does not PUT until that login's GET applies them. */
export function forgetNotifications() {
  asking = null;
  pending = [];
  readTo = 0;
  // a save still in flight must not match: its answer belongs to the login that left
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

/**
 * This open's read was refused, and those rows are unread again. The list is still open, so
 * the effect would ask, be refused, and ask forever. Closing the list clears it; the next
 * open asks again.
 */
let readHeld = false;

store.sub(notificationsOpenAtom, () => {
  if (!store.get(notificationsOpenAtom)) readHeld = false;
});

/**
 * Everything on the list has been seen: the rows read here (the number on the bell goes), and
 * the api told up to the newest row, which tells this login's other devices. Nothing to say
 * when nothing was new. A refusal marks those rows unread again when they are still on the
 * list now, so the next open tells the api again. A list that has since been replaced is
 * left as it is.
 */
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
    // gone, or a list that no longer has these rows: do not put the old list back
    if (!current || !current.some((n) => unreadIds.has(n.id))) return;
    // still open: the rows going back to unread would ask again, and the refusal again
    if (store.get(notificationsOpenAtom)) readHeld = true;
    store.set(
      notificationsAtom,
      current.map((n) => (unreadIds.has(n.id) ? { ...n, read: false } : n))
    );
  });
}

/**
 * One kind on or off, from the notifications tab. The switch moves on the click. The PUT is the
 * server's document, read with `GET /api/notifications` after the click, with only that kind
 * changed, so a save another page already made is not copied back on from this page's atom. The
 * rows of that GET are not written here, and it is not the inbox ask already in flight. The
 * api's answer, or the document from before this click on a refusal, settles the switch only
 * when this save is still the latest and the login is still the one that started it. An inbox
 * ask already sent does not put its settings back over this save. Until a GET has applied this
 * login's document, it returns without a PUT and without counting the save: the atom is still
 * the default.
 */
export async function setNotifySetting(kind: NotificationKind, on: boolean): Promise<void> {
  // the atom is still the default: this login's document has not been applied. a PUT would save
  // that default with one key changed, and counting it would throw the real document away
  if (!store.get(notifySettingsLoadedAtom)) return;
  // counted at the start, so an ask sent before this click leaves the saved document in place.
  // the answer settles the switch only while the count is still this one
  settingsGen += 1;
  const bumped = settingsGen;
  // the login this save is for. a later one must not take the answer
  const me = store.get(meAtom);
  const before = store.get(notifySettingsAtom);
  // the box tracks the click. this copy is not the PUT: another page's save is not in it
  store.set(notifySettingsAtom, { ...before, [kind]: on });
  store.set(notifySettingsNoteAtom, 'saving');
  try {
    // the server's document only. the rows stay out of the inbox atom, and this GET is not the
    // inbox ask already in flight, so a held ask does not hold the click
    const { settings } = await api.notifications();
    // a later save has started: its document and its note stay. this answer is the older one
    if (settingsGen !== bumped) return;
    // the login changed: this answer is not theirs. the document and the note stay
    if (store.get(meAtom) !== me) return;
    const saved = await api.saveNotifySettings({ ...withEveryKind(settings), [kind]: on });
    if (settingsGen !== bumped) return;
    if (store.get(meAtom) !== me) return;
    store.set(notifySettingsAtom, withEveryKind(saved));
    store.set(notifySettingsNoteAtom, 'saved');
  } catch (err) {
    // the same for a refusal: `before` must not go back over the later save
    if (settingsGen !== bumped) return;
    // and not onto a login that is no longer this one
    if (store.get(meAtom) !== me) return;
    store.set(notifySettingsAtom, before);
    store.set(notifySettingsNoteAtom, `not saved: ${messageOf(err)}`);
  }
}

export function clearNotifySettingsNote() {
  store.set(notifySettingsNoteAtom, '');
}

// ---- a channel on screen -----------------------------------------------------------------------

/** The channel the room page has on screen, in a tab the person is looking at: a line said there is not news. Null for none. */
function viewedRoom(): { server: string; channel: string } | null {
  const room = store.get(roomAtom);
  const channel = store.get(chatChannelAtom);
  if (!room || !channel || document.visibilityState !== 'visible') return null;
  return { server: room.name, channel };
}

/** A `chat` row for the channel on screen. */
function viewingRoom(n: Pick<Notification, 'kind' | 'room'>): boolean {
  const viewed = viewedRoom();
  return viewed !== null && n.kind === 'chat' && n.room === `${viewed.server}/${viewed.channel}`;
}

/**
 * The login has `channel` of `server` on screen (the room page arriving there, a channel
 * picked, the tab shown again): what was said there is not news any more. The `chat` rows for
 * the room are read here (the bell drops) and the api is told, which tells the login's other
 * devices through `chat_read`. Nothing to say when none was unread. A refusal marks those rows
 * unread again when they are still on the list, so the next look tells the api again.
 */
function readChannelNotifications(server: string, channel: string) {
  if (!store.get(meAtom)) return;
  const list = store.get(notificationsAtom);
  const room = `${server}/${channel}`;
  const hit = (n: Notification) => n.kind === 'chat' && n.room === room && !n.read;
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

/** The channel on screen, whenever it changes: what the list says is new there is seen. The room page arriving on a channel sets it too. */
store.sub(chatChannelAtom, () => {
  const viewed = viewedRoom();
  if (viewed) readChannelNotifications(viewed.server, viewed.channel);
});

// the tab shown again with a channel on screen: what landed there while it was hidden is seen now
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    const viewed = viewedRoom();
    if (viewed) readChannelNotifications(viewed.server, viewed.channel);
  });
}

// ---- the socket --------------------------------------------------------------------------------

/** The thread with `name` is on screen in the chat window: a line from them is not news. */
function viewingDm(name: string): boolean {
  return store.get(dmOpenAtom) && store.get(dmActiveAtom) === name && document.visibilityState === 'visible';
}

/**
 * A `notification` frame: a row of this login's inbox, from the api (it reaches every device
 * of the login). To the top of the list; a row already there (the ten-second replay of a
 * gateway restart) is one row. A dm replaces the unread dm from that account (`actor`), the
 * api's rule, and a new name for them is written onto the rows already stored. A frame with
 * no actor (an older gateway) still matches that unread dm by name. A channel's line replaces
 * the unread one for that channel. With the list open it is seen at once; so is a channel's
 * line while that channel is on screen, and the api is told so (a dm's thread tells it on its
 * own). While this page has no list yet the row is remembered and not written: a failed ask
 * stays failed, one pushed row does not become the list, and it is not marked read. While a
 * reload is already in flight it is remembered as well as written, so the apply keeps it. The
 * apply folds it in; a failed ask keeps it for the next one.
 */
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
  // a channel's line while that channel is on screen: seen already, here and through the api,
  // whose `chat_read` reads it on the other devices. the row is there: the fact came after it
  if (row.kind === 'chat' && row.read) {
    const at = roomOf(row);
    if (at) api.readChannel(at.server, at.channel).catch(() => undefined);
  }
  // not loaded yet (the ask failed, or it has not come back): not an empty inbox. remember the
  // row and do not write it, so it does not become the list and is not marked read.
  if (list === undefined) {
    if (!pending.some((n) => n.id === row.id)) pending.push(row);
    return;
  }
  if (list.some((n) => n.id === row.id)) return;
  // a reload already in flight may have snapshotted before this row. remember it, and show it now
  if (asking && !pending.some((n) => n.id === row.id)) pending.push(row);
  store.set(notificationsAtom, place(list, row));
  if (store.get(notificationsOpenAtom)) markNotificationsRead();
}

/** The frame as a row. A dm whose thread is on screen is already seen, and so is a channel's line while that channel is; nothing else is. */
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

/**
 * One row onto a list. An id already there stays that row. A dm replaces the unread dm from
 * that actor (`actor`, or the name when an older gateway sent none), and that actor's rows
 * take the name on this one. A channel's line replaces the unread row for that channel,
 * whoever spoke. Newest first, clipped to `KEEP`.
 */
function place(list: Notification[], row: Notification): Notification[] {
  if (list.some((n) => n.id === row.id)) return list;
  const actor = row.actor;
  let rest = list;
  if (actor) rest = rest.map((n) => (n.actor === actor && n.name !== row.name ? { ...n, name: row.name } : n));
  if (row.kind === 'dm') {
    rest = rest.filter((n) => !(n.kind === 'dm' && !n.read && (actor ? n.actor === actor : n.name === row.name)));
  } else if (row.kind === 'chat' && row.room) {
    rest = rest.filter((n) => !(n.kind === 'chat' && !n.read && n.room === row.room));
  }
  return [row, ...rest].slice(0, KEEP);
}

/**
 * The ask's rows, then rows that arrived after it was sent, by `place`. An id the snapshot
 * already has stays the snapshot's row. A list already on screen still takes a push through
 * `place` on its own; this is the same rule when the snapshot lands. Then every row at or
 * below a read that landed during the ask is read: the snapshot can still say unread.
 */
function foldIn(snapshot: Notification[], remembered: readonly Notification[]): Notification[] {
  let list = snapshot.slice(0, KEEP);
  for (const row of remembered) list = place(list, row);
  if (readTo && list.some((n) => n.id <= readTo && !n.read)) {
    list = list.map((n) => (n.id <= readTo && !n.read ? { ...n, read: true } : n));
  }
  return list;
}

/** A `notify_read` frame: this login saw its inbox somewhere, up to a row. Those rows are read here too. While an inbox ask is in flight that id is kept (the greatest one), even when this list has no unread row at or below it yet, so the apply does not put them back. */
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

/** A `dm_read` frame: this login read its thread with `peer` somewhere. What that account wrote is not news any more. `peer_id` is the account; without it (an older gateway) the name is the match. */
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

/** A `chat_read` frame: this login had the channel `room` on screen somewhere. What was said there is not news any more. */
function chatReadElsewhere(frame: { name: string; room: string }) {
  if (frame.name !== store.get(meAtom)) return;
  const list = store.get(notificationsAtom);
  const hit = (n: Notification) => n.kind === 'chat' && !n.read && n.room === frame.room;
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
  else if (event.type === 'dm_read') dmReadElsewhere(event);
  else if (event.type === 'chat_read') chatReadElsewhere(event);
  else if (event.type === 'link') {
    if (event.phase !== 'open') return;
    // the socket is back after a drop: rows may have come meanwhile. the list again
    if (linkWasOpen && store.get(meAtom)) void loadNotifications();
    linkWasOpen = true;
  }
});
