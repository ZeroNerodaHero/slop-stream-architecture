/**
 * The messages inspector: the frames this browser sent and received, on all three sockets
 * (`/events`, `/chat/<name>`, `/ws`), the last 1000 in a ring, with a filter. The ring is a
 * module handle (frames.ts), never an atom; `framesTickAtom` says it changed, once per frame
 * of animation, and the panel reads the ring directly. Where the events worker holds the
 * socket it also holds the ring (every tab sees the same 1000, a tab opened later gets
 * history); this tab mirrors it. Without a worker the ring here is the one. See docs/status.md.
 */

import { atom } from 'jotai';

import { type FrameEntry, makeEntry, Ring } from '@/infra/frames';
import { inspectorEnabledAtom } from '@/infra/atoms/settings-atoms';
import { store } from '@/infra/store';

export const FRAME_DIRS = ['in', 'out', 'link'] as const;

export const inspectorOpenAtom = atom(false);
/** Freezes the view, never the recorder. */
export const inspectorPausedAtom = atom(false);
/** The rows as they were when the pause began, and how many the ring held then. `null` while not paused. */
export const inspectorFrozenAtom = atom<{ rows: FrameEntry[]; count: number } | null>(null);
export const inspectorFilterAtom = atom('');
/** Which directions show. */
export const inspectorDirsAtom = atom<ReadonlySet<FrameEntry['dir']>>(new Set(FRAME_DIRS));
/** Bumped when the ring changed. Components read `ring` when it moves. */
export const framesTickAtom = atom(0);

/** The ring this tab renders from. The worker's mirror, or the only one. */
export const ring = new Ring();

/** Set by events.ts when a worker holds the socket: entries go there, and come back as the tail. */
let forward: ((entry: FrameEntry) => void) | null = null;
let askClear: (() => void) | null = null;
let tickPending = false;

/** One bump per animation frame, however many frames came in it. */
function tick() {
  if (tickPending) return;
  tickPending = true;
  const bump = () => {
    tickPending = false;
    store.set(framesTickAtom, ring.version);
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(bump);
  else setTimeout(bump, 16);
}

/**
 * A frame of this tab's own sockets (the chat, the video setup). One boolean when the inspector
 * is off. The `/events` frames are recorded where the socket is: in the worker, or by the
 * fallback link, which calls `keep` directly.
 */
export function record(source: string, dir: FrameEntry['dir'], frame: unknown): void {
  if (!store.get(inspectorEnabledAtom)) return;
  const entry = makeEntry(source, dir, frame);
  if (forward) forward(entry);
  else keep(entry);
}

/** Into this tab's ring: the worker's tail, or a frame recorded here. */
export function keep(entry: FrameEntry): void {
  ring.push(entry);
  tick();
}

/** The worker's whole ring, replacing what this tab had. */
export function replaceEntries(entries: FrameEntry[]): void {
  ring.clear();
  for (const e of entries) ring.push(e);
  tick();
}

export function clearFrames(): void {
  ring.clear();
  tick();
  askClear?.();
}

/** events.ts hands over the worker's port, so recording and clearing go through it. */
export function bindInspectorToWorker(send: (entry: FrameEntry) => void, clear: () => void): void {
  forward = send;
  askClear = clear;
}

export function unbindInspector(): void {
  forward = null;
  askClear = null;
}

export function openInspector() {
  store.set(inspectorOpenAtom, true);
}

export function closeInspector() {
  store.set(inspectorOpenAtom, false);
}

/** The pause is the moment: the rows through the filter and toggles as they are now, held until resume. */
export function toggleInspectorPaused() {
  const paused = !store.get(inspectorPausedAtom);
  store.set(inspectorPausedAtom, paused);
  store.set(inspectorFrozenAtom, paused ? { rows: shownEntries(store.get(inspectorFilterAtom), store.get(inspectorDirsAtom)), count: ring.count } : null);
}

export function setInspectorFilter(text: string) {
  store.set(inspectorFilterAtom, text);
}

export function toggleInspectorDir(dir: FrameEntry['dir']) {
  const next = new Set(store.get(inspectorDirsAtom));
  if (!next.delete(dir)) next.add(dir);
  store.set(inspectorDirsAtom, next);
}

/** The entries the panel shows, oldest first: the ring through the filter and the direction toggles. */
export function shownEntries(filter: string, dirs: ReadonlySet<FrameEntry['dir']>): FrameEntry[] {
  const needle = filter.trim().toLowerCase();
  const out: FrameEntry[] = [];
  for (let i = ring.count - 1; i >= 0; i--) {
    const e = ring.at(i);
    if (!e || !dirs.has(e.dir)) continue;
    if (needle && !e.text.toLowerCase().includes(needle) && !e.source.includes(needle) && !e.type.toLowerCase().includes(needle)) continue;
    out.push(e);
  }
  return out;
}
