import { atom } from 'jotai';

import { store } from '@/infra/store';

export interface ScreenChoice {
  id: string;
  kind: 'display' | 'window';
  name: string;
  app: string;
  width: number;
  height: number;
  thumbnail: string | null;
}

export const screenChoicesAtom = atom<ScreenChoice[] | null>(null);

let answer: ((choice: ScreenChoice | null) => void) | null = null;

export function askScreen(choices: ScreenChoice[]): Promise<ScreenChoice | null> {
  answer?.(null);
  store.set(screenChoicesAtom, choices);
  return new Promise((resolve) => {
    answer = resolve;
  });
}

export function answerScreen(choice: ScreenChoice | null): void {
  const resolve = answer;
  answer = null;
  store.set(screenChoicesAtom, null);
  resolve?.(choice);
}
