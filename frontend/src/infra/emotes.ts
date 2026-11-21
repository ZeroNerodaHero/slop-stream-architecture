/**
 * A group's custom emotes (docs/chat.md "emotes"): discord's server emoji. In a line's words an
 * emote is the token `<:name:id>`; the pages draw it as its picture (`Emote.tsx`), and the box
 * shows it as `:name:` (`encodeEmotes` writes the token back on the way out). Who may use one is
 * the api's to say (emotes.rs `settle`): a token the sender may not use comes back as plain
 * `:name:`, and one whose emote is gone is drawn as `:name:` too.
 *
 * Two lists live here. `myEmotesAtom`: every emote of every group the login is in (`GET
 * /api/emotes/mine`), for the composer's `:` list and the reaction picker. And what any token on
 * screen is (`useEmotes`): asked of `GET /api/emotes?ids=` in batches as lines arrive, so a line
 * from someone in a group the reader is not in still shows its emote and its group.
 */

import { atom, useAtomValue } from 'jotai';
import { useEffect, useSyncExternalStore } from 'react';

import { api } from '@/infra/api';
import { meAtom } from '@/infra/atoms/auth-atoms';
import { store } from '@/infra/store';

/** One emote: its id (the token's and the picture's), its name, and the group it is from. */
export interface Emote {
  id: string;
  name: string;
  group: string;
}

/** An emote as its group's settings list it: who uploaded it (null for a gone account), unix seconds. */
export interface GroupEmote {
  id: string;
  name: string;
  by: string | null;
  at: number;
}

/** A name's rule (emotes.rs `valid_name`): 2 to 32 of a-z 0-9 _. */
export const EMOTE_NAME = /^[a-z0-9_]{2,32}$/;
export const EMOTE_NAME_RULE = '2 to 32 of a-z 0-9 _';
/** Emotes in one group, at most (emotes.rs `MAX_PER_GROUP`). */
export const MAX_EMOTES = 50;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `<:name:id>`: the api's `tokens`. Anything shaped otherwise is words. */
const TOKEN = /<:([a-z0-9_]{2,32}):([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})>/g;

/** Whether a reaction is a custom emote's id rather than an emoji off the list (reactions.rs `emote_of`). */
export function isEmoteId(s: string): boolean {
  return s.length === 36 && UUID.test(s);
}

/** The picture, a 128px webp, cacheable. */
export function emoteSrc(id: string): string {
  return `/api/emotes/${encodeURIComponent(id.toLowerCase())}`;
}

export type EmotePart = string | { name: string; id: string };

/** The words apart from their emote tokens, in order. Plain words when there is none. */
export function splitEmotes(text: string): EmotePart[] {
  const parts: EmotePart[] = [];
  let at = 0;
  for (const m of text.matchAll(TOKEN)) {
    if (m.index > at) parts.push(text.slice(at, m.index));
    parts.push({ name: m[1] ?? '', id: (m[2] ?? '').toLowerCase() });
    at = m.index + m[0].length;
  }
  if (at < text.length) parts.push(text.slice(at));
  return parts;
}

/** The ids of the tokens in `text`. */
export function emoteIds(text: string): string[] {
  return splitEmotes(text).flatMap((p) => (typeof p === 'string' ? [] : [p.id]));
}

/**
 * The words with each token as `:name:`: a quote, a hit, a notice, a copy, where a picture does
 * not go. The name the emote has now when it is known, else the one in the token.
 */
export function plainEmotes(text: string): string {
  if (!text.includes('<:')) return text;
  return splitEmotes(text)
    .map((p) => (typeof p === 'string' ? p : `:${known.get(p.id)?.name ?? p.name}:`))
    .join('');
}

/** The words with each token as the `:name:` written in it: what the box showed before the send (`encodeEmotes`), to know a line of ours coming back. */
export function tokensAsTyped(text: string): string {
  return text.includes('<:') ? text.replace(TOKEN, (_whole: string, name: string) => `:${name}:`) : text;
}

/**
 * Whether a line is emotes alone (and spaces), 27 at most: discord's jumbo, drawn bigger. Plain
 * `:name:` words and a token for an emote that is gone do not count as emotes.
 */
