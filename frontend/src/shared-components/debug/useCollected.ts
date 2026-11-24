import { useSyncExternalStore } from 'react';

export function useCollected<T extends { subscribe: (fn: () => void) => () => void; snapshot: () => number }>(feed: T): T {
  useSyncExternalStore(feed.subscribe, feed.snapshot);
  return feed;
}
