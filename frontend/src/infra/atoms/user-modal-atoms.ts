/**
 * The user modal: the gear at the end of your line in the corner panel opens it on the tab it
 * was last left on (appearance, the first of this browser's tabs, the first time); a few links
 * around the site open it on a tab of theirs (sign up or log in on security, a guest's picture
 * with no name yet on profile, the gear in the notifications list on notifications, a list
 * switched off in the sidebar on sidebar). Which tab is open lives here, and is kept in
 * localstorage, so a close or a reload comes back to it.
 */

import { atom } from 'jotai';
import { atomWithStorage } from 'jotai/utils';

import { store } from '@/infra/store';

/** The account's four, then this browser's four: what the pages look like, the chat, the column beside the page, the rest. */
export type UserTab = 'profile' | 'groups' | 'security' | 'notifications' | 'appearance' | 'chat' | 'sidebar' | 'advanced';
/** The order down the rail. The dialog renders from this, and the arrow keys walk it. */
export const USER_TABS: readonly UserTab[] = ['profile', 'groups', 'security', 'notifications', 'appearance', 'chat', 'sidebar', 'advanced'];

/** Where the gear lands with nothing kept, or with a tab kept that is gone now (or not on this screen, `tabsFor`). */
export const DEFAULT_TAB: UserTab = 'appearance';

/** Not on a phone (mobile.ts): everything in them does nothing there. advanced is the messages inspector, whose opener is a desktop's. */
const DESKTOP_ONLY_TABS: readonly UserTab[] = ['advanced'];
const PHONE_TABS = USER_TABS.filter((tab) => !DESKTOP_ONLY_TABS.includes(tab));

/** The rail's tabs on this screen: USER_TABS, less the desktop's own on a phone. */
export function tabsFor(mobile: boolean): readonly UserTab[] {
  return mobile ? PHONE_TABS : USER_TABS;
}

/** Two atoms, not one: the Shell renders on `open` alone, a tab change re-renders only the dialog. */
export const userModalOpenAtom = atom(false);

/** Versioned: a change to what a tab is called bumps the key rather than reading an old name. */
const storedUserTabAtom = atomWithStorage<unknown>('settings.userTab.v1', DEFAULT_TAB, undefined, { getOnInit: true });
/** Read: always one of USER_TABS, whatever localstorage holds. */
export const userTabAtom = atom((get) => {
  const tab = get(storedUserTabAtom);
  return (USER_TABS as readonly unknown[]).includes(tab) ? (tab as UserTab) : DEFAULT_TAB;
});

/** With a tab, a link that means that tab: it wins over the kept one. Without, back where it was left. */
export function openUserModal(tab?: UserTab) {
  if (tab) store.set(storedUserTabAtom, tab);
  store.set(userModalOpenAtom, true);
}

export function closeUserModal() {
  store.set(userModalOpenAtom, false);
}

export function pickTab(tab: UserTab) {
  store.set(storedUserTabAtom, tab);
}
