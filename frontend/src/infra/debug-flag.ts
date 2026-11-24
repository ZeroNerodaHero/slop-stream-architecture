import type { RunKind } from './debug/rings.ts';

export type DebugSink = (kind: RunKind, label: string, start: number, phases: readonly (readonly [string, number])[]) => void;

export type DebugFeature = 'messages' | 'timings' | 'quality';

export const debug: Record<DebugFeature, boolean> & { sink: DebugSink | null } = { messages: false, timings: false, quality: false, sink: null };

const listeners: Record<DebugFeature, Set<(on: boolean) => void>> = { messages: new Set(), timings: new Set(), quality: new Set() };

export const DEBUG_KEYS: Record<DebugFeature, string> = { messages: 'settings.debugMessages', timings: 'settings.debugTimings', quality: 'settings.debugQuality' };

export function migrateDebugSettings(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>): void {
  const old = storage.getItem('settings.inspector');
  const keys = Object.values(DEBUG_KEYS);
  if (old === null || keys.some((key) => storage.getItem(key) !== null)) return;
  for (const key of keys) storage.setItem(key, JSON.stringify(old === 'true'));
  storage.removeItem('settings.inspector');
}

export function perfDebugOn(): boolean {
  try {
    return new URLSearchParams(location.search).get('perfdebug') === '1' || localStorage.getItem('perfdebug') === '1';
  } catch {
    return false;
  }
}

export function setDebug(feature: DebugFeature, on: boolean, perf = feature === 'timings' && perfDebugOn()): void {
  const next = on || perf;
  if (next === debug[feature]) return;
  debug[feature] = next;
  for (const fn of listeners[feature]) fn(next);
}

export function onDebugChange(feature: DebugFeature, fn: (on: boolean) => void): () => void {
  listeners[feature].add(fn);
  return () => listeners[feature].delete(fn);
}

export function clearPerfEntries(prefix: string): void {
  if (typeof performance === 'undefined' || typeof performance.getEntriesByType !== 'function') return;
  const marks = new Set<string>();
  const measures = new Set<string>();
  for (const e of performance.getEntriesByType('mark')) if (e.name.startsWith(prefix)) marks.add(e.name);
  for (const e of performance.getEntriesByType('measure')) if (e.name.startsWith(prefix)) measures.add(e.name);
  for (const name of marks) performance.clearMarks(name);
  for (const name of measures) performance.clearMeasures(name);
}
