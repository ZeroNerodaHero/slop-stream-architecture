import { clearPerfEntries, debug, onDebugChange, perfDebugOn } from '../debug-flag.ts';
import { PEEK_TTL_MS } from './refs.ts';

type Phase = 'press' | 'mount' | 'subbed' | 'history' | 'first-line';

interface Run {
  at: number;
  phases: [Phase, number][];
  printed: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

const MAX_HELD = 50;
const SETTLE_MS = 10_000;
const runs = new Map<string, Run>();
const says = new Map<string, [number, string]>();

onDebugChange('timings', (on) => {
  if (on) return;
  for (const run of runs.values()) clearTimeout(run.timer);
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

function finish(topic: string, run: Run): void {
  clearTimeout(run.timer);
  if (run.printed) return;
  run.printed = true;
  if (runs.get(topic) === run) runs.delete(topic);
  if (perfDebugOn()) console.debug(`[rt perf] ${topic} ${run.phases.map(([p, t]) => `${p} ${Math.round(t - run.at)}`).join(' · ')} ms`);
  debug.sink?.('chat', topic, run.at, run.phases);
}

export function rtPerfBegin(topic: string, phase: 'press' | 'mount', at = performance.now()): void {
  if (!debug.timings) return;
  const run = runs.get(topic);
  if (phase === 'mount' && run && !run.printed && at - run.at < PEEK_TTL_MS) {
    rtPerfMark(topic, 'mount', at);
    return;
  }
  if (run) clearTimeout(run.timer);
  hold(runs, topic, { at, phases: [[phase, at]], printed: false });
  mark(`rt:${topic}:${phase}`, at);
}

export function rtPerfMark(topic: string, phase: Exclude<Phase, 'press'>, at = performance.now()): void {
  if (!debug.timings) return;
  const run = runs.get(topic);
  if (!run || run.printed || run.phases.some(([p]) => p === phase)) return;
  run.phases.push([phase, at]);
  mark(`rt:${topic}:${phase}`, at, run.at);
  if (run.phases.filter(([p]) => p === 'subbed' || p === 'history' || p === 'first-line').length === 3) finish(topic, run);
  else if (phase === 'subbed') run.timer = setTimeout(() => finish(topic, run), SETTLE_MS);
}

export function rtPerfSay(key: string, at = performance.now(), label = ''): void {
  if (!debug.timings) return;
  hold(says, key, [at, label]);
  mark(`rt:say:${key}`, at);
}

export function rtPerfAnswer(key: string, ok: boolean, at = performance.now()): void {
  if (!debug.timings) return;
  const said = says.get(key);
  says.delete(key);
  if (!said) return;
  const [start, label] = said;
  const phase = ok ? 'ack' : 'nack';
  mark(`rt:${phase}:${key}`, at, start);
  if (perfDebugOn()) console.debug(`[rt perf] say ${phase} ${Math.round(at - start)} ms`);
  debug.sink?.('say', label, start, [
    ['say', start],
    [phase, at]
  ]);
}
