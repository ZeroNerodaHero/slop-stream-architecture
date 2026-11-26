import { WINDOW_IDS } from './debug/window-open.ts';

export const STACK_IDS = [...WINDOW_IDS, 'chat', 'dm', 'corner', 'notifications', 'voice', 'screens', 'ring'] as const;
export type StackId = (typeof STACK_IDS)[number];

export const STACK_BASE = 50;
export const STACK_CEILING = 60;

export type Stack = readonly StackId[];

export function raise(order: Stack, id: StackId): Stack {
  if (order[order.length - 1] === id) return order;
  return [...order.filter((x) => x !== id), id];
}

export function drop(order: Stack, id: StackId): Stack {
  return order.includes(id) ? order.filter((x) => x !== id) : order;
}

export function zFor(order: Stack, id: StackId): number {
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
export const stackZ = (id: StackId): number => zFor(order, id);
export const raiseWindow = (id: StackId): void => set(raise(order, id));
export const dropWindow = (id: StackId): void => set(drop(order, id));

export function subscribeStack(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const stackListeners = (): number => listeners.size;
