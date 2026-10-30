/**
 * Who the login follows (docs/follows.md), and the panel in the corner that shows them. The
 * list comes from `GET /api/following` each time the panel opens, so the words beside the names
 * (streaming, online, offline) are fresh; a follow or an unfollow changes the list at once and
 * asks again behind it. Search goes to `GET /api/search`, debounced by the box. What the person
 * card needs past what its row holds (a chat line's speaker: the word and the status) comes
 * from `GET /api/streamers/:name` when a card shows, kept a short while per name.
 */

import { atom } from 'jotai';

import { api, type Followed, messageOf, type SearchHit, type Streamer } from '@/infra/api';
import { meAtom } from '@/infra/atoms/auth-atoms';
import { PRESENCE_RANK } from '@/infra/atoms/presence-atoms';
import { store } from '@/infra/store';

/** `undefined` until asked once this page load; `[]` for nobody. */
export const followingAtom = atom<Followed[] | undefined>(undefined);
/** The names alone, for a button that asks "do I follow this one". */
export const followingNamesAtom = atom((get) => new Set((get(followingAtom) ?? []).map((f) => f.name)));
/** How many of them are streaming right now: the number on the corner. */
export const streamingFriendsAtom = atom((get) => (get(followingAtom) ?? []).filter((f) => f.live).length);
/** The panel over the corner is open (hovered or focused; a tab into the search box opens it from the keyboard). */
export const friendsOpenAtom = atom(false);
/** What the last follow or unfollow said when it failed; '' otherwise. */
export const followNoteAtom = atom('');

export const searchQueryAtom = atom('');
export const searchResultsAtom = atom<SearchHit[]>([]);
export const searchBusyAtom = atom(false);

/** What the person card (PersonCard.tsx) says past what its row holds: one profile read, and when it came. */
export interface Peek {
  card: Streamer;
  /** When the answer came, ms: when it is old. */
  at: number;
}
/** By name. A name not here has not been asked about, or the api did not answer. */
export const peeksAtom = atom<Record<string, Peek>>({});
/** How long an answer is good for. A row that holds the word shows its own; this is the chat's, where a speaker's word a few seconds behind is close enough. */
const PEEK_FRESH_MS = 30_000;
const peeking = new Map<string, Promise<void>>();

let asking: Promise<void> | null = null;

/** The list again. One ask at a time; a second caller waits for the first. Nobody: an empty list, no request. */
export function loadFollowing(): Promise<void> {
  if (!store.get(meAtom)) {
    store.set(followingAtom, []);
    return Promise.resolve();
  }
  if (!asking) {
    asking = api
      .following()
      .then((list) => store.set(followingAtom, list))
      .catch(() => {
        // the api is away, or the login died: what is shown stays, the next open asks again
      })
      .finally(() => {
        asking = null;
      });
  }
  return asking;
}

/** The login changed (in, out, renamed): nothing shown is theirs any more. */
export function forgetFollowing() {
  store.set(followingAtom, undefined);
  store.set(searchQueryAtom, '');
  store.set(searchResultsAtom, []);
  store.set(peeksAtom, {});
}

/**
 * The profile read for `name`'s card: `GET /api/streamers/:name`, unless a fresh answer is in
 * hand or one is on its way, so a pointer back and forth over the same names asks once. A miss
 * changes nothing: the card keeps to what its row holds.
 */
export function loadPeek(name: string): Promise<void> {
  const had = store.get(peeksAtom)[name];
  if (had && Date.now() - had.at < PEEK_FRESH_MS) return Promise.resolve();
  let peek = peeking.get(name);
  if (!peek) {
    peek = api
      .streamer(name)
      .then((card) => store.set(peeksAtom, { ...store.get(peeksAtom), [name]: { card, at: Date.now() } }))
      .catch(() => {
        // the api is away: the card shows the row alone, the next show asks again
      })
      .finally(() => peeking.delete(name));
    peeking.set(name, peek);
  }
  return peek;
}

function markSearch(name: string, following: boolean) {
  store.set(
    searchResultsAtom,
    store.get(searchResultsAtom).map((hit) => (hit.name === name ? { ...hit, following } : hit))
  );
}

/** `POST …/follow`. The name joins the list at once (as offline, until the list is asked again). */
export async function follow(name: string): Promise<boolean> {
  store.set(followNoteAtom, '');
  try {
    await api.follow(name);
  } catch (err) {
    store.set(followNoteAtom, `not followed: ${messageOf(err)}`);
    return false;
  }
  const list = store.get(followingAtom) ?? [];
  if (!list.some((f) => f.name === name)) {
    store.set(followingAtom, [
      ...list,
      { name, verified: false, avatar: null, bio: '', live: false, presence: 'offline', followed_at: new Date().toISOString(), mutual: false }
    ]);
  }
  markSearch(name, true);
  markPeek(name, true);
  void loadFollowing();
  return true;
}

/** `POST …/unfollow`. Gone from the list at once. */
export async function unfollow(name: string): Promise<boolean> {
  store.set(followNoteAtom, '');
  try {
    await api.unfollow(name);
  } catch (err) {
    store.set(followNoteAtom, `not unfollowed: ${messageOf(err)}`);
    return false;
  }
  store.set(
    followingAtom,
    (store.get(followingAtom) ?? []).filter((f) => f.name !== name)
  );
  markSearch(name, false);
  markPeek(name, false);
  return true;
}

let searchSeq = 0;

/** The exact name first, then whoever is here (streaming, online, do not disturb, offline), then as the api ranked them. */
function order(hits: SearchHit[], query: string): SearchHit[] {
  return hits
    .map((hit, i) => ({ hit, i }))
    .sort((a, b) => Number(b.hit.name === query) - Number(a.hit.name === query) || PRESENCE_RANK[a.hit.presence] - PRESENCE_RANK[b.hit.presence] || a.i - b.i)
    .map(({ hit }) => hit);
}

/** `GET /api/search`, the hits in `order`. The newest query wins: an older answer arriving later is dropped. */
export async function search(q: string): Promise<void> {
  const mine = ++searchSeq;
  const query = q.trim().toLowerCase();
  if (!query) {
    store.set(searchResultsAtom, []);
    store.set(searchBusyAtom, false);
    return;
  }
  store.set(searchBusyAtom, true);
  try {
    const hits = await api.search(query);
    if (mine !== searchSeq) return;
    store.set(searchResultsAtom, order(hits, query));
  } catch {
    if (mine === searchSeq) store.set(searchResultsAtom, []);
  } finally {
    if (mine === searchSeq) store.set(searchBusyAtom, false);
  }
}
