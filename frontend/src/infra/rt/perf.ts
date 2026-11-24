import { clearPerfEntries, debug, onDebugChange, perfDebugOn } from '../debug-flag.ts';
import { PEEK_TTL_MS } from './refs.ts';

type Phase = 'press' | 'mount' | 'subbed' | 'history';

interface Run {
  at: number;
  phases: [Phase, number][];
  printed: boolean;
}

const MAX_HELD = 50;
const runs = new Map<string, Run>();
const says = new Map<string, number>();

onDebugChange((on) => {
  if (on) return;
  runs.clear();
  says.clear();
  clearPerfEntries('rt:');
});

export function rtPerfHeld(): { runs: number; says: number } {
  return { runs: runs.size, says: says.size };
}

function hold<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  if (map.size >= MAX_HELD) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

function mark(name: string, at: number, start?: number): void {
  try {
    performance.mark(name, { startTime: at });
    if (start !== undefined) performance.measure(name, { start, end: at });
  } catch {
    return;
  }
}

export function rtPerfBegin(topic: string, phase: 'press' | 'mount', at = performance.now()): void {
  if (!debug.on) return;
  const run = runs.get(topic);
  if (phase === 'mount' && run && !run.printed && at - run.at < PEEK_TTL_MS) {
    rtPerfMark(topic, 'mount', at);
    return;
  }
  hold(runs, topic, { at, phases: [[phase, at]], printed: false });
  mark(`rt:${topic}:${phase}`, at);
}

export function rtPerfMark(topic: string, phase: Exclude<Phase, 'press'>, at = performance.now()): void {
  if (!debug.on) return;
  const run = runs.get(topic);
  if (!run || run.printed || run.phases.some(([p]) => p === phase)) return;
  run.phases.push([phase, at]);
  mark(`rt:${topic}:${phase}`, at, run.at);
  const done = run.phases.some(([p]) => p === 'subbed') && run.phases.some(([p]) => p === 'history');
  if (!done) return;
  run.printed = true;
  runs.delete(topic);
  if (perfDebugOn()) console.debug(`[rt perf] ${topic} ${run.phases.map(([p, t]) => `${p} ${Math.round(t - run.at)}`).join(' · ')} ms`);
}

export function rtPerfSay(key: string, at = performance.now()): void {
  if (!debug.on) return;
  hold(says, key, at);
  mark(`rt:say:${key}`, at);
}

export function rtPerfAnswer(key: string, ok: boolean, at = performance.now()): void {
  if (!debug.on) return;
  const start = says.get(key);
  says.delete(key);
  if (start === undefined) return;
  const phase = ok ? 'ack' : 'nack';
  mark(`rt:${phase}:${key}`, at, start);
  if (perfDebugOn()) console.debug(`[rt perf] say ${phase} ${Math.round(at - start)} ms`);
}
