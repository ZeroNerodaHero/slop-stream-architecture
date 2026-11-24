import { atom } from 'jotai';

import type { Welcome } from '@/infra/atoms/welcome-atoms';
import { EMPTY_SOCIALS, type Socials } from '@/infra/socials';

export type WatchPhase = 'loading' | 'waiting' | 'connecting' | 'connected' | 'watching' | 'reconnecting' | 'failed' | 'bad-name';

export const watchNameAtom = atom('');
export const watchPhaseAtom = atom<WatchPhase>('loading');
export const watchWelcomeAtom = atom<Welcome | null>(null);
export const socialsAtom = atom<Socials>(EMPTY_SOCIALS);
export const pipAtom = atom(false);
