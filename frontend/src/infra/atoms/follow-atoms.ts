/**
 * Who the login follows (docs/follows.md), and the panel in the corner that shows them. The
 * list comes from `GET /api/following` each time the panel opens, so the words beside the names
 * (streaming, online, offline) are fresh; a follow or an unfollow changes the list at once and
 * asks again behind it. Search goes to `GET /api/search` a beat after the last letter
 * (`setSearchQuery`), and what it answered is kept a short while, so letters it has seen, or
 * more letters than an answer that was complete, are shown without asking. What the person
 * card needs past what its row holds (a chat line's speaker: the word and the status) comes
 * from `GET /api/streamers/:name` when a card shows, kept a short while per name. A guest
 * follows too, in this browser alone (the last part of this file): the names are kept here,
 * localstorage like the nick, and told to nobody, and how each of them is comes from that
 * same profile read, a name each.
 */

import { atom } from 'jotai';
import { atomWithStorage } from 'jotai/utils';

import { api, cleanSearch, type Followed, messageOf, nameMatches, SEARCH_ANYWHERE_FROM, SEARCH_LIMIT, type SearchHit, type Streamer } from '@/infra/api';
import { loadMe, meAtom } from '@/infra/atoms/auth-atoms';
import { PRESENCE_RANK } from '@/infra/atoms/presence-atoms';
import { isValidName } from '@/infra/names';
import { store } from '@/infra/store';

/** A login's list, as `GET /api/following` last answered. `undefined` until asked once for this login; `[]` when it follows nobody. */
const loginFollowingAtom = atom<Followed[] | undefined>(undefined);
/** Who is followed, each with how they are: a login's list, or a guest's own (`guestFollowingAtom`). `undefined` until it has answered once this page load; `[]` for nobody followed. */
export const followingAtom = atom((get) => {
  const me = get(meAtom);
  if (me) return get(loginFollowingAtom);
  return me === null ? get(guestFollowingAtom) : undefined;
});
/** The names alone, for a button that asks "do I follow this one". A guest's are known before the words beside them are: they are kept here. */
export const followingNamesAtom = atom(
  (get) => new Set(get(meAtom) === null ? get(guestFollowsAtom).map((f) => f.name) : (get(followingAtom) ?? []).map((f) => f.name))
);
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
/**
 * How long an answer is good for. A login's row holds the word and shows its own; this is the chat's, where a speaker's word a few seconds behind is
 * close enough, and a guest's list's, which is a read a name: an open inside it asks nothing again.
 */
const PEEK_FRESH_MS = 30_000;
const peeking = new Map<string, Promise<void>>();

let asking: Promise<void> | null = null;

/**
 * The list again. One ask at a time; a second caller waits for the first. A guest's is a
 * profile read for each name kept here (`loadGuestFollowing`). Before /api/me has answered
 * there is nobody to ask as: nothing, and the panel asks the moment it has (UserPanel.tsx).
 */
export function loadFollowing(): Promise<void> {
  const me = store.get(meAtom);
  if (me === undefined) return Promise.resolve();
  if (me === null) return loadGuestFollowing();
  if (!asking) {
    asking = api
      .following()
      .then((list) => store.set(loginFollowingAtom, list))
      .catch(() => {
        // the api is away, or the login died: what is shown stays, the next open asks again
      })
      .finally(() => {
        asking = null;
      });
  }
  return asking;
}

/**
 * The login changed (in, out, renamed): nothing shown is theirs any more, nor anything the box heard (`following` on each hit was theirs).
 * The names a guest follows stay kept; how they are is asked again when the browser is a guest's once more.
 */
export function forgetFollowing() {
  store.set(loginFollowingAtom, undefined);
  store.set(guestAskedAtom, false);
  answers.clear();
  setSearchQuery('');
  store.set(peeksAtom, {});
}

