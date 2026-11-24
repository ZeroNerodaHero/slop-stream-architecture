import { watchStatsAtom } from '@/infra/atoms/watch-atoms';
import { watchNameAtom } from '@/infra/atoms/watch-state';
import { debug } from '@/infra/debug-flag';
import { QualityCollector, TimingsCollector } from '@/infra/debug/collector';
import { store } from '@/infra/store';

const schedule = (fn: () => void) => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(fn);
  else setTimeout(fn, 16);
};

export const timings = new TimingsCollector({
  slot: debug,
  host: globalThis,
  origin: () => location.origin,
  clock: () => performance.now(),
  schedule
});

export const quality = new QualityCollector({
  watch: (fn) => {
    fn(store.get(watchStatsAtom));
    return store.sub(watchStatsAtom, () => fn(store.get(watchStatsAtom)));
  },
  name: () => store.get(watchNameAtom),
  now: () => Date.now(),
  schedule
});

export function start(): void {
  timings.start();
  quality.start();
}

export function stop(): void {
  timings.stop();
  quality.stop();
}
