/**
 * Presence: the word next to a name (`offline`, `online`, `dnd`, `streaming`) and the choice
 * behind mine (`online`, `dnd`, `invisible`). The words arrive on the events socket
 * (events.ts): `me` for my own, `presence` for the names the page watches. The choice goes
 * out as an http PUT; its answer comes back on the socket to every tab and device, so nothing
 * here guesses. Same shape as the other atom modules. See docs/status.md.
 */

import { atom, type Atom } from 'jotai';

import { api, messageOf } from '@/infra/api';
import type { Presence, PresenceChoice } from '@/infra/frames';
import { isValidName } from '@/infra/names';
import { store } from '@/infra/store';

export type { Presence, PresenceChoice } from '@/infra/frames';

export const PRESENCE_WORD: Record<Presence, string> = { offline: 'offline', online: 'online', dnd: 'do not disturb', streaming: 'streaming' };
/** The square's colour. `dnd` carries the bar discord's does, drawn in the panel's background. */
export const PRESENCE_SQUARE: Record<Presence, string> = {
  streaming: 'bg-primaryBlue',
  online: 'bg-increase',
  dnd: "bg-decrease before:absolute before:inset-x-[2px] before:top-1/2 before:h-px before:-translate-y-1/2 before:bg-backgroundSecondary before:content-['']",
  offline: 'bg-textTertiary'
};
/** The word's colour, where it is written out. The api's watch document uses the same classes. */
export const PRESENCE_TEXT: Record<Presence, string> = { streaming: 'text-primaryBlue', online: 'text-increase', dnd: 'text-decrease', offline: 'text-textSecondary' };

export const PRESENCE_CHOICES: readonly PresenceChoice[] = ['online', 'dnd', 'invisible'];

/** What others see of me right now. `offline` until the first `me`, and while nobody is named. */
export const myPresenceAtom = atom<Presence>('offline');
/** The one I picked, as the server has it. */
export const presenceChoiceAtom = atom<PresenceChoice>('online');
/** What the last pick did: `saving`, `saved`, `not saved: <why>`. */
export const presenceChoiceNoteAtom = atom('');

const presencesAtom = atom<ReadonlyMap<string, Presence>>(new Map());
const perName = new Map<string, Atom<Presence>>();

/** The word of one name, as the socket last said. One atom per name, made once (a new atom per render would never settle). */
export function presenceOfAtom(name: string): Atom<Presence> {
  let a = perName.get(name);
  if (!a) {
    a = atom((get) => get(presencesAtom).get(name) ?? 'offline');
    perName.set(name, a);
  }
  return a;
}

/** A `presence` frame: a watched name's word changed. */
export function presenceChanged(name: string, presence: Presence) {
  const current = store.get(presencesAtom);
  if (current.get(name) === presence) return;
  const next = new Map(current);
  next.set(name, presence);
  store.set(presencesAtom, next);
}

/** A `me` frame: my word and my choice, from the server. `name` null is a nameless socket. */
export function identifiedAs(name: string | null, presence: Presence, choice: PresenceChoice) {
  store.set(myPresenceAtom, name === null ? 'offline' : presence);
  store.set(presenceChoiceAtom, choice);
}

/** The socket is gone: nothing is known until it is back. */
export function presenceLost() {
  store.set(myPresenceAtom, 'offline');
}

/**
 * The choice, as the name I am. The api writes the column and publishes; the `me` that comes
 * back on the socket is what every tab and device agrees on. The answer here is the same word
 * a beat earlier, for the browser whose socket is down.
 */
export async function setPresenceChoice(name: string, choice: PresenceChoice): Promise<void> {
  if (!isValidName(name)) {
    store.set(presenceChoiceNoteAtom, 'pick a name first');
    return;
  }
  // the card moves on the click (a radio that waits for the server reads as broken); the
  // server's answer, or the `me` behind it, is what it settles on
  const before = store.get(presenceChoiceAtom);
  store.set(presenceChoiceAtom, choice);
  store.set(presenceChoiceNoteAtom, 'saving');
  try {
    const saved = await api.setPresence(name, choice);
    store.set(presenceChoiceAtom, saved.status);
    store.set(myPresenceAtom, saved.presence);
    store.set(presenceChoiceNoteAtom, 'saved');
  } catch (err) {
    store.set(presenceChoiceAtom, before);
    store.set(presenceChoiceNoteAtom, `not saved: ${messageOf(err)}`);
  }
}

export function clearPresenceNote() {
  store.set(presenceChoiceNoteAtom, '');
}
