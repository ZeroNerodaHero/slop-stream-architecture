import { type PointerEvent, useMemo } from 'react';

import { meAtom } from '@/infra/atoms/auth-atoms';
import { holdPresence, onEvents, releasePresence } from '@/infra/events';
import { groupTopic, type ServerFrame } from '@/infra/frames';
import { cleanName, isValidName } from '@/infra/names';
import { store } from '@/infra/store';

export const PREFETCH_TTL_MS = 5000;

export type PrefetchRoute = { kind: 'home'; name: '' } | { kind: 'watch'; name: string } | { kind: 'group'; name: string };

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

export function onPrefetch(kind: PrefetchRoute['kind'], prefetcher: (name: string) => void): void {
  prefetchers.set(kind, prefetcher);
}

function isHere(route: PrefetchRoute): boolean {
  const here = prefetchRouteOf(location.pathname);
  return here !== null && here.kind === route.kind && here.name === route.name;
}

export function prefetchRoute(path: string): void {
  const route = prefetchRouteOf(path);
  if (!route || isHere(route)) return;
  pageLoaders[route.kind]().catch(() => undefined);
  const prefetcher = prefetchers.get(route.kind);
  if (prefetcher) prefetcher(route.name);
  else
    prefetcherLoaders[route.kind]().then(
      () => {
        if (!isHere(route)) prefetchers.get(route.kind)?.(route.name);
      },
      () => undefined
    );
}

export const loadServerPage = () => import('@/app/explore/ServerRoom');
export const loadHomePage = () => import('@/app/home/HomePage');
export const loadWatchPage = () => import('@/app/watch/WatchPage');

const pageLoaders: Record<PrefetchRoute['kind'], () => Promise<unknown>> = { home: loadHomePage, watch: loadWatchPage, group: loadServerPage };
const prefetcherLoaders: Record<PrefetchRoute['kind'], () => Promise<unknown>> = {
  home: () => import('@/infra/atoms/home-atoms'),
  watch: () => import('@/infra/atoms/watch-atoms'),
  group: () => import('@/infra/atoms/room-atoms')
};

export function loadFirstPage(): Promise<unknown> | null {
  const route = prefetchRouteOf(location.pathname);
  return route ? pageLoaders[route.kind]() : null;
}

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

export function prefetch<T>(key: string, topic: string | null, onFact: 'drop' | 'hold', ask: () => Promise<T>): void {
  if (entries.has(key)) return;
  if (topic !== null) holdPresence(topic);
  const answer = ask();
  const entry: Entry = { answer, ask, topic, onFact, frames: [], me: store.get(meAtom), timer: setTimeout(() => drop(key), PREFETCH_TTL_MS) };
  entries.set(key, entry);
  answer.catch(() => {
    if (entries.get(key) === entry) drop(key);
  });
}

export function takePrefetched<T>(key: string): { answer: Promise<T>; frames: ServerFrame[] } | null {
  const entry = entries.get(key);
  if (!entry) return null;
  drop(key);
  if (entry.me !== store.get(meAtom)) return null;
  const answer = entry.answer.catch(() => entry.ask()) as Promise<T>;
  return { answer, frames: entry.frames };
}

function concerns(topic: string, frame: ServerFrame): boolean {
  if (topic === '*') return frame.type === 'live' || frame.type === 'ended' || frame.type === 'viewers';
  if (frame.type === 'group') return groupTopic(frame.group) === topic;
  return (frame.type === 'live' || frame.type === 'ended' || frame.type === 'renamed') && frame.name === topic;
}

onEvents((event) => {
  if (entries.size === 0) return;
  if (event.type === 'link') {
    if (event.phase === 'open') for (const key of entries.keys()) drop(key);
    return;
  }
  for (const [key, entry] of entries) {
    if (entry.topic === null || !concerns(entry.topic, event)) continue;
    if (entry.onFact === 'drop') drop(key);
    else entry.frames.push(event);
  }
});

function isPlainPress(e: { button: number; pointerType: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }): boolean {
  if (e.pointerType === 'mouse' && e.button !== 0) return false;
  return !e.metaKey && !e.ctrlKey && !e.shiftKey;
}

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
