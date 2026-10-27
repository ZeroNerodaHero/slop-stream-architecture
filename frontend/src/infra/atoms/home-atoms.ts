/**
 * The home list (docs/status.md). One `GET /api/streams` when the page arrives: the home
 * service's snapshot, in its order (first on, first shown). Then the facts over the events
 * socket, under `watch *`: `live` puts a card at the end, `ended` takes one out, `viewers`
 * moves a count. Nothing polls. The two pulls behind the push: the socket opening (or coming
 * back) while the page is up takes the snapshot again, since the facts of a gap are gone, and
 * an ask that failed is asked again, later each time, the watch page's shape. Frames that land
 * while a snapshot is in flight are held and applied on top of it, so a stream that started
 * in that window is neither lost nor doubled. Same shape as the other atom modules: atoms for
 * what renders, module handles, action functions.
 */

import { atom } from 'jotai';

import { api, type LiveStream, messageOf } from '@/infra/api';
import { onEvents, unwatchPresence, watchPresence } from '@/infra/events';
import type { ServerFrame } from '@/infra/frames';
import { store } from '@/infra/store';

/** The streams, in the order the page shows them. `null` before the first answer. */
export const homeStreamsAtom = atom<LiveStream[] | null>(null);
/** Why there is no list: what the api said, or that it did not answer. '' while it has. */
export const homeErrorAtom = atom('');
/** The page's clock, once a second while it is open: "live for 52 min" moves without a poll. */
export const homeNowAtom = atom(Date.now());

const RETRY_FIRST_MS = 3000;
const RETRY_MAX_MS = 60_000;
/** The `watch` that is every name. */
const EVERYONE = '*';

/** Home pages mounted. One, but a strict-mode mount is two. */
let open = 0;
/** Which `load` is the current one: an answer to an older one, or to a page since left, is dropped. */
let attempt = 0;
let failures = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let clock: ReturnType<typeof setInterval> | null = null;
/** The frames that came while the snapshot was in flight, to apply on top of it. `null` when none is. */
let inflight: ServerFrame[] | null = null;
/** The socket opened while a snapshot was in flight: that snapshot may predate the subscription, so one more follows it. */
let againWhenDone = false;

/** The home page mounted: the feed on, the clock on, the snapshot asked. */
export function enterHome(): void {
  open++;
  if (open > 1) return;
  watchPresence(EVERYONE);
  clock = setInterval(() => store.set(homeNowAtom, Date.now()), 1000);
  void load();
}

/** The home page left: the feed off, the clock off. The list is kept, so coming back shows it at once while it is asked again. */
export function leaveHome(): void {
  open--;
  if (open > 0) return;
  attempt++;
  inflight = null;
  againWhenDone = false;
  failures = 0;
  unwatchPresence(EVERYONE);
  if (clock) clearInterval(clock);
  clock = null;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
}

async function load(): Promise<void> {
  const mine = ++attempt;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  inflight = [];
  let list: LiveStream[];
  try {
    list = await api.streams();
  } catch (err) {
    if (mine !== attempt) return;
    inflight = null;
    store.set(homeErrorAtom, messageOf(err));
    const wait = Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** failures);
    failures++;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void load();
    }, wait);
    return;
  }
  if (mine !== attempt) return;
  failures = 0;
  store.set(homeErrorAtom, '');
  store.set(homeStreamsAtom, list);
  store.set(homeNowAtom, Date.now());
  const held = inflight ?? [];
  inflight = null;
  for (const frame of held) apply(frame);
  if (againWhenDone) {
    againWhenDone = false;
    void load();
  }
}

/** One fact onto the list. A `live` for a name already there is that stream again (a restart): its card is refreshed where it stands. */
function apply(frame: ServerFrame): void {
  const list = store.get(homeStreamsAtom);
  if (!list) return;
  if (frame.type === 'live') {
    const card: LiveStream = {
      name: frame.name,
      bio: frame.bio ?? '',
      since: frame.since > 0 ? new Date(frame.since).toISOString() : null,
      verified: frame.verified ?? false,
      avatar: frame.avatar ?? null,
      thumbs: frame.thumbs ?? [],
      viewers: null
    };
    const at = list.findIndex((s) => s.name === frame.name);
    // first on, first shown: a new stream goes to the end
    store.set(homeStreamsAtom, at < 0 ? [...list, card] : list.map((s, i) => (i === at ? card : s)));
  } else if (frame.type === 'ended') {
    if (list.some((s) => s.name === frame.name)) store.set(homeStreamsAtom, list.filter((s) => s.name !== frame.name));
  } else if (frame.type === 'viewers') {
    if (list.some((s) => s.name === frame.name && s.viewers !== frame.viewers)) {
      store.set(
        homeStreamsAtom,
        list.map((s) => (s.name === frame.name ? { ...s, viewers: frame.viewers } : s))
      );
    }
  }
}

// the feed, while a home page is up: the three facts onto the list, held while a snapshot is in
// flight. the socket opening under the page, first time or back after a gap, is a snapshot
// again: facts before it opened never reached this browser (and one in flight as it opened
// may have been served before the subscription, so it is followed by another)
onEvents((event) => {
  if (open === 0) return;
  if (event.type === 'live' || event.type === 'ended' || event.type === 'viewers') {
    if (inflight) inflight.push(event);
    else apply(event);
  } else if (event.type === 'link' && event.phase === 'open') {
    if (inflight) againWhenDone = true;
    else void load();
  }
});
