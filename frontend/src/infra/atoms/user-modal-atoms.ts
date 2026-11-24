import { atom } from 'jotai';
import { atomWithStorage } from 'jotai/utils';

import { store } from '@/infra/store';

export type UserTab = 'profile' | 'stats' | 'groups' | 'security' | 'notifications' | 'appearance' | 'chat' | 'voice' | 'sidebar' | 'advanced';
export const USER_TABS: readonly UserTab[] = ['profile', 'stats', 'groups', 'security', 'notifications', 'appearance', 'chat', 'voice', 'sidebar', 'advanced'];

export const DEFAULT_TAB: UserTab = 'appearance';

const DESKTOP_ONLY_TABS: readonly UserTab[] = ['advanced'];
const PHONE_TABS = USER_TABS.filter((tab) => !DESKTOP_ONLY_TABS.includes(tab));

export function tabsFor(mobile: boolean): readonly UserTab[] {
  return mobile ? PHONE_TABS : USER_TABS;
}

export const userModalOpenAtom = atom(false);

const storedUserTabAtom = atomWithStorage<unknown>('settings.userTab.v1', DEFAULT_TAB, undefined, { getOnInit: true });
export const userTabAtom = atom((get) => {
  const tab = get(storedUserTabAtom);
  return (USER_TABS as readonly unknown[]).includes(tab) ? (tab as UserTab) : DEFAULT_TAB;
});

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
