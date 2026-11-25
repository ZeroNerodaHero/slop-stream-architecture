import assert from 'node:assert/strict';
import { test } from 'node:test';

import { WINDOW_IDS } from '../src/infra/debug/window-open.ts';
import {
  drop,
  dropWindow,
  raise,
  raiseWindow,
  STACK_BASE,
  stackListeners,
  stackOrder,
  stackZ,
  subscribeStack,
  zFor
} from '../src/infra/debug/window-stack.ts';

test('raise moves a window to the top and keeps the rest in order', () => {
  assert.deepEqual(raise(['messages', 'timings', 'quality'], 'messages'), ['timings', 'quality', 'messages']);
  assert.deepEqual(raise(['messages', 'timings'], 'quality'), ['messages', 'timings', 'quality']);
});

test('raising the top window returns the same array', () => {
  const order = ['messages', 'timings'] as const;
  assert.equal(raise(order, 'timings'), order);
});

test('drop removes a window and is a no-op when absent', () => {
  assert.deepEqual(drop(['messages', 'timings', 'quality'], 'timings'), ['messages', 'quality']);
  const order = ['messages'] as const;
  assert.equal(drop(order, 'quality'), order);
});

test('the order never grows past the window kinds', () => {
  let order: readonly (typeof WINDOW_IDS)[number][] = [];
  for (let i = 0; i < 10000; i++) order = raise(order, WINDOW_IDS[(i * 7) % WINDOW_IDS.length]);
  assert.equal(order.length, WINDOW_IDS.length);
  assert.equal(new Set(order).size, WINDOW_IDS.length);
});

test('z is base plus position and stays in a band of the window kinds', () => {
  const order = ['quality', 'messages', 'timings'] as const;
  assert.equal(zFor(order, 'quality'), STACK_BASE);
  assert.equal(zFor(order, 'timings'), STACK_BASE + 2);
  for (const id of WINDOW_IDS) assert.ok(zFor(order, id) < STACK_BASE + WINDOW_IDS.length);
});

test('the shared stack notifies only on change and cleans up', () => {
  let calls = 0;
  const off = subscribeStack(() => calls++);
  raiseWindow('messages');
  raiseWindow('timings');
  raiseWindow('quality');
  assert.equal(calls, 3);
  raiseWindow('quality');
  assert.equal(calls, 3);
  raiseWindow('messages');
  assert.deepEqual(stackOrder(), ['timings', 'quality', 'messages']);
  assert.equal(stackZ('messages'), STACK_BASE + 2);
  assert.equal(calls, 4);
  for (const id of WINDOW_IDS) dropWindow(id);
  assert.deepEqual(stackOrder(), []);
  off();
  assert.equal(stackListeners(), 0);
});
