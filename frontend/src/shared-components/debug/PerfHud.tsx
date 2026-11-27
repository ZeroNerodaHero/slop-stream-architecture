import { useAtom } from 'jotai';
import { atomWithStorage } from 'jotai/utils';
import { createElement, type PointerEvent as ReactPointerEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';

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
import { clampPip, parsePipAt } from '@/infra/voice-pip';
import { GRIP } from '@/shared-components/debug/useDialogBox';
import { useStackedWindow } from '@/shared-components/useStackedWindow';
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

const HUD = cn(
  'pointer-events-none fixed right-[var(--perf-hud-right,0.375rem)] top-1 w-max cursor-grab select-none text-right font-mono text-xs tabular-nums text-textSecondary [text-shadow:0_1px_2px_rgba(0,0,0,0.9),0_0_1px_rgba(0,0,0,0.9)] active:cursor-grabbing max-md:right-[calc(0.375rem+env(safe-area-inset-right))] max-md:top-[calc(0.25rem+env(safe-area-inset-top))] [&>div]:pointer-events-auto [&>div]:ml-auto [&>div]:w-max',
  GRIP
);

const PERF_HUD_AT_KEY = 'settings.perfHudAt';
const hudAtAtom = atomWithStorage<unknown>(PERF_HUD_AT_KEY, null, undefined, { getOnInit: true });

interface HudAt {
  right: number;
  top: number;
}

type Size = { w: number; h: number };

const room = (): Size => ({ w: document.documentElement.clientWidth, h: document.documentElement.clientHeight });

function parseHudAt(v: unknown): HudAt | null {
  if (!v || typeof v !== 'object') return null;
  const at = parsePipAt({ right: (v as Partial<HudAt>).right, bottom: (v as Partial<HudAt>).top });
  return at && { right: at.right, top: at.bottom };
}

function clampHud(at: HudAt, view: Size, size: Size): HudAt {
  const fit = clampPip({ right: at.right, bottom: at.top }, view, size);
  return { right: fit.right, top: fit.bottom };
}

function useHudPlace() {
  const ref = useRef<HTMLDivElement | null>(null);
  const stop = useRef<(() => void) | null>(null);
  const [stored, setStored] = useAtom(hudAtAtom);
  const [drag, setDrag] = useState<HudAt | null>(null);
  const [space, setSpace] = useState(room);
  const [size, setSize] = useState<Size>({ w: 0, h: 0 });

  useStackedWindow(ref, 'perf');

  useEffect(() => {
    const fit = () =>
      setSpace((was) => {
        const now = room();
        return now.w === was.w && now.h === was.h ? was : now;
      });
    fit();
    const watcher = new ResizeObserver(fit);
    watcher.observe(document.documentElement);
    window.addEventListener('resize', fit);
    return () => {
      watcher.disconnect();
      window.removeEventListener('resize', fit);
    };
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setSize((was) => (was.w === el.offsetWidth && was.h === el.offsetHeight ? was : { w: el.offsetWidth, h: el.offsetHeight }));
    measure();
    const watcher = new ResizeObserver(measure);
    watcher.observe(el);
    return () => watcher.disconnect();
  }, []);

  useEffect(() => () => stop.current?.(), []);

  const kept = drag ?? parseHudAt(stored);
  const at = kept && clampHud(kept, space, size);

  const press = (e: ReactPointerEvent) => {
    const el = ref.current;
    if (e.button !== 0 || stop.current || !el) return;
    e.preventDefault();
    const rect = el.getBoundingClientRect();
    const start: HudAt = { right: room().w - rect.right, top: rect.top };
    const x0 = e.clientX;
    const y0 = e.clientY;
    const pointerId = e.pointerId;
    let last: HudAt | null = null;
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      last = clampHud({ right: start.right - (ev.clientX - x0), top: start.top + (ev.clientY - y0) }, room(), { w: el.offsetWidth, h: el.offsetHeight });
      setDrag(last);
    };
    const end = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      stop.current?.();
      if (last) setStored(last);
      setDrag(null);
    };
    stop.current = () => {
      stop.current = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  };

  return { id: 'perf-hud', ref, className: HUD, style: at ? { right: at.right, top: at.top } : undefined, onPointerDown: press };
}

export function PerfHud({ mode = 'on' }: { mode?: PerfMode }) {
  const [snap, setSnap] = useState<PerfSnapshot | null>(null);
  const [history] = useState(() => new PerfHistory());
  const hud = useHudPlace();

  useEffect(() => {
    const sampler = new PerfSampler(browserDeps());
    sampler.start((next) => {
      history.push(next);
      setSnap(next);
    });
    return () => sampler.stop();
  }, [history]);

  const lines = linesOf(snap);
  if (mode !== 'extended') return createElement('div', hud, lines.map(line));

  const graphs = graphsOf(snap, lines);
  return createElement(
    'div',
    hud,
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
