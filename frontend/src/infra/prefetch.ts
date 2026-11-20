/**
 * Page data asked for on the press, not on the page (docs/spec.md "Prefetch on press"). A
 * `pointerdown` on a way to `/`, `/watch/<name>` or `/groups/<server>` asks the api for what
 * that page asks first as it mounts, ~100-200ms before the click and the route get there; the
 * page's loader takes the answer instead of asking again. One path for every way there: a link
 * is seen by the one listener on the document (`installPrefetch`), a button that navigates by
 * hand spreads `usePrefetchOnPointerDown(path)` on itself.
 *
 * Each page's module says what its page asks (`onPrefetch`), beside its own loader, so the two
 * cannot drift. Reads: a press that goes nowhere costs one answer that is dropped after
 * `PREFETCH_TTL_MS`, and a `watch` of the page's topic on the events socket for as long. The
 * watch page's prefetcher also warms its peer and video socket for as long, sending nothing
 * (watch-atoms.ts `warmOnPress`). Nothing written.
 *
 * The topic is watched from the press, as the page would from its mount, so what the socket
 * says about it between the answer and the mount is not lost: a fact that makes the answer
 * old drops it (`drop`, the page asks again), or is kept for the page to apply on top of it
 * (`hold`, home's list). The socket coming back after a gap drops everything, and so does
 * another login: the answer was someone else's.
 */

import { type PointerEvent, useMemo } from 'react';

import { meAtom } from '@/infra/atoms/auth-atoms';
import { holdPresence, onEvents, releasePresence } from '@/infra/events';
import { groupTopic, type ServerFrame } from '@/infra/frames';
import { cleanName, isValidName } from '@/infra/names';
import { store } from '@/infra/store';

/** How long an answer nobody took is kept. Past it the page asks for itself. */
export const PREFETCH_TTL_MS = 5000;

/** The pages asked for on the press, and the name in their path ('' for home). */
export type PrefetchRoute = { kind: 'home'; name: '' } | { kind: 'watch'; name: string } | { kind: 'group'; name: string };

