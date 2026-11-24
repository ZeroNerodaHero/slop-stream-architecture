import { clearPerfEntries, debug, onDebugChange, perfDebugOn } from './debug-flag.ts';

let origin = 0;
let phases: [string, number][] = [];
let printed = false;
let sent = false;
let label = '';
const MAX_PHASES = 50;

onDebugChange('timings', (on) => {
  if (on) return;
  phases = [];
  printed = false;
  sent = false;
  label = '';
  clearPerfEntries('watch:');
});

export function watchPerfHeld(): number {
  return phases.length;
}

export function perfBegin(phase: 'press' | 'boot' | 'start', name: string, at = performance.now()): void {
  if (!debug.timings) return;
  origin = at;
  phases = [];
  printed = false;
  sent = false;
  label = name;
  perfMark(phase, at);
}

export function perfMark(phase: string, at = performance.now(), done = phase === 'first-frame-decoded'): void {
  if (!debug.timings) return;
  if (phases.length >= MAX_PHASES) phases.shift();
  phases.push([phase, at]);
  try {
    performance.mark(`watch:${phase}`, { startTime: at });
    performance.measure(`watch:${phase}`, { start: origin, end: at });
  } catch {
  }
  if (phase === 'first-frame' && !printed && perfDebugOn()) {
    printed = true;
    console.debug(`[watch perf] ${phases.map(([p, t]) => `${p} ${Math.round(t - origin)}`).join(' · ')} ms`);
  }
  if (done && !sent) {
    sent = true;
    debug.sink?.('watch', label, origin, phases);
  }
}
