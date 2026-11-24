import { atom, type Atom } from 'jotai';

import { api, messageOf } from '@/infra/api';
import type { Presence, PresenceChoice } from '@/infra/frames';
import { isValidName } from '@/infra/names';
import { store } from '@/infra/store';

export type { Presence, PresenceChoice } from '@/infra/frames';

export const PRESENCE_WORD: Record<Presence, string> = { offline: 'offline', online: 'online', dnd: 'do not disturb', streaming: 'streaming' };
export const PRESENCE_TEXT: Record<Presence, string> = { streaming: 'text-primaryBlue', online: 'text-increase', dnd: 'text-decrease', offline: 'text-textSecondary' };
export const PRESENCE_RANK: Record<Presence, number> = { streaming: 0, online: 1, dnd: 2, offline: 3 };

export const PRESENCE_CHOICES: readonly PresenceChoice[] = ['online', 'dnd', 'invisible'];

export const myPresenceAtom = atom<Presence>('offline');
export const presenceChoiceAtom = atom<PresenceChoice>('online');
export const presenceChoiceNoteAtom = atom('');

export const presencesAtom = atom<ReadonlyMap<string, Presence>>(new Map());
const perName = new Map<string, Atom<Presence>>();

export function presenceOfAtom(name: string): Atom<Presence> {
  let a = perName.get(name);
  if (!a) {
    a = atom((get) => get(presencesAtom).get(name) ?? 'offline');
    perName.set(name, a);
  }
  return a;
}

export function presenceChanged(name: string, presence: Presence) {
  const current = store.get(presencesAtom);
  if (current.get(name) === presence) return;
  const next = new Map(current);
  next.set(name, presence);
  store.set(presencesAtom, next);
}

export function identifiedAs(name: string | null, presence: Presence, choice: PresenceChoice) {
  store.set(myPresenceAtom, name === null ? 'offline' : presence);
  store.set(presenceChoiceAtom, choice);
}

export function presenceLost() {
  store.set(myPresenceAtom, 'offline');
}

export async function setPresenceChoice(name: string, choice: PresenceChoice): Promise<void> {
  if (!isValidName(name)) {
    store.set(presenceChoiceNoteAtom, 'pick a name first');
    return;
  }
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
