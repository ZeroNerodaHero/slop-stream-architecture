/**
 * The small chat a friend opens from the corner panel. Nothing here is sent: the window keeps
 * its lines until it closes, because a direct message has no route yet. One window, a tab per
 * friend down its side: opening a second friend adds a tab instead of replacing the first. The
 * window hides and shows with its tabs kept, and with no tab shown it offers the friends to pick.
 */

import { atom } from 'jotai';

import type { Presence } from '@/infra/atoms/presence-atoms';
import { store } from '@/infra/store';

/** Who a tab is with, as the sidebar row had them when it was opened. The window reads fresher words from the following list when it has them. */
export interface Dm {
  name: string;
  avatar: number | null;
  verified: boolean;
  bio: string;
  presence: Presence;
}

/** The open chats, in the order they were opened: the tabs down the side of the window. */
export const dmsAtom = atom<Dm[]>([]);
/** The tab that is showing. `null`: none, and the window shows the friends to pick from. */
export const dmActiveAtom = atom<string | null>(null);
/** The window is on screen. Hidden, the tabs and their lines wait for the sidebar's chat button. */
export const dmOpenAtom = atom(false);

/** Open a chat with somebody: a new tab, or the one they already have, shown, in a window brought on screen. */
export function openDm(dm: Dm) {
  const dms = store.get(dmsAtom);
  const there = dms.some((d) => d.name === dm.name);
  // the face and the ✓ as the sidebar has them now: a picture uploaded since the tab opened follows
  store.set(dmsAtom, there ? dms.map((d) => (d.name === dm.name ? dm : d)) : [...dms, dm]);
  store.set(dmActiveAtom, dm.name);
  store.set(dmOpenAtom, true);
}

/** Show one of the open tabs. */
export function selectDm(name: string) {
  if (store.get(dmsAtom).some((d) => d.name === name)) store.set(dmActiveAtom, name);
}

/**
 * Take one chat's tab away. Shown, the tab that took its place (or the last one) is shown
 * instead; the last tab going leaves the friends to pick from. The lines are the window's,
 * not the tab's, so opening the same friend again shows what was typed.
 */
export function removeDm(name: string) {
  const dms = store.get(dmsAtom);
  const at = dms.findIndex((d) => d.name === name);
  if (at < 0) return;
  const rest = dms.filter((d) => d.name !== name);
  store.set(dmsAtom, rest);
  if (store.get(dmActiveAtom) === name) store.set(dmActiveAtom, rest[Math.min(at, rest.length - 1)]?.name ?? null);
}

/** The window on screen as it was left: the shown tab, or the friends to pick from. The sidebar's chat button. */
export function showDms() {
  store.set(dmOpenAtom, true);
}

/** The window off screen, its tabs kept: the × on its header. */
export function hideDms() {
  store.set(dmOpenAtom, false);
}

/** The friends to pick from, where the thread was: the + under the tabs. */
export function pickDm() {
  store.set(dmActiveAtom, null);
}

/** Every tab, and the window, on a logout: a guest has no friends to chat with. */
export function closeAllDms() {
  store.set(dmsAtom, []);
  store.set(dmActiveAtom, null);
  store.set(dmOpenAtom, false);
}
