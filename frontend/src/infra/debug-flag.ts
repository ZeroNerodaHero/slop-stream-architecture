import type { RunKind } from './debug/rings.ts';

export type DebugSink = (kind: RunKind, label: string, start: number, phases: readonly (readonly [string, number])[]) => void;

export const debug: { on: boolean; inspector: boolean; sink: DebugSink | null } = { on: false, inspector: false, sink: null };

const listeners = new Set<(on: boolean) => void>();

export function perfDebugOn(): boolean {
  try {
    return new URLSearchParams(location.search).get('perfdebug') === '1' || localStorage.getItem('perfdebug') === '1';
  } catch {
    return false;
  }
}

export function setDebug(inspector: boolean, perf = perfDebugOn()): void {
  const on = inspector || perf;
  const changed = on !== debug.on;
  debug.inspector = inspector;
  debug.on = on;
  if (changed) for (const fn of listeners) fn(on);
}

export function onDebugChange(fn: (on: boolean) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
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
