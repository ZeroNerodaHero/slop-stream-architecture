import { atom } from 'jotai';
import { atomWithStorage } from 'jotai/utils';

import { api, cleanSearch, type Followed, messageOf, nameMatches, type Recent, SEARCH_ANYWHERE_FROM, SEARCH_LIMIT, type SearchHit, type Streamer } from '@/infra/api';
import { loadMe, meAtom } from '@/infra/atoms/auth-atoms';
import { PRESENCE_RANK } from '@/infra/atoms/presence-atoms';
import { recount } from '@/infra/follower-count';
import { isValidName } from '@/infra/names';
import { queryClient } from '@/infra/query-client';
import { store } from '@/infra/store';
import { HERE } from '@/infra/here';

const loginFollowingAtom = atom<Followed[] | undefined>(undefined);
export const followingAtom = atom((get) => {
  const me = get(meAtom);
  if (me) return get(loginFollowingAtom);
  return me === null ? get(guestFollowingAtom) : undefined;
});
export const followingNamesAtom = atom(
  (get) => new Set(get(meAtom) === null ? get(guestFollowsAtom).map((f) => f.name) : (get(followingAtom) ?? []).map((f) => f.name))
);
export const friendsOpenAtom = atom(false);
export const followNoteAtom = atom('');

export const searchQueryAtom = atom('');
export interface SearchAnswer {
  hits: SearchHit[];
  settled: boolean;
}
export const searchResultsAtom = atom<SearchAnswer>({ hits: [], settled: true });

const SEARCH_WAIT_MS = 200;
const SEARCH_FRESH_MS = 30_000;
const answers = new Map<string, { hits: SearchHit[]; at: number }>();
let searchTimer: number | undefined;

export interface Peek {
  card: Streamer;
  at: number;
}
export const peeksAtom = atom<Record<string, Peek>>({});
const PEEK_FRESH_MS = 30_000;
const peeking = new Map<string, Promise<void>>();

let asking: Promise<void> | null = null;

export function loadFollowing(): Promise<void> {
  const me = store.get(meAtom);
  if (me === undefined) return Promise.resolve();
  if (me === null) return loadGuestFollowing();
  if (!asking) {
    asking = api
      .following()
      .then((list) => store.set(loginFollowingAtom, list))
      .catch(() => {
      })
      .finally(() => {
        asking = null;
      });
  }
  return asking;
}

export function forgetFollowing() {
  store.set(loginFollowingAtom, undefined);
  store.set(guestAskedAtom, false);
  answers.clear();
  setSearchQuery('');
  store.set(peeksAtom, {});
}

export function loadPeek(name: string): Promise<void> {
  const had = store.get(peeksAtom)[name];
  if (had && Date.now() - had.at < PEEK_FRESH_MS) return Promise.resolve();
  let peek = peeking.get(name);
  if (!peek) {
    peek = api
      .streamer(name)
      .then((card) => store.set(peeksAtom, { ...store.get(peeksAtom), [name]: { card, at: Date.now() } }))
      .catch(() => {
      })
      .finally(() => peeking.delete(name));
    peeking.set(name, peek);
  }
  return peek;
}

function markSearch(name: string, following: boolean) {
  const mark = (hits: SearchHit[]) => hits.map((hit) => (hit.name === name ? { ...hit, following } : hit));
  const shown = store.get(searchResultsAtom);
  store.set(searchResultsAtom, { ...shown, hits: mark(shown.hits) });
  for (const [letters, answer] of answers) answers.set(letters, { ...answer, hits: mark(answer.hits) });
}

function markPeek(name: string, following: boolean) {
  const peeks = store.get(peeksAtom);
  const had = peeks[name];
  if (!had) return;
  const followers = typeof had.card.followers === 'number' ? Math.max(0, had.card.followers + (following ? 1 : -1)) : had.card.followers;
  store.set(peeksAtom, { ...peeks, [name]: { ...had, card: { ...had.card, followers, following } } });
}

function markRecent(name: string, following: boolean) {
  queryClient.setQueryData<Recent[]>(['recent'], (found) => found && recount(found, name, following));
  void queryClient.invalidateQueries({ queryKey: ['recent'] });
}

export async function follow(name: string): Promise<boolean> {
  store.set(followNoteAtom, '');
  await loadMe();
  if (!store.get(meAtom)) return followAsGuest(name);
  try {
    await api.follow(name);
  } catch (err) {
    store.set(followNoteAtom, `not followed: ${messageOf(err)}`);
    return false;
  }
  const list = store.get(loginFollowingAtom) ?? [];
  if (!list.some((f) => f.name === name)) {
    store.set(loginFollowingAtom, [
      ...list,
      { name, verified: false, avatar: null, bio: '', live: false, presence: 'offline', followed_at: new Date().toISOString(), mutual: false }
    ]);
  }
  markSearch(name, true);
  markPeek(name, true);
  markRecent(name, true);
  void loadFollowing();
  return true;
}

export async function unfollow(name: string): Promise<boolean> {
  store.set(followNoteAtom, '');
  await loadMe();
  if (!store.get(meAtom)) return unfollowAsGuest(name);
  try {
    await api.unfollow(name);
  } catch (err) {
    store.set(followNoteAtom, `not unfollowed: ${messageOf(err)}`);
    return false;
  }
  store.set(
    loginFollowingAtom,
    (store.get(loginFollowingAtom) ?? []).filter((f) => f.name !== name)
  );
  markSearch(name, false);
  markPeek(name, false);
  markRecent(name, false);
  return true;
}

