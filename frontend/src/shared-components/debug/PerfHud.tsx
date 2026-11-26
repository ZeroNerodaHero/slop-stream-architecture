import { createElement, type ReactNode, useEffect, useState } from 'react';

import { watchStatsAtom } from '@/infra/atoms/watch-atoms';
import {
  type PerfDeps,
  PerfHistory,
  type PerfObserverCtor,
  type PerfSeries,
  type PerfSnapshot,
  PerfSampler,
  type PressureCtor,
  rangeOf,
  sparkLines
} from '@/infra/debug/perf-hud';
import type { PerfMode } from '@/infra/debug-flag';
import { store } from '@/infra/store';
import { cn } from '@/utils/cn';

function browserDeps(): PerfDeps {
  const host = globalThis as typeof globalThis & { PressureObserver?: PressureCtor };
  const perf = performance as Performance & { memory?: { usedJSHeapSize?: number } };
  return {
    raf: (fn) => requestAnimationFrame(fn),
    cancelRaf: (id) => cancelAnimationFrame(id),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (id) => clearInterval(id as ReturnType<typeof setInterval>),
    now: () => performance.now(),
    Observer: typeof PerformanceObserver === 'function' ? (PerformanceObserver as unknown as PerfObserverCtor) : null,
    memory: () => {
      const used = perf.memory?.usedJSHeapSize;
      return typeof used === 'number' ? used : null;
    },
    Pressure: typeof host.PressureObserver === 'function' ? host.PressureObserver : null,
    stats: (fn) => {
      const push = () => fn(store.get(watchStatsAtom)?.video.bitrate ?? null);
      push();
      return store.sub(watchStatsAtom, push);
    }
  };
}

type Tone = 'good' | 'bad' | null;
type Part = readonly [label: string, value: string, tone?: Tone];

const TONE = { good: 'text-increase', bad: 'text-decrease' } as const;
const DASH = '—';

function linesOf(snap: PerfSnapshot | null): Part[][] {
  if (!snap)
    return [
      [['fps', DASH]],
      [['lag', DASH]],
      [['mem', DASH]],
      [
        ['down', DASH],
        ['total', DASH]
      ]
    ];
  const cpu: Part[] = [];
  if (snap.busy !== null) cpu.push(['cpu busy', `${Math.round(snap.busy * 100)}%`, snap.busy >= 0.5 ? 'bad' : null]);
  cpu.push(['lag', `${snap.lagMs}ms`, snap.lagMs >= 50 ? 'bad' : null]);
  if (snap.pressure) cpu.push(['pressure', snap.pressure, snap.pressure === 'serious' || snap.pressure === 'critical' ? 'bad' : null]);
  const net: Part[] = [
    ['down', `${snap.downKBps.toFixed(1)} KB/s`],
    ['total', `${snap.totalMb.toFixed(1)} MB`]
  ];
  if (snap.videoKbps !== null) net.push(['video', `${snap.videoKbps} kbps`]);
  return [
    [['fps', String(snap.fps), snap.fps >= 50 ? 'good' : snap.fps < 30 ? 'bad' : null]],
    cpu,
    [['mem', snap.memoryMb === null ? DASH : `${snap.memoryMb.toFixed(1)} MB`]],
    net
  ];
}

function partsOf(parts: Part[]) {
  const out: ReactNode[] = [];
  parts.forEach(([label, value, tone], i) => {
    if (i > 0) out.push(' · ');
    out.push(
      createElement('span', { key: `l${i}`, className: 'text-textTertiary' }, label),
      ' ',
      createElement('span', { key: `v${i}`, className: tone ? TONE[tone] : 'text-textPrimary' }, value)
    );
  });
  return out;
}

function line(parts: Part[], key: number) {
  return createElement('div', { key }, ...partsOf(parts));
}

const GRAPH_W = 96;
const GRAPH_H = 18;

type Graph = readonly [series: PerfSeries, className: string, caption?: string];

