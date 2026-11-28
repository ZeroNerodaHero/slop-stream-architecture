import { atom } from 'jotai';

import { api, type Explore, type LiveStream, messageOf } from '@/infra/api';
import { onEvents, unwatchPresence, watchPresence } from '@/infra/events';
import type { ServerFrame } from '@/infra/frames';
import { onPrefetch, prefetch, PREFETCH_TTL_MS, takePrefetched } from '@/infra/prefetch';
import { store } from '@/infra/store';

export const homeStreamsAtom = atom<LiveStream[] | null>(null);
export const homeErrorAtom = atom('');
export const homeNowAtom = atom(Date.now());

const RETRY_FIRST_MS = 3000;
const RETRY_MAX_MS = 60_000;
const EVERYONE = '*';

let open = 0;
let attempt = 0;
let failures = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let clock: ReturnType<typeof setInterval> | null = null;
let inflight: ServerFrame[] | null = null;
let againWhenDone = false;

function startClock(): void {
  if (clock) return;
  store.set(homeNowAtom, Date.now());
  clock = setInterval(() => store.set(homeNowAtom, Date.now()), 1000);
}

function stopClock(): void {
  if (clock) clearInterval(clock);
  clock = null;
}

function onVisibility(): void {
  if (open === 0) return;
  if (document.hidden) stopClock();
  else startClock();
}

export function enterHome(): void {
  open++;
  if (open > 1) return;
  watchPresence(EVERYONE);
  if (!document.hidden) startClock();
  document.addEventListener('visibilitychange', onVisibility);
  void load();
}

export function leaveHome(): void {
  open--;
  if (open > 0) return;
  attempt++;
  inflight = null;
  againWhenDone = false;
  failures = 0;
  unwatchPresence(EVERYONE);
  document.removeEventListener('visibilitychange', onVisibility);
  stopClock();
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
}

const SNAPSHOT = 'home:streams';

declare global {
  interface Window {
    __bootStreams?: { born: number; response: Promise<Response> };
  }
}

function takeBootStreams(): Promise<LiveStream[]> | null {
  const boot = window.__bootStreams;
  if (!boot) return null;
  delete window.__bootStreams;
  if (performance.now() - boot.born > PREFETCH_TTL_MS) return null;
  return api.streamsAsked(boot.response).catch(() => api.streams());
}

export const homeGroups = () => takePrefetched<Explore>('home:explore')?.answer ?? api.explore();

onPrefetch('home', () => {
  if (open > 0) return;
  prefetch(SNAPSHOT, EVERYONE, 'hold', () => api.streams());
  prefetch('home:explore', null, 'drop', () => api.explore());
});

async function load(): Promise<void> {
  const mine = ++attempt;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  const pressed = takePrefetched<LiveStream[]>(SNAPSHOT);
  const booted = pressed ? null : takeBootStreams();
  inflight = pressed ? [...pressed.frames] : [];
  let list: LiveStream[];
  try {
    list = await (pressed?.answer ?? booted ?? api.streams());
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
      viewers: null,
      badge: frame.badge ?? null
    };
    const at = list.findIndex((s) => s.name === frame.name);
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