function order(hits: SearchHit[], q: string): SearchHit[] {
  return [...hits].sort(
    (a, b) =>
      Number(b.name === q) - Number(a.name === q) ||
      PRESENCE_RANK[a.presence] - PRESENCE_RANK[b.presence] ||
      Number(b.name.startsWith(q)) - Number(a.name.startsWith(q)) ||
      Number(b.verified) - Number(a.verified) ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  );
}

function recall(q: string): boolean {
  if (!q) {
    store.set(searchResultsAtom, { hits: [], settled: true });
    return true;
  }
  const now = Date.now();
  const kept = answers.get(q);
  if (kept && now - kept.at < SEARCH_FRESH_MS) {
    store.set(searchResultsAtom, { hits: order(kept.hits, q), settled: true });
    return true;
  }
  const anywhere = q.length >= SEARCH_ANYWHERE_FROM;
  let hits: SearchHit[] = [];
  for (const [letters, answer] of answers) {
    if (now - answer.at >= SEARCH_FRESH_MS || answer.hits.length >= SEARCH_LIMIT) continue;
    if (letters.length >= SEARCH_ANYWHERE_FROM !== anywhere) continue;
    if (anywhere ? q.includes(letters) : q.startsWith(letters)) {
      hits = answer.hits.filter((hit) => nameMatches(hit.name, q));
      break;
    }
  }
  store.set(searchResultsAtom, { hits: order(hits, q), settled: false });
  return false;
}

export function setSearchQuery(raw: string) {
  store.set(searchQueryAtom, raw);
  window.clearTimeout(searchTimer);
  searchTimer = undefined;
  const q = cleanSearch(raw);
  if (recall(q)) return;
  searchTimer = window.setTimeout(() => void search(q), SEARCH_WAIT_MS);
}

async function search(q: string): Promise<void> {
  try {
    const hits = await api.search(q);
    const now = Date.now();
    for (const [letters, answer] of answers) {
      if (now - answer.at >= SEARCH_FRESH_MS) answers.delete(letters);
    }
    answers.set(q, { hits, at: now });
    const held = cleanSearch(store.get(searchQueryAtom));
    if (held === q || !store.get(searchResultsAtom).settled) recall(held);
  } catch {
    if (cleanSearch(store.get(searchQueryAtom)) === q) store.set(searchResultsAtom, { hits: [], settled: true });
  }
}

const GUEST_FOLLOWS_MAX = 50;

interface GuestFollow {
  name: string;
  at: string;
}

const storedGuestFollowsAtom = atomWithStorage<unknown>('follows', [], undefined, { getOnInit: true });
const guestFollowsAtom = atom((get) => validGuestFollows(get(storedGuestFollowsAtom)));

function validGuestFollows(raw: unknown): GuestFollow[] {
  const out: GuestFollow[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    if (out.length >= GUEST_FOLLOWS_MAX) break;
    if (!item || typeof item !== 'object') continue;
    const { name, at } = item as Record<string, unknown>;
    if (typeof name !== 'string' || !isValidName(name) || typeof at !== 'string' || out.some((f) => f.name === name)) continue;
    out.push({ name, at });
  }
  return out;
}

const guestAskedAtom = atom(false);

const guestFollowingAtom = atom((get): Followed[] | undefined => {
  const kept = get(guestFollowsAtom);
  if (kept.length === 0) return [];
  if (!get(guestAskedAtom)) return undefined;
  const peeks = get(peeksAtom);
  return kept
    .map(({ name, at }): Followed => {
      const card = peeks[name]?.card;
      const presence = card?.presence ?? 'offline';
      return {
        name,
        verified: card?.verified ?? false,
        avatar: card?.avatar ?? null,
        bio: card?.bio ?? '',
        live: presence === 'streaming',
        presence,
        followed_at: at,
        mutual: false
      };
    })
    .sort((a, b) => PRESENCE_RANK[a.presence] - PRESENCE_RANK[b.presence]);
});

async function loadGuestFollowing(): Promise<void> {
  await Promise.all(store.get(guestFollowsAtom).map((f) => loadPeek(f.name)));
  store.set(guestAskedAtom, true);
}

function followAsGuest(name: string): boolean {
  if (!isValidName(name)) {
    store.set(followNoteAtom, 'not followed: bad name. use a-z 0-9 _ - (1 to 32)');
    return false;
  }
  const kept = store.get(guestFollowsAtom);
  if (kept.some((f) => f.name === name)) return true;
  if (kept.length >= GUEST_FOLLOWS_MAX) {
    store.set(followNoteAtom, `not followed: ${HERE} follows ${GUEST_FOLLOWS_MAX} names already. unfollow one first`);
    return false;
  }
  store.set(storedGuestFollowsAtom, [{ name, at: new Date().toISOString() }, ...kept]);
  void loadFollowing();
  return true;
}

function unfollowAsGuest(name: string): boolean {
  store.set(
    storedGuestFollowsAtom,
    store.get(guestFollowsAtom).filter((f) => f.name !== name)
  );
  return true;
}
