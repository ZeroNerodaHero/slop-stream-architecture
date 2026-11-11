/**
 * The profile popup (ProfilePopup.tsx, docs/follows.md): somebody's page over the page you are
 * on, opened by a click on them in a group's roster or on their name in a chat, while this
 * browser's setting says so (settings.profilePopup, on unless turned off). Who it is about
 * lives here: one person at a time, and nobody while it is closed. Same shape as the user
 * modal's atoms.
 */

import { atom } from 'jotai';

import { store } from '@/infra/store';

/** Who the popup is about, with what the row that was clicked already holds: the head is drawn from it before the profile read lands. */
export interface ProfilePopupTarget {
  name: string;
  verified: boolean;
  avatar: number | null;
  /** Opened from a chat line of this account: the popup has the way to that account's lines in the chat, which is what the click did before the popup. */
  lines?: boolean;
}

export const profilePopupAtom = atom<ProfilePopupTarget | null>(null);

export function openProfilePopup(target: ProfilePopupTarget) {
  store.set(profilePopupAtom, target);
}

export function closeProfilePopup() {
  store.set(profilePopupAtom, null);
}
