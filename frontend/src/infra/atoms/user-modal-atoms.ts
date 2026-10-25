/**
 * The user modal: the picture or the name in the corner panel opens it, a rail of tabs down
 * its left. Which tab is open lives here, so the gear can open straight onto settings and the
 * tab is remembered for the visit.
 */

import { atom } from 'jotai';

import { store } from '@/infra/store';

export type UserTab = 'profile' | 'groups' | 'security' | 'settings' | 'appearance';
/** The order down the rail. The dialog renders from this, and the arrow keys walk it. */
export const USER_TABS: readonly UserTab[] = ['profile', 'groups', 'security', 'settings', 'appearance'];

/** Two atoms, not one: the Shell renders on `open` alone, a tab change re-renders only the dialog. */
export const userModalOpenAtom = atom(false);
export const userTabAtom = atom<UserTab>('profile');

export function openUserModal(tab: UserTab = 'profile') {
  store.set(userTabAtom, tab);
  store.set(userModalOpenAtom, true);
}

export function closeUserModal() {
  store.set(userModalOpenAtom, false);
}

export function pickTab(tab: UserTab) {
  store.set(userTabAtom, tab);
}
