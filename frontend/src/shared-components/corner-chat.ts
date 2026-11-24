import { atom } from 'jotai';

import { store } from '@/infra/store';

export type Corner = 'pip' | 'live-pip';

export const cornerChatAtom = atom<Corner | null>(null);

export function toggleCornerChat(corner: Corner) {
  store.set(cornerChatAtom, store.get(cornerChatAtom) === corner ? null : corner);
}

export const isLivePage = (pathname: string) => pathname.replace(/\/$/, '') === '/live';
