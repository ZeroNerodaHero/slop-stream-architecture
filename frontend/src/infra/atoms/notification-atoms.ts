/**
 * The login's inbox (docs/notifications.md): the last 30 things that happened to them, as the
 * api keeps them. Someone they follow went live, someone followed them, a friend wrote. The
 * list comes from `GET /api/notifications` once the login is known; new rows arrive on the
 * events socket (to every device of the login, so a phone and a laptop hold the same list);
 * opening the bell's list reads everything on it, here and through the api, which tells the
 * other devices. Which kinds are kept is the account's, saved through the api from the user
 * modal's notifications tab. Same shape as the other atom modules: atoms for what renders,
 * action functions for every transition.
 */

import { atom } from 'jotai';

import { api, messageOf, type Notification, type NotifySettings } from '@/infra/api';
import { meAtom } from '@/infra/atoms/auth-atoms';
import { dmActiveAtom, dmOpenAtom } from '@/infra/atoms/dm-atoms';
import { onEvents } from '@/infra/events';
import type { NotificationKind } from '@/infra/frames';
import { store } from '@/infra/store';

/** The api keeps this many a login; the list shows the same. */
export const KEEP = 30;

const ALL_ON: NotifySettings = { live: true, follow: true, dm: true };

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

/** Saves started on this page. An inbox ask applies its settings only when this is still the value from when that ask was sent. A save applies its answer, and the `saved` note, only when this is still the value that save bumped to. */
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

/** The list and the settings again. One ask at a time for the login that started it; a second caller for that login waits. Logout drops the ask, and a late answer is kept only if that login is still the one here and this ask is still in flight. Its rows are applied then, with any row that arrived during the ask; its settings only when no save has started since the ask. A dropped ask writes no list and no settings, and leaves those rows. A failed ask leaves the list unloaded and keeps those rows for the next one. Nobody: an empty list, no request. */
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
        store.set(notifySettingsAtom, settings);
        store.set(notifySettingsLoadedAtom, true);
      }
      const remembered = pending;
      pending = [];
      store.set(notificationsAtom, foldIn(items, remembered));
    })
    .catch(() => {
      // the api is away, or the login died: what is shown stays, and a row remembered during
      // this ask stays for the next apply. a list that never loaded is asked again on open
    })
    .finally(() => {
      if (asking?.promise === promise) asking = null;
    });
  asking = { me, promise };
  return promise;
}

/** The login changed (in, out, renamed): another person's inbox is not this one's. The ask in flight is dropped, so the next login fetches its own, and rows remembered during an ask are dropped with it. The settings are the default again, and a switch does not PUT until that login's GET applies them. */
export function forgetNotifications() {
  asking = null;
  pending = [];
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
 * One kind on or off, from the notifications tab: `PUT /api/notifications/settings` with the
 * whole document. The switch moves on the click; the api's answer, or the one before on a
 * refusal, is what it settles on, and only when no later save has started. What is already in
 * the inbox stays either way. An inbox ask already sent does not put its settings back over
 * this save. Until a GET has applied this login's document, it returns without a PUT: the atom
 * is still the default.
 */
export async function setNotifySetting(kind: NotificationKind, on: boolean): Promise<void> {
  // the atom is still the default: this login's document has not been applied. a PUT would save
  // that default with one key changed, and counting it would throw the real document away
  if (!store.get(notifySettingsLoadedAtom)) return;
  // counted at the start, so an ask sent before this click leaves the saved document in place.
  // the answer settles the switch only while the count is still this one
  settingsGen += 1;
  const bumped = settingsGen;
  const before = store.get(notifySettingsAtom);
  const wanted = { ...before, [kind]: on };
  store.set(notifySettingsAtom, wanted);
  store.set(notifySettingsNoteAtom, 'saving');
  try {
    const saved = await api.saveNotifySettings(wanted);
    // a later save has started: its document and its note stay. this answer is the older one
    if (settingsGen !== bumped) return;
    store.set(notifySettingsAtom, saved);
    store.set(notifySettingsNoteAtom, 'saved');
  } catch (err) {
    // the same for a refusal: `before` must not go back over the later save
    if (settingsGen !== bumped) return;
    store.set(notifySettingsAtom, before);
    store.set(notifySettingsNoteAtom, `not saved: ${messageOf(err)}`);
  }
}

export function clearNotifySettingsNote() {
  store.set(notifySettingsNoteAtom, '');
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
 * no actor (an older gateway) still matches that unread dm by name. With the list open it is
 * seen at once. While this page has no list yet the row is remembered and not written: a
 * failed ask stays failed, one pushed row does not become the list, and it is not marked
 * read. While a reload is already in flight it is remembered as well as written, so the
 * apply keeps it. The apply folds it in; a failed ask keeps it for the next one.
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
}) {
  if (!store.get(meAtom)) return;
  const list = store.get(notificationsAtom);
  const row = rowOf(frame);
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

/** The frame as a row. A dm whose thread is on screen is already seen; nothing else is. */
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
}): Notification {
  return {
    id: frame.id,
    kind: frame.kind,
    name: frame.name,
    actor: frame.actor || '',
    verified: frame.verified,
    avatar: frame.avatar,
    at: frame.at,
    read: frame.kind === 'dm' && viewingDm(frame.name),
    text: frame.text,
    session: frame.session
  };
}

/**
 * One row onto a list. An id already there stays that row. A dm replaces the unread dm from
 * that actor (`actor`, or the name when an older gateway sent none), and that actor's rows
 * take the name on this one. Newest first, clipped to `KEEP`.
 */
function place(list: Notification[], row: Notification): Notification[] {
  if (list.some((n) => n.id === row.id)) return list;
  const actor = row.actor;
  let rest = list;
  if (actor) rest = rest.map((n) => (n.actor === actor && n.name !== row.name ? { ...n, name: row.name } : n));
  if (row.kind === 'dm') {
    rest = rest.filter((n) => !(n.kind === 'dm' && !n.read && (actor ? n.actor === actor : n.name === row.name)));
  }
  return [row, ...rest].slice(0, KEEP);
}

/**
 * The ask's rows, then rows that arrived after it was sent, by `place`. An id the snapshot
 * already has stays the snapshot's row. A list already on screen still takes a push through
 * `place` on its own; this is the same rule when the snapshot lands.
 */
function foldIn(snapshot: Notification[], remembered: readonly Notification[]): Notification[] {
  let list = snapshot.slice(0, KEEP);
  for (const row of remembered) list = place(list, row);
  return list;
}

/** A `notify_read` frame: this login saw its inbox somewhere, up to a row. Those rows are read here too. */
function readElsewhere(frame: { name: string; id: number }) {
  if (frame.name !== store.get(meAtom)) return;
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

let linkWasOpen = false;
onEvents((event) => {
  if (event.type === 'notification') arrived(event);
  else if (event.type === 'notify_read') readElsewhere(event);
  else if (event.type === 'dm_read') dmReadElsewhere(event);
  else if (event.type === 'link') {
    if (event.phase !== 'open') return;
    // the socket is back after a drop: rows may have come meanwhile. the list again
    if (linkWasOpen && store.get(meAtom)) void loadNotifications();
    linkWasOpen = true;
  }
});
