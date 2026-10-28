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
/** Which kinds the login keeps, as the api last said. */
export const notifySettingsAtom = atom<NotifySettings>(ALL_ON);
/** What the last save of the settings did: `saving`, `saved`, `not saved: <why>`. */
export const notifySettingsNoteAtom = atom('');

/** The in-flight inbox ask, and the login it belongs to. A second caller for that login waits; any other login starts its own. */
let asking: { me: string; promise: Promise<void> } | null = null;

/** Saves started on this page. An inbox ask applies its settings only when this is still the value from when that ask was sent. */
let settingsGen = 0;

/** The list and the settings again. One ask at a time for the login that started it; a second caller for that login waits. Logout drops the ask, and a late answer is kept only if that login is still the one here. Its rows are applied then; its settings only when no save has started since the ask. Nobody: an empty list, no request. */
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
      // a save started since this ask: its document and its note stay. the rows are still this login's
      if (asked === settingsGen) store.set(notifySettingsAtom, settings);
      store.set(notificationsAtom, items.slice(0, KEEP));
    })
    .catch(() => {
      // the api is away, or the login died: what is shown stays, the next open asks again
    })
    .finally(() => {
      if (asking?.promise === promise) asking = null;
    });
  asking = { me, promise };
  return promise;
}

/** The login changed (in, out, renamed): another person's inbox is not this one's. The ask in flight is dropped, so the next login fetches its own. */
export function forgetNotifications() {
  asking = null;
  store.set(notificationsAtom, undefined);
  store.set(notificationsOpenAtom, false);
  store.set(notifySettingsAtom, ALL_ON);
  store.set(notifySettingsNoteAtom, '');
}

export function closeNotifications() {
  store.set(notificationsOpenAtom, false);
}

export function toggleNotifications() {
  store.set(notificationsOpenAtom, !store.get(notificationsOpenAtom));
}

/**
 * Everything on the list has been seen: the rows read here (the number on the bell goes), and
 * the api told up to the newest row, which tells this login's other devices. Nothing to say
 * when nothing was new.
 */
export function markNotificationsRead() {
  const list = store.get(notificationsAtom);
  const newest = list?.[0];
  if (!list || !newest || !list.some((n) => !n.read)) return;
  store.set(
    notificationsAtom,
    list.map((n) => (n.read ? n : { ...n, read: true }))
  );
  api.readNotifications(newest.id).catch(() => undefined);
}

/**
 * One kind on or off, from the notifications tab: `PUT /api/notifications/settings` with the
 * whole document. The switch moves on the click; the api's answer, or the one before on a
 * refusal, is what it settles on. What is already in the inbox stays either way. An inbox
 * ask already sent does not put its settings back over this save.
 */
export async function setNotifySetting(kind: NotificationKind, on: boolean): Promise<void> {
  // counted at the start, so an ask sent before this click leaves the saved document in place
  settingsGen += 1;
  const before = store.get(notifySettingsAtom);
  const wanted = { ...before, [kind]: on };
  store.set(notifySettingsAtom, wanted);
  store.set(notifySettingsNoteAtom, 'saving');
  try {
    const saved = await api.saveNotifySettings(wanted);
    store.set(notifySettingsAtom, saved);
    store.set(notifySettingsNoteAtom, 'saved');
  } catch (err) {
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
 * gateway restart) is one row. A dm from somebody replaces the unread dm from them, the
 * api's rule. With the list open it is seen at once. Nothing is written when this page has
 * no list yet: a failed ask stays failed, and the next open asks again.
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
}) {
  if (!store.get(meAtom)) return;
  const list = store.get(notificationsAtom);
  // not loaded yet (the ask failed, or it has not come back): not an empty inbox. one pushed
  // row must not become the list, and must not be marked read. the next open asks again.
  if (list === undefined) return;
  if (list.some((n) => n.id === frame.id)) return;
  const rest = frame.kind === 'dm' ? list.filter((n) => !(n.kind === 'dm' && n.name === frame.name && !n.read)) : list;
  const read = frame.kind === 'dm' && viewingDm(frame.name);
  const row: Notification = {
    id: frame.id,
    kind: frame.kind,
    name: frame.name,
    verified: frame.verified,
    avatar: frame.avatar,
    at: frame.at,
    read,
    text: frame.text,
    session: frame.session
  };
  store.set(notificationsAtom, [row, ...rest].slice(0, KEEP));
  if (store.get(notificationsOpenAtom)) markNotificationsRead();
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

/** A `dm_read` frame: this login read its thread with `peer` somewhere. What `peer` wrote is not news any more, the api's rule. */
function dmReadElsewhere(frame: { name: string; peer: string }) {
  if (frame.name !== store.get(meAtom)) return;
  const list = store.get(notificationsAtom);
  if (!list?.some((n) => n.kind === 'dm' && n.name === frame.peer && !n.read)) return;
  store.set(
    notificationsAtom,
    list.map((n) => (n.kind === 'dm' && n.name === frame.peer && !n.read ? { ...n, read: true } : n))
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