export function onlyEmotes(parts: readonly EmotePart[]): boolean {
  let n = 0;
  for (const p of parts) {
    if (typeof p === 'string') {
      if (p.trim()) return false;
    } else {
      if (known.get(p.id) === null) return false;
      n += 1;
    }
  }
  return n > 0 && n <= 27;
}

// ---- what a token is ------------------------------------------------------------------------

/** id → the emote, or null for one the api says is gone. Not there: not asked yet. */
const known = new Map<string, Emote | null>();
const asking = new Set<string>();
const waiting = new Set<string>();
const listeners = new Set<() => void>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
/** Bumped on every change, so `useSyncExternalStore` sees one. */
let version = 0;
/** Ids in one `GET /api/emotes?ids=` (emotes.rs `LOOKUP_MAX`). */
const BATCH = 100;

function changed() {
  version += 1;
  for (const l of listeners) l();
}

function learn(list: readonly Emote[]) {
  for (const e of list) known.set(e.id.toLowerCase(), { ...e, id: e.id.toLowerCase() });
}

/** What `id` is, as far as is known now: the emote, null for gone, undefined for not yet. */
export function knownEmote(id: string): Emote | null | undefined {
  return known.get(id.toLowerCase());
}

/** Ask for these ids, with the others asked in the same moment, in batches. */
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
          // one asked for and not answered is gone
          for (const id of batch) if (!known.has(id)) known.set(id, null);
        },
        // the api did not answer: asked again the next time one is drawn
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

/**
 * What the emotes `ids` are: the component draws again as answers come. An id the api has not
 * said yet is not in the map; one it said is gone is null.
 */
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

// ---- mine -----------------------------------------------------------------------------------

/** Every emote of every group the login is in, by group then name. Empty for nobody, and until it is read. */
export const myEmotesAtom = atom<Emote[]>([]);
/** Whose `myEmotesAtom` holds, so a login change reads it again. */
let mineFor: string | null | undefined;

/** `myEmotesAtom` read again: on a login, and after an emote is added, renamed or deleted, or a group joined. */
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
    // none for now: the box still sends, with plain words
  }
}

/** The login's emotes, read once per login. */
export function useMyEmotes(): Emote[] {
  const me = useAtomValue(meAtom);
  useEffect(() => {
    if (me !== undefined && me !== mineFor) void loadMyEmotes();
  }, [me]);
  return useAtomValue(myEmotesAtom);
}

/** An emote's id the login picked by name last (the `:` list), so two groups' `:pog:` go out as the one picked. */
const picked = new Map<string, string>();

export function notePicked(emote: Emote) {
  picked.set(emote.name, emote.id);
}

/**
 * What the box shows, as it goes out: each `:name:` that names one of the login's emotes becomes
 * its token (the one picked from the list for that name, else the first group's). A token
 * already written stays as it is. The api settles the rest (emotes.rs `settle`).
 */
export function encodeEmotes(text: string, mine: readonly Emote[] = store.get(myEmotesAtom)): string {
  if (mine.length === 0 || !text.includes(':')) return text;
  const byName = new Map<string, string>();
  for (const e of mine) if (!byName.has(e.name)) byName.set(e.name, e.id);
  for (const [name, id] of picked) if (mine.some((e) => e.id === id)) byName.set(name, id);
  // a token's own `:name:` is preceded by `<`, and left alone
  return text.replace(/(<?):([a-z0-9_]{2,32}):/g, (whole: string, lt: string, name: string) => {
    if (lt) return whole;
    const id = byName.get(name);
    return id ? `<:${name}:${id}>` : whole;
  });
}

/** `:` and two or more of a name's letters just before the caret: the composer's list opens on these (`EmoteComplete.tsx`). */
export function emoteQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const m = /(^|[^a-z0-9_:<]):([a-z0-9_]{2,32})$/i.exec(before);
  if (!m) return null;
  const query = m[2] ?? '';
  return { start: caret - query.length - 1, query: query.toLowerCase() };
}

/** The login's emotes that match `query`, the names that start with it first, then the ones that hold it. */
export function matchEmotes(mine: readonly Emote[], query: string, limit = 8): Emote[] {
  const starts = mine.filter((e) => e.name.startsWith(query));
  const holds = mine.filter((e) => !e.name.startsWith(query) && e.name.includes(query));
  return [...starts, ...holds].slice(0, limit);
}
