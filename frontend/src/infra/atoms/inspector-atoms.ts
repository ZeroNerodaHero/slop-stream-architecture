import { type Atom, atom } from 'jotai';

import { type FrameEntry, makeEntry, Ring } from '@/infra/frames';
import { messagesEnabledAtom, qualityEnabledAtom, timingsEnabledAtom } from '@/infra/atoms/settings-atoms';
import { debug, type DebugFeature, onDebugChange, setDebug } from '@/infra/debug-flag';
import { parseWindows, pick, restoreOpen, serialize, WINDOW_IDS, WINDOWS_KEY } from '@/infra/debug/window-open';
import { store } from '@/infra/store';

export const FRAME_DIRS = ['in', 'out', 'link'] as const;

export const inspectorOpenAtom = atom(false);
export const timingsOpenAtom = atom(false);
export const qualityOpenAtom = atom(false);
export const inspectorPausedAtom = atom(false);
export const inspectorFrozenAtom = atom<{ rows: FrameEntry[]; count: number } | null>(null);
export const inspectorFilterAtom = atom('');
export const inspectorDirsAtom = atom<ReadonlySet<FrameEntry['dir']>>(new Set(FRAME_DIRS));
export const framesTickAtom = atom(0);

let ring: Ring | null = null;

let forward: ((entry: FrameEntry) => void) | null = null;
let askClear: (() => void) | null = null;
let tickPending = false;

function tick() {
  if (tickPending) return;
  tickPending = true;
  const bump = () => {
    tickPending = false;
    store.set(framesTickAtom, (n) => n + 1);
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(bump);
  else setTimeout(bump, 16);
}

export function record(source: string, dir: FrameEntry['dir'], frame: unknown): void {
  if (!debug.messages) return;
  const entry = makeEntry(source, dir, frame);
  if (forward) forward(entry);
  else keep(entry);
}

export function frameRing(): Ring | null {
  return ring;
}

export function keep(entry: FrameEntry): void {
  if (!debug.messages) return;
  (ring ??= new Ring()).push(entry);
  tick();
}

export function replaceEntries(entries: FrameEntry[]): void {
  if (!debug.messages) return;
  ring?.clear();
  for (const e of entries) (ring ??= new Ring()).push(e);
  tick();
}

export function clearFrames(): void {
  ring?.clear();
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

export function openTimings() {
  store.set(timingsOpenAtom, true);
}

export function closeTimings() {
  store.set(timingsOpenAtom, false);
}

export function openQuality() {
  store.set(qualityOpenAtom, true);
}

export function closeQuality() {
  store.set(qualityOpenAtom, false);
}

export function toggleInspectorPaused() {
  const paused = !store.get(inspectorPausedAtom);
  store.set(inspectorPausedAtom, paused);
  store.set(inspectorFrozenAtom, paused ? { rows: shownEntries(store.get(inspectorFilterAtom), store.get(inspectorDirsAtom)), count: ring?.count ?? 0 } : null);
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
  if (!ring) return out;
  for (let i = ring.count - 1; i >= 0; i--) {
    const e = ring.at(i);
    if (!e || !dirs.has(e.dir)) continue;
    if (needle && !e.text.toLowerCase().includes(needle) && !e.source.includes(needle) && !e.type.toLowerCase().includes(needle)) continue;
    out.push(e);
  }
  return out;
}

function dropFrames() {
  ring?.clear();
  ring = null;
  store.set(inspectorPausedAtom, false);
  store.set(inspectorFrozenAtom, null);
  store.set(inspectorFilterAtom, '');
  store.set(inspectorOpenAtom, false);
  tick();
}

type Collect = typeof import('@/infra/debug/collect');

let collect: Promise<Collect> | null = null;

function collector(feature: 'timings' | 'quality', start: (m: Collect) => void, stop: (m: Collect) => void) {
  onDebugChange(feature, (on) => {
    if (!on) {
      void collect?.then(stop, () => undefined);
      return;
    }
    collect ??= import('@/infra/debug/collect');
    void collect.then(
      (m) => {
        if (debug[feature]) start(m);
      },
      () => {
        collect = null;
      }
    );
  });
}

collector(
  'timings',
  (m) => m.startTimings(),
  (m) => m.stopTimings()
);
collector(
  'quality',
  (m) => m.startQuality(),
  (m) => m.stopQuality()
);

function follow(enabled: Atom<boolean>, feature: DebugFeature, off: () => void) {
  setDebug(feature, store.get(enabled));
  store.sub(enabled, () => {
    const on = store.get(enabled);
    setDebug(feature, on);
    if (!on) off();
  });
}

follow(messagesEnabledAtom, 'messages', dropFrames);
follow(timingsEnabledAtom, 'timings', closeTimings);
follow(qualityEnabledAtom, 'quality', closeQuality);

const OPEN = { messages: inspectorOpenAtom, timings: timingsOpenAtom, quality: qualityOpenAtom };

function saveOpen() {
  try {
    localStorage.setItem(WINDOWS_KEY, serialize(pick((id) => store.get(OPEN[id]))));
  } catch {
  }
}

try {
  const open = restoreOpen(parseWindows(localStorage.getItem(WINDOWS_KEY)), debug);
  for (const id of WINDOW_IDS) {
    store.set(OPEN[id], open[id]);
    store.sub(OPEN[id], saveOpen);
  }
} catch {
}
saveOpen();
