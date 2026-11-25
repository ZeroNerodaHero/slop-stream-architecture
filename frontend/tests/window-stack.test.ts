import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  drop,
  dropWindow,
  raise,
  raiseWindow,
  STACK_BASE,
  STACK_CEILING,
  STACK_IDS,
  stackListeners,
  stackOrder,
  stackZ,
  subscribeStack,
  zFor
} from '../src/infra/window-stack.ts';

test('every floating window kind is in the stack', () => {
  for (const id of ['messages', 'timings', 'quality', 'chat', 'dm', 'corner', 'notifications', 'voice'] as const) assert.ok(STACK_IDS.includes(id));
});

test('raise moves a window to the top and keeps the rest in order', () => {
  assert.deepEqual(raise(['messages', 'chat', 'quality'], 'messages'), ['chat', 'quality', 'messages']);
  assert.deepEqual(raise(['messages', 'timings'], 'dm'), ['messages', 'timings', 'dm']);
});

test('raising the top window returns the same array', () => {
  const order = ['messages', 'chat'] as const;
  assert.equal(raise(order, 'chat'), order);
});

test('drop removes a window and is a no-op when absent', () => {
  assert.deepEqual(drop(['messages', 'chat', 'quality'], 'chat'), ['messages', 'quality']);
  const order = ['messages'] as const;
  assert.equal(drop(order, 'dm'), order);
});

test('the order never grows past the window kinds', () => {
  let order: readonly (typeof STACK_IDS)[number][] = [];
  for (let i = 0; i < 10000; i++) order = raise(order, STACK_IDS[(i * 3) % STACK_IDS.length]);
  assert.equal(order.length, STACK_IDS.length);
  assert.equal(new Set(order).size, STACK_IDS.length);
});

test('z stays under tooltips and menus for every window', () => {
  const order = [...STACK_IDS];
  assert.equal(zFor(order, order[0]), STACK_BASE);
  for (const id of STACK_IDS) assert.ok(zFor(order, id) < STACK_CEILING);
  assert.ok(zFor([], 'chat') < STACK_CEILING);
  const tooltip = readFileSync(new URL('../src/shared-components/Tooltip.tsx', import.meta.url), 'utf8');
  assert.match(tooltip, new RegExp(`z-\\[${STACK_CEILING}\\]`));
});

test('clicking chat after dev windows puts chat on top, then a dev window goes back over it', () => {
  let calls = 0;
  const off = subscribeStack(() => calls++);
  raiseWindow('chat');
  raiseWindow('messages');
  raiseWindow('timings');
  assert.ok(stackZ('chat') < stackZ('timings'));
  raiseWindow('chat');
  assert.deepEqual(stackOrder(), ['messages', 'timings', 'chat']);
  assert.ok(stackZ('chat') > stackZ('timings') && stackZ('chat') > stackZ('messages'));
  raiseWindow('chat');
  assert.equal(calls, 4);
  raiseWindow('messages');
  assert.equal(stackZ('messages'), STACK_BASE + 2);
  for (const id of STACK_IDS) dropWindow(id);
  assert.deepEqual(stackOrder(), []);
  off();
  assert.equal(stackListeners(), 0);
});

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith('.tsx') ? [path] : [];
  });
}

test('stacked windows never hardcode a z-index class', () => {
  const src = new URL('../src/', import.meta.url).pathname;
  const stacked = files(src).filter((f) => /useStackedWindow\(|useDialogBox\(/.test(readFileSync(f, 'utf8')));
  assert.ok(stacked.length >= 5);
  for (const f of stacked) {
    const s = readFileSync(f, 'utf8');
    assert.doesNotMatch(s, /'(group )?(pointer-events-none )?fixed (bottom-6 )?z-(40|50)\b/, f);
  }
});
