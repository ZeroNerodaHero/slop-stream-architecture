import { atom } from 'jotai';

import { type FrameEntry, makeEntry, Ring } from '@/infra/frames';
import { inspectorEnabledAtom } from '@/infra/atoms/settings-atoms';
import { store } from '@/infra/store';

export const FRAME_DIRS = ['in', 'out', 'link'] as const;

export const inspectorOpenAtom = atom(false);
export const inspectorPausedAtom = atom(false);
export const inspectorFrozenAtom = atom<{ rows: FrameEntry[]; count: number } | null>(null);
export const inspectorFilterAtom = atom('');
export const inspectorDirsAtom = atom<ReadonlySet<FrameEntry['dir']>>(new Set(FRAME_DIRS));
export const framesTickAtom = atom(0);

export const ring = new Ring();

let forward: ((entry: FrameEntry) => void) | null = null;
let askClear: (() => void) | null = null;
let tickPending = false;

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

export function record(source: string, dir: FrameEntry['dir'], frame: unknown): void {
  if (!store.get(inspectorEnabledAtom)) return;
  const entry = makeEntry(source, dir, frame);
  if (forward) forward(entry);
  else keep(entry);
}

export function keep(entry: FrameEntry): void {
  ring.push(entry);
  tick();
}

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
