/**
 * The watch page's startup, phase by phase, on the performance timeline (docs/debugging.md
 * "Watch startup timings"). Every phase is a `watch:<phase>` mark and a `watch:<phase>`
 * measure from the origin: the press on a link when the attempt took the peer warmed on it,
 * the boot when the attempt took index.html's boot script's (a stream's page loaded straight), else
 * the attempt's start. Phases: press or boot, start, grant, peer, offer, ws-open, setup-sent,
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

/** A new timeline from `phase` (`press`, `boot` or `start`), now or at `at`: the phases after it are measured from there. */
export function perfBegin(phase: 'press' | 'boot' | 'start', at = performance.now()): void {
  origin = at;
  phases = [];
  printed = false;
  perfMark(phase, at);
}

/** `phase` happened now, or at `at` (the boot script's, seen once the bundle is here). The first frame prints the line, once, when the debug flag is on. */
export function perfMark(phase: string, at = performance.now()): void {
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
