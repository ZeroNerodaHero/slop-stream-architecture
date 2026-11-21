/**
 * The chat welcome (docs/chat.md): a line from the bot `Eques` at the top of a stream's chat
 * when it is opened, drawn on that viewer's screen alone (ChatPanel.tsx `WelcomeLine`). Never
 * sent, never in the room's lines: no history, no unread, no mention. The streamer keeps whether
 * it is said and the words (`welcome_on`, `welcome` on the profile read and the watch grant;
 * `PUT /api/streamers/:name/welcome`); a viewer may turn every stream's off for this browser.
 */

import { atom } from 'jotai';
import { atomWithStorage } from 'jotai/utils';

import { store } from '@/infra/store';

/** Who says it. */
export const EQUES = 'Eques';
/** The words until the streamer changes them: the column's default (0009-chat-welcome.sql). */
export const DEFAULT_WELCOME = 'welcome to the chat!';
/** The api keeps this many characters. The box stops there too. */
export const MAX_WELCOME_CHARS = 300;

export interface Welcome {
  on: boolean;
  message: string;
}

/** A stream's welcome as the api carried it. An older api carries none: no line. */
export function welcomeOf(wire: { welcome_on?: boolean; welcome?: string }): Welcome | null {
  if (typeof wire.welcome_on !== 'boolean') return null;
  return { on: wire.welcome_on, message: typeof wire.welcome === 'string' && wire.welcome.trim() ? wire.welcome : DEFAULT_WELCOME };
}

const storedShowWelcomesAtom = atomWithStorage<unknown>('settings.showWelcomes', true, undefined, { getOnInit: true });
/** This browser shows the welcomes (the chat tab's `show welcome messages`). Read: a boolean, whatever localstorage holds; on unless turned off. */
export const showWelcomesAtom = atom((get) => get(storedShowWelcomesAtom) !== false);

export function setShowWelcomes(show: boolean) {
  store.set(storedShowWelcomesAtom, show);
}