/** `/`, `/watch/<name>`, `/groups/<server>` or `/groups/<server>/<channel>`, as the router reads them. Null for any other path. */
export function prefetchRouteOf(path: string): PrefetchRoute | null {
  const parts = (path.split(/[?#]/)[0] ?? '').split('/').filter(Boolean);
  let decoded: string[];
  try {
    decoded = parts.map(decodeURIComponent);
  } catch {
    return null;
  }
  const [page, name, channel, ...rest] = decoded;
  if (page === undefined) return { kind: 'home', name: '' };
  if (name === undefined || rest.length > 0) return null;
  if (page === 'watch' && channel === undefined) {
    const clean = cleanName(name);
    return isValidName(clean) ? { kind: 'watch', name: clean } : null;
  }
  if (page === 'groups') return isValidName(name) && name !== 'bot' ? { kind: 'group', name } : null;
  return null;
}

const prefetchers = new Map<PrefetchRoute['kind'], (name: string) => void>();

/** What a page asks first, said by the page's own module. The function asks through `prefetch`, and does nothing when the page is up already or would ask nothing. */
export function onPrefetch(kind: PrefetchRoute['kind'], prefetcher: (name: string) => void): void {
  prefetchers.set(kind, prefetcher);
}

/**
 * A press on a way to `path`: what that page asks first, now. Nothing for a path that is not
 * one of the three, nor for the page already on screen (another channel of the same group is
 * the same page: it asks nothing).
 */
export function prefetchRoute(path: string): void {
  const route = prefetchRouteOf(path);
  if (!route) return;
  const here = prefetchRouteOf(location.pathname);
  if (here && here.kind === route.kind && here.name === route.name) return;
  // a group's page is a chunk of its own (router.tsx): asked for beside its data. a failure is
  // the router's to show when the route asks again
  if (route.kind === 'group') loadServerPage().catch(() => undefined);
  prefetchers.get(route.kind)?.(route.name);
}

/** The group page's chunk. The router loads it from here too, so a press and the route share one download. */
export const loadServerPage = () => import('@/app/explore/ServerRoom');

interface Entry {
  answer: Promise<unknown>;
  ask: () => Promise<unknown>;
  topic: string | null;
  onFact: 'drop' | 'hold';
  frames: ServerFrame[];
  me: string | null | undefined;
  timer: ReturnType<typeof setTimeout>;
}

const entries = new Map<string, Entry>();

function drop(key: string): void {
  const entry = entries.get(key);
  if (!entry) return;
  entries.delete(key);
  clearTimeout(entry.timer);
  if (entry.topic !== null) releasePresence(entry.topic);
}

/**
 * Ask now, for the page to take: `key` names the request exactly (the page's loader takes it by
 * the same key), `topic` is the events socket's watch the page holds (null: a list nothing
 * pushes, asked again on its own cadence), `onFact` what a fact about it does to the answer
 * meanwhile. A key already in flight is not asked twice.
 */
export function prefetch<T>(key: string, topic: string | null, onFact: 'drop' | 'hold', ask: () => Promise<T>): void {
  if (entries.has(key)) return;
  // the topic before the ask, as the pages do: a fact that lands after the answer was served is on the socket
  if (topic !== null) holdPresence(topic);
  const answer = ask();
  const entry: Entry = { answer, ask, topic, onFact, frames: [], me: store.get(meAtom), timer: setTimeout(() => drop(key), PREFETCH_TTL_MS) };
  entries.set(key, entry);
  // a failed one is gone at once: the page asks for itself
  answer.catch(() => {
    if (entries.get(key) === entry) drop(key);
  });
}

/**
 * The answer asked for on the press, once: the next take of `key` is a miss. `frames` are the
 * facts about the topic since (a `hold` prefetch's), for the page to apply on top. Null when
 * nothing fresh is there, then the page asks as it always did. Call it after the page has
 * watched the topic itself, so letting go of the press's watch leaves it on the socket.
 */
export function takePrefetched<T>(key: string): { answer: Promise<T>; frames: ServerFrame[] } | null {
  const entry = entries.get(key);
  if (!entry) return null;
  drop(key);
  if (entry.me !== store.get(meAtom)) return null;
  // an answer that failed between the check and the await: the page's own ask, as on a miss
  const answer = entry.answer.catch(() => entry.ask()) as Promise<T>;
  return { answer, frames: entry.frames };
}

/** Whether `frame` is a fact about `topic` that a page's first answer is behind on. */
function concerns(topic: string, frame: ServerFrame): boolean {
  if (topic === '*') return frame.type === 'live' || frame.type === 'ended' || frame.type === 'viewers';
  if (frame.type === 'group') return groupTopic(frame.group) === topic;
  return (frame.type === 'live' || frame.type === 'ended' || frame.type === 'renamed') && frame.name === topic;
}

onEvents((event) => {
  if (entries.size === 0) return;
  if (event.type === 'link') {
    // back after a gap (or a first open): the facts of the gap never came, the answers may be behind them
    if (event.phase === 'open') for (const key of entries.keys()) drop(key);
    return;
  }
  for (const [key, entry] of entries) {
    if (entry.topic === null || !concerns(entry.topic, event)) continue;
    if (entry.onFact === 'drop') drop(key);
    else entry.frames.push(event);
  }
});

/** A press that is a click to follow here: the main button, a finger or a pen; not one that opens another tab or window. */
function isPlainPress(e: { button: number; pointerType: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }): boolean {
  if (e.pointerType === 'mouse' && e.button !== 0) return false;
  return !e.metaKey && !e.ctrlKey && !e.shiftKey;
}

/**
 * The one listener for links: a press on an `<a href>` (react router's `Link`) to one of the
 * three pages, this origin, this tab, asks for its data. A link that does something else on
 * the click says `data-prefetch="off"` (ProfileLink.tsx with the popup on). Call once.
 */
export function installPrefetch(): void {
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (!isPlainPress(e) || !(e.target instanceof Element)) return;
      const a = e.target.closest('a[href]');
      if (!(a instanceof HTMLAnchorElement) || a.dataset.prefetch === 'off' || a.hasAttribute('download')) return;
      if (a.target && a.target !== '_self') return;
      if (a.origin !== location.origin) return;
      prefetchRoute(a.pathname);
    },
    { capture: true, passive: true }
  );
}

/** For a button that navigates to `path` by hand: spread on it, and its press asks for the page's data the way a link's does. `null` for none. */
export function usePrefetchOnPointerDown(path: string | null): { onPointerDown?: (e: PointerEvent) => void } {
  return useMemo(
    () =>
      path === null
        ? {}
        : {
            onPointerDown: (e: PointerEvent) => {
              if (isPlainPress(e)) prefetchRoute(path);
            }
          },
    [path]
  );
}
