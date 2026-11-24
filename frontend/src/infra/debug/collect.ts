import { watchStatsAtom } from '@/infra/atoms/watch-atoms';
import { watchNameAtom } from '@/infra/atoms/watch-state';
import { debug } from '@/infra/debug-flag';
import { Collector } from '@/infra/debug/collector';
import { store } from '@/infra/store';

export const collector = new Collector({
  slot: debug,
  watch: (fn) => {
    fn(store.get(watchStatsAtom));
    return store.sub(watchStatsAtom, () => fn(store.get(watchStatsAtom)));
  },
  name: () => store.get(watchNameAtom),
  now: () => Date.now(),
  schedule: (fn) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(fn);
    else setTimeout(fn, 16);
  }
});

export function start(): void {
  collector.start();
}

export function stop(): void {
  collector.stop();
}
