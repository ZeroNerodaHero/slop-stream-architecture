import { atom, useAtomValue } from 'jotai';
import { useEffect, useSyncExternalStore } from 'react';

import { api } from '@/infra/api';
import { meAtom } from '@/infra/atoms/auth-atoms';
import { store } from '@/infra/store';

export interface Emote {
  id: string;
  name: string;
  group: string;
}

export interface GroupEmote {
  id: string;
  name: string;
  by: string | null;
  at: number;
}

export const EMOTE_NAME = /^[a-z0-9_]{2,32}$/;
export const EMOTE_NAME_RULE = '2 to 32 of a-z 0-9 _';
export const MAX_EMOTES = 50;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /<:([a-z0-9_]{2,32}):([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})>/g;

export function isEmoteId(s: string): boolean {
  return s.length === 36 && UUID.test(s);
}

export function emoteSrc(id: string): string {
  return `/api/emotes/${encodeURIComponent(id.toLowerCase())}`;
}

export type EmotePart = string | { name: string; id: string };

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

export function emoteIds(text: string): string[] {
  return splitEmotes(text).flatMap((p) => (typeof p === 'string' ? [] : [p.id]));
}

export function plainEmotes(text: string): string {
  if (!text.includes('<:')) return text;
  return splitEmotes(text)
    .map((p) => (typeof p === 'string' ? p : `:${known.get(p.id)?.name ?? p.name}:`))
    .join('');
}

export function tokensAsTyped(text: string): string {
  return text.includes('<:') ? text.replace(TOKEN, (_whole: string, name: string) => `:${name}:`) : text;
}

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
  if (mine.length === 0 || !text.includes(':')) return text;
  const byName = new Map<string, string>();
  for (const e of mine) if (!byName.has(e.name)) byName.set(e.name, e.id);
  for (const [name, id] of picked) if (mine.some((e) => e.id === id)) byName.set(name, id);
  return text.replace(/(<?):([a-z0-9_]{2,32}):/g, (whole: string, lt: string, name: string) => {
    if (lt) return whole;
    const id = byName.get(name);
    return id ? `<:${name}:${id}>` : whole;
  });
}

export function emoteQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const m = /(^|[^a-z0-9_:<]):([a-z0-9_]{2,32})$/i.exec(before);
  if (!m) return null;
  const query = m[2] ?? '';
  return { start: caret - query.length - 1, query: query.toLowerCase() };
}

export function matchEmotes(mine: readonly Emote[], query: string, limit = 8): Emote[] {
  const starts = mine.filter((e) => e.name.startsWith(query));
  const holds = mine.filter((e) => !e.name.startsWith(query) && e.name.includes(query));
  return [...starts, ...holds].slice(0, limit);
}
