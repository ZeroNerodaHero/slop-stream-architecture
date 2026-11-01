/**
 * Who the login follows (docs/follows.md), and the panel in the corner that shows them. The
 * list comes from `GET /api/following` each time the panel opens, so the words beside the names
 * (streaming, online, offline) are fresh; a follow or an unfollow changes the list at once and
 * asks again behind it. Search goes to `GET /api/search` a beat after the last letter
 * (`setSearchQuery`), and what it answered is kept a short while, so letters it has seen, or
 * more letters than an answer that was complete, are shown without asking. What the person
 * card needs past what its row holds (a chat line's speaker: the word and the status) comes
 * from `GET /api/streamers/:name` when a card shows, kept a short while per name.
 */

import { atom } from 'jotai';

import { api, cleanSearch, type Followed, messageOf, nameMatches, SEARCH_ANYWHERE_FROM, SEARCH_LIMIT, type SearchHit, type Streamer } from '@/infra/api';
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

/** The box's letters as typed. Set through `setSearchQuery`, which puts what is in hand for them in `searchResultsAtom` in the same breath. */
export const searchQueryAtom = atom('');
/**
 * What the box shows for its letters. `settled`: the api has answered these very letters (or
 * there were none to ask about), so no hits means nothing called that. Unsettled, the hits are
 * what was in hand, a complete answer for fewer letters cut down to these or nothing, and the
 * api is on its way.
 */
export interface SearchAnswer {
  hits: SearchHit[];
  settled: boolean;
}
export const searchResultsAtom = atom<SearchAnswer>({ hits: [], settled: true });

/** How long the box waits after a letter before asking the api: a pause in the typing, not every key. */
const SEARCH_WAIT_MS = 200;
/** How long an answer is good for: the words beside the names age, and half a minute of backspacing and retyping should ask nothing. */
const SEARCH_FRESH_MS = 30_000;
/** The api's answers by the letters asked, and when each came. Cleared with the login. */
const answers = new Map<string, { hits: SearchHit[]; at: number }>();
let searchTimer: number | undefined;

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

/** The login changed (in, out, renamed): nothing shown is theirs any more, nor anything the box heard (`following` on each hit was theirs). */
export function forgetFollowing() {
  store.set(followingAtom, undefined);
  answers.clear();
  setSearchQuery('');
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

/** A follow or unfollow, written onto the name's hit wherever the box holds it: what shows, and every answer kept. */
function markSearch(name: string, following: boolean) {
  const mark = (hits: SearchHit[]) => hits.map((hit) => (hit.name === name ? { ...hit, following } : hit));
  const shown = store.get(searchResultsAtom);
  store.set(searchResultsAtom, { ...shown, hits: mark(shown.hits) });
  for (const [letters, answer] of answers) answers.set(letters, { ...answer, hits: mark(answer.hits) });
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
  return true;
}

/**
 * The exact name first, then whoever is here (streaming, online, do not disturb, offline), then
 * the api's own order: names starting with the letters, accounts before free names, by name.
 * Spelled out rather than kept from the answer, so hits cut down from an answer for fewer
 * letters stand in the same order a fresh answer would.
 */
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

/**
 * What is in hand for the cleaned letters `q`, shown at once. An answer kept for these very
 * letters settles it. Else a kept answer for fewer letters found the same way (both under
 * `SEARCH_ANYWHERE_FROM`, or both from it) that was complete (short of `SEARCH_LIMIT`) holds
 * every name these letters could find, and is cut down to them; or there is nothing yet.
 * Either way the api is still to answer. True when nothing need be asked.
 */
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

/**
 * The box's letters: shown with what is in hand for them at once (`recall`), and the api asked
 * `SEARCH_WAIT_MS` after the last letter unless that settled it. The box calls this on every
 * letter, the panel on closing with nothing.
 */
export function setSearchQuery(raw: string) {
  store.set(searchQueryAtom, raw);
  window.clearTimeout(searchTimer);
  searchTimer = undefined;
  const q = cleanSearch(raw);
  if (recall(q)) return;
  searchTimer = window.setTimeout(() => void search(q), SEARCH_WAIT_MS);
}

/**
 * `GET /api/search` for the cleaned letters `q`. The answer is kept, and shown through
 * `recall` for whatever the box holds by the time it comes: these letters, settling them;
 * more letters still waiting on their own ask, which it may be cut down to meanwhile; others,
 * or letters settled already, it leaves alone. A refusal shows nothing for the letters,
 * settled, as a miss would.
 */
async function search(q: string): Promise<void> {
  try {
    const hits = await api.search(q);
    const now = Date.now();
    // the stale ones go as a fresh one comes: a long session does not keep every word it ever asked
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
