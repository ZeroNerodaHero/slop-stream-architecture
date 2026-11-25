import type { WindowId } from './window-open.ts';

export const STACK_BASE = 50;

export type Stack = readonly WindowId[];

export function raise(order: Stack, id: WindowId): Stack {
  if (order[order.length - 1] === id) return order;
  return [...order.filter((x) => x !== id), id];
}

export function drop(order: Stack, id: WindowId): Stack {
  return order.includes(id) ? order.filter((x) => x !== id) : order;
}

export function zFor(order: Stack, id: WindowId): number {
  const i = order.indexOf(id);
  return STACK_BASE + (i < 0 ? order.length : i);
}

let order: Stack = [];
const listeners = new Set<() => void>();

function set(next: Stack) {
  if (next === order) return;
  order = next;
  for (const l of listeners) l();
}

export const stackOrder = (): Stack => order;
export const stackZ = (id: WindowId): number => zFor(order, id);
export const raiseWindow = (id: WindowId): void => set(raise(order, id));
export const dropWindow = (id: WindowId): void => set(drop(order, id));

export function subscribeStack(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const stackListeners = (): number => listeners.size;
