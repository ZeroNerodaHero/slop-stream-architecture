import { createElement, type ReactNode, useEffect, useState } from 'react';

import { watchStatsAtom } from '@/infra/atoms/watch-atoms';
import { type PerfDeps, type PerfObserverCtor, type PerfSnapshot, PerfSampler, type PressureCtor } from '@/infra/debug/perf-hud';
import { store } from '@/infra/store';

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

function line(parts: Part[], key: number) {
  const out: ReactNode[] = [];
  parts.forEach(([label, value, tone], i) => {
    if (i > 0) out.push(' · ');
    out.push(
      createElement('span', { key: `l${i}`, className: 'text-textTertiary' }, label),
      ' ',
      createElement('span', { key: `v${i}`, className: tone ? TONE[tone] : 'text-textPrimary' }, value)
    );
  });
  return createElement('div', { key }, ...out);
}

export function PerfHud() {
  const [snap, setSnap] = useState<PerfSnapshot | null>(null);

  useEffect(() => {
    const sampler = new PerfSampler(browserDeps());
    sampler.start(setSnap);
    return () => sampler.stop();
  }, []);

  return createElement(
    'div',
    {
      className:
        'pointer-events-none fixed right-1.5 top-1 z-[1000] select-none text-right font-mono text-xs tabular-nums text-textSecondary [text-shadow:0_1px_2px_rgba(0,0,0,0.9),0_0_1px_rgba(0,0,0,0.9)] max-md:right-[calc(0.375rem+env(safe-area-inset-right))] max-md:top-[calc(0.25rem+env(safe-area-inset-top))]'
    },
    linesOf(snap).map(line)
  );
}
