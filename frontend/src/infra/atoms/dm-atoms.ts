/**
 * The small chat a friend opens from the corner panel. Nothing here is sent: the window keeps
 * its lines until it closes, because a direct message has no route yet. One person at a time.
 */

import { atom } from 'jotai';

import { store } from '@/infra/store';

export interface Dm {
  name: string;
  avatar: number | null;
  verified: boolean;
}

/** Who the window is with. `null`: it is closed. */
export const dmAtom = atom<Dm | null>(null);

export function openDm(dm: Dm) {
  store.set(dmAtom, dm);
}

export function closeDm() {
  store.set(dmAtom, null);
}
