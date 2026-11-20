/**
 * The watch page's startup, phase by phase, on the performance timeline (docs/debugging.md
 * "Watch startup timings"). Every phase is a `watch:<phase>` mark and a `watch:<phase>`
 * measure from the origin: the press on a link when the attempt took the peer warmed on it,
 * else the attempt's start. Phases: press, start, grant, peer, offer, ws-open, setup-sent,
 * answer, ice-connected, first-frame.
 *
 * With `?perfdebug=1` in the url, or `localStorage.perfdebug = '1'`, the first frame prints the
 * whole line with `console.debug`. Off, the marks are still there for devtools' performance
 * panel and for watchperf's measure script; nothing is printed.
 */

let origin = 0;
let phases: [string, number][] = [];
let printed = false;

function debugOn(): boolean {
  try {
    return new URLSearchParams(location.search).get('perfdebug') === '1' || localStorage.getItem('perfdebug') === '1';
  } catch {
    return false;
  }
}

/** A new timeline from `phase` (`press` or `start`): the phases after it are measured from here. */
export function perfBegin(phase: 'press' | 'start'): void {
  origin = performance.now();
  phases = [];
  printed = false;
  perfMark(phase);
}

/** `phase` happened now. The first frame prints the line, once, when the debug flag is on. */
export function perfMark(phase: string): void {
  const at = performance.now();
  phases.push([phase, at]);
  try {
    performance.mark(`watch:${phase}`, { startTime: at });
    performance.measure(`watch:${phase}`, { start: origin, end: at });
  } catch {
    // an old browser without the options form: the console line still has it
  }
  if (phase === 'first-frame' && !printed && debugOn()) {
    printed = true;
    console.debug(`[watch perf] ${phases.map(([p, t]) => `${p} ${Math.round(t - origin)}`).join(' · ')} ms`);
  }
}