/**
 * The profile read for `name`'s card, and for its row in a guest's list: `GET /api/streamers/:name`,
 * unless a fresh answer is in hand or one is on its way, so a pointer back and forth over the
 * same names asks once. A miss changes nothing: the card keeps to what its row holds.
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

/**
 * A login's follow or unfollow, written onto the profile read kept for the name, when there is
 * one: its count of followers moves by one and it says whether the login follows. The profile
 * popup (ProfilePopup.tsx) reads the count off it, and so does not wait out the answer's age.
 */
function markPeek(name: string, following: boolean) {
  const peeks = store.get(peeksAtom);
  const had = peeks[name];
  if (!had) return;
  const followers = typeof had.card.followers === 'number' ? Math.max(0, had.card.followers + (following ? 1 : -1)) : had.card.followers;
  store.set(peeksAtom, { ...peeks, [name]: { ...had, card: { ...had.card, followers, following } } });
}

/**
 * `POST …/follow`. The name joins the list at once (as offline, until the list is asked again).
 * Who is asking says where it goes (/api/me's answer, in hand unless the page is a moment old):
 * a guest's is kept in this browser and sent nowhere (`followAsGuest`).
 */
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
  void loadFollowing();
  return true;
}

/** `POST …/unfollow`. Gone from the list at once. A guest's goes off this browser's list (`unfollowAsGuest`). */
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

// ---- a guest's follows: this browser's own (docs/follows.md) -----------------------------------

/**
 * Names one browser follows with no login. Each is a profile read of its own whenever the list
 * is asked about, where a login's 500 come in one answer: a number an open of the panel can afford.
 */
const GUEST_FOLLOWS_MAX = 50;

/** A name this browser follows, and since when (rfc3339: the list's `followed_at`). */
interface GuestFollow {
  name: string;
  at: string;
}

const storedGuestFollowsAtom = atomWithStorage<unknown>('follows', [], undefined, { getOnInit: true });
/** Read: valid names, once each, the newest follow first, `GUEST_FOLLOWS_MAX` at most, whatever localstorage holds. */
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

/** The guest's names have been asked about once (`loadGuestFollowing`). Until then their rows wait, the way a login's do, rather than all read offline. */
const guestAskedAtom = atom(false);

/**
 * A guest's list in the shape of a login's: each name kept here with what its profile read
 * last said (`peeksAtom`), offline and faceless for one that has not answered. The api's order
 * for a login: streaming first, then online, do not disturb, offline, and inside a word the
 * newest follow first (the order they are kept in; the sort is stable). Nobody in it is a
 * friend: there is no login for them to follow back.
 */
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

/**
 * How the guest's names are, asked again: a profile read each (`loadPeek`), none for a name
 * whose answer is still fresh, so an open soon after another asks nothing. A read that fails
 * leaves its row as it was. Then the rows may show.
 */
async function loadGuestFollowing(): Promise<void> {
  await Promise.all(store.get(guestFollowsAtom).map((f) => loadPeek(f.name)));
  store.set(guestAskedAtom, true);
}

/**
 * A guest's follow: the name goes first on this browser's list and nowhere else, so the
 * name's count of followers does not move. Its row is there at once, offline until its read
 * is back. Refused for a name the api would refuse, and past `GUEST_FOLLOWS_MAX`, in the
 * api's words for its own cap.
 */
function followAsGuest(name: string): boolean {
  if (!isValidName(name)) {
    store.set(followNoteAtom, 'not followed: bad name. use a-z 0-9 _ - (1 to 32)');
    return false;
  }
  const kept = store.get(guestFollowsAtom);
  if (kept.some((f) => f.name === name)) return true;
  if (kept.length >= GUEST_FOLLOWS_MAX) {
    store.set(followNoteAtom, `not followed: this browser follows ${GUEST_FOLLOWS_MAX} names already. unfollow one first`);
    return false;
  }
  store.set(storedGuestFollowsAtom, [{ name, at: new Date().toISOString() }, ...kept]);
  void loadFollowing();
  return true;
}

/** A guest's unfollow: off this browser's list. */
function unfollowAsGuest(name: string): boolean {
  store.set(
    storedGuestFollowsAtom,
    store.get(guestFollowsAtom).filter((f) => f.name !== name)
  );
  return true;
}
