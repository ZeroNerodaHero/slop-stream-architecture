import { useSyncExternalStore } from 'react';

import { collector } from '@/infra/debug/collect';

const subscribe = (fn: () => void) => collector.subscribe(fn);
const version = () => collector.version;

export function useCollected(): typeof collector {
  useSyncExternalStore(subscribe, version);
  return collector;
}
