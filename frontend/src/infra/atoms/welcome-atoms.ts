import { atom } from 'jotai';
import { atomWithStorage } from 'jotai/utils';

import { store } from '@/infra/store';

export const EQUES = 'Eques';
export const DEFAULT_WELCOME = 'welcome to the chat!';
export const MAX_WELCOME_CHARS = 300;

export interface Welcome {
  on: boolean;
  message: string;
}

export function welcomeOf(wire: { welcome_on?: boolean; welcome?: string }): Welcome | null {
  if (typeof wire.welcome_on !== 'boolean') return null;
  return { on: wire.welcome_on, message: typeof wire.welcome === 'string' && wire.welcome.trim() ? wire.welcome : DEFAULT_WELCOME };
}

const storedShowWelcomesAtom = atomWithStorage<unknown>('settings.showWelcomes', true, undefined, { getOnInit: true });
export const showWelcomesAtom = atom((get) => get(storedShowWelcomesAtom) !== false);

export function setShowWelcomes(show: boolean) {
  store.set(storedShowWelcomesAtom, show);
}
