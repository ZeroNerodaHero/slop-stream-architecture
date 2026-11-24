import { atom } from 'jotai';

import { store } from '@/infra/store';

export interface ProfilePopupTarget {
  name: string;
  verified: boolean;
  oauth_verified?: boolean;
  avatar: number | null;
  lines?: string;
}

export const profilePopupAtom = atom<ProfilePopupTarget | null>(null);

export function openProfilePopup(target: ProfilePopupTarget) {
  store.set(profilePopupAtom, target);
}

export function closeProfilePopup() {
  store.set(profilePopupAtom, null);
}
