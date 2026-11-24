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

export function perfBegin(phase: 'press' | 'boot' | 'start', at = performance.now()): void {
  origin = at;
  phases = [];
  printed = false;
  perfMark(phase, at);
}

export function perfMark(phase: string, at = performance.now()): void {
  phases.push([phase, at]);
  try {
    performance.mark(`watch:${phase}`, { startTime: at });
    performance.measure(`watch:${phase}`, { start: origin, end: at });
  } catch {
  }
  if (phase === 'first-frame' && !printed && debugOn()) {
    printed = true;
    console.debug(`[watch perf] ${phases.map(([p, t]) => `${p} ${Math.round(t - origin)}`).join(' · ')} ms`);
  }
}