function toneClass(tone: Tone | undefined, fallback: string): string {
  return tone ? TONE[tone] : fallback;
}

function graphsOf(snap: PerfSnapshot | null, lines: Part[][]): Graph[][] {
  if (!snap) return lines.map(() => []);
  const [fpsLine, cpuLine] = lines;
  const cpu: Graph = snap.busy !== null ? ['busy', toneClass(cpuLine?.[0]?.[2], 'text-textSecondary')] : ['lagMs', toneClass(cpuLine?.[0]?.[2], 'text-textSecondary')];
  const net: Graph[] = [['downKBps', 'text-textSecondary', snap.videoKbps !== null ? 'down' : undefined]];
  if (snap.videoKbps !== null) net.push(['videoKbps', 'text-primaryBlue', 'video']);
  return [[['fps', toneClass(fpsLine?.[0]?.[2], 'text-textPrimary')]], [cpu], snap.memoryMb === null ? [] : [['memoryMb', 'text-textSecondary']], net];
}

function spark(history: PerfHistory, [series, className, caption]: Graph) {
  const values = history.values(series);
  const lines = sparkLines(values, rangeOf(series, values), GRAPH_W, GRAPH_H, history.size);
  const svg = createElement(
    'svg',
    { width: GRAPH_W, height: GRAPH_H, viewBox: `0 0 ${GRAPH_W} ${GRAPH_H}`, 'aria-hidden': true, className: cn('block overflow-visible', className) },
    createElement('line', { x1: 0, y1: GRAPH_H - 0.5, x2: GRAPH_W, y2: GRAPH_H - 0.5, stroke: 'currentColor', strokeOpacity: 0.3, strokeWidth: 1 }),
    lines.map((points, i) =>
      createElement('polyline', {
        key: `u${i}`,
        points,
        fill: 'none',
        stroke: 'rgba(0,0,0,0.7)',
        strokeWidth: 3,
        strokeLinejoin: 'round',
        strokeLinecap: 'round'
      })
    ),
    lines.map((points, i) =>
      createElement('polyline', {
        key: `c${i}`,
        points,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.25,
        strokeLinejoin: 'round',
        strokeLinecap: 'round'
      })
    )
  );
  return createElement(
    'div',
    { key: series, id: `perf-graph-${series}`, className: 'flex items-center justify-end gap-1.5' },
    caption ? createElement('span', { className: 'text-[10px] leading-none text-textTertiary' }, caption) : null,
    svg
  );
}

const HUD =
  'pointer-events-none fixed right-[var(--perf-hud-right,0.375rem)] top-1 z-[1000] select-none text-right font-mono text-xs tabular-nums text-textSecondary [text-shadow:0_1px_2px_rgba(0,0,0,0.9),0_0_1px_rgba(0,0,0,0.9)] max-md:right-[calc(0.375rem+env(safe-area-inset-right))] max-md:top-[calc(0.25rem+env(safe-area-inset-top))]';

export function PerfHud({ mode = 'on' }: { mode?: PerfMode }) {
  const [snap, setSnap] = useState<PerfSnapshot | null>(null);
  const [history] = useState(() => new PerfHistory());

  useEffect(() => {
    const sampler = new PerfSampler(browserDeps());
    sampler.start((next) => {
      history.push(next);
      setSnap(next);
    });
    return () => sampler.stop();
  }, [history]);

  const lines = linesOf(snap);
  if (mode !== 'extended') return createElement('div', { className: HUD }, lines.map(line));

  const graphs = graphsOf(snap, lines);
  return createElement(
    'div',
    { className: HUD },
    lines.map((parts, i) =>
      createElement(
        'div',
        { key: i, className: 'mb-1 flex flex-col items-end gap-0.5' },
        graphs[i]?.map((g) => spark(history, g)),
        createElement('div', null, ...partsOf(parts))
      )
    )
  );
}
