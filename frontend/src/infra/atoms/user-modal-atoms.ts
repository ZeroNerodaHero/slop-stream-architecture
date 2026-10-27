/**
 * The user modal: the gear at the end of your line in the corner panel opens it (on settings),
 * a rail of tabs down its left; a few links around the site open it on a tab of theirs (sign
 * up or log in on security, a guest's picture with no name yet on profile). Which tab is open
 * lives here, and is remembered for the visit.
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
