import { atom, useAtomValue } from 'jotai';
import { useEffect, useSyncExternalStore } from 'react';

import { api } from '@/infra/api';
import { meAtom } from '@/infra/atoms/auth-atoms';
import { store } from '@/infra/store';

import { type Emote, encodeEmotesBy, type EmotePart, onlyEmotesBy, plainEmotesBy } from '@/infra/emote-text';

export {
  type Emote,
  EMOTE_NAME,
  EMOTE_NAME_RULE,
  emoteIds,
  type EmotePart,
  emoteQueryAt,
  emoteSrc,
  type GroupEmote,
  isEmoteId,
  MAX_EMOTES,
  matchEmotes,
  splitEmotes,
  tokensAsTyped
} from '@/infra/emote-text';

export function plainEmotes(text: string): string {
  return plainEmotesBy(text, (id) => known.get(id)?.name);
}

export function onlyEmotes(parts: readonly EmotePart[]): boolean {
  return onlyEmotesBy(parts, (id) => known.get(id) === null);
}

const known = new Map<string, Emote | null>();
const asking = new Set<string>();
const waiting = new Set<string>();
const listeners = new Set<() => void>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let version = 0;
const BATCH = 100;

function changed() {
  version += 1;
  for (const l of listeners) l();
}

function learn(list: readonly Emote[]) {
  for (const e of list) known.set(e.id.toLowerCase(), { ...e, id: e.id.toLowerCase() });
}

export function knownEmote(id: string): Emote | null | undefined {
  return known.get(id.toLowerCase());
}

function want(ids: readonly string[]) {
  let more = false;
  for (const raw of ids) {
    const id = raw.toLowerCase();
    if (known.has(id) || asking.has(id) || waiting.has(id)) continue;
    waiting.add(id);
    more = true;
  }
  if (!more || flushTimer) return;
  flushTimer = setTimeout(flush, 16);
}

function flush() {
  flushTimer = null;
  const all = [...waiting];
  waiting.clear();
  for (let i = 0; i < all.length; i += BATCH) {
    const batch = all.slice(i, i + BATCH);
    for (const id of batch) asking.add(id);
    api
      .emotes(batch)
      .then(
        (answer) => {
          learn(answer.emotes);
          for (const id of batch) if (!known.has(id)) known.set(id, null);
        },
        () => undefined
      )
      .finally(() => {
        for (const id of batch) asking.delete(id);
        changed();
      });
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useEmotes(ids: readonly string[]): Map<string, Emote | null> {
  useSyncExternalStore(subscribe, () => version);
  const key = ids.join(',');
  useEffect(() => want(ids), [key]);
  const out = new Map<string, Emote | null>();
  for (const id of ids) {
    const at = known.get(id.toLowerCase());
    if (at !== undefined) out.set(id.toLowerCase(), at);
  }
  return out;
}

export const myEmotesAtom = atom<Emote[]>([]);
let mineFor: string | null | undefined;

export async function loadMyEmotes(): Promise<void> {
  const me = store.get(meAtom);
  mineFor = me;
  if (!me) {
    store.set(myEmotesAtom, []);
    return;
  }
  try {
    const answer = await api.myEmotes();
    if (store.get(meAtom) !== me) return;
    learn(answer.emotes);
    store.set(
      myEmotesAtom,
      answer.emotes.map((e) => ({ ...e, id: e.id.toLowerCase() }))
    );
    changed();
  } catch {
  }
}

export function useMyEmotes(): Emote[] {
  const me = useAtomValue(meAtom);
  useEffect(() => {
    if (me !== undefined && me !== mineFor) void loadMyEmotes();
  }, [me]);
  return useAtomValue(myEmotesAtom);
}

const picked = new Map<string, string>();

export function notePicked(emote: Emote) {
  picked.set(emote.name, emote.id);
}

export function encodeEmotes(text: string, mine: readonly Emote[] = store.get(myEmotesAtom)): string {
  return encodeEmotesBy(text, mine, picked);
}
