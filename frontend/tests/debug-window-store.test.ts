import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BOXES_KEY, clampBox, parseBoxes, parseWindows, restoreOpen, saveBox, serialize, WINDOWS_KEY } from '../src/infra/debug/window-store.ts';

function memory(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => void map.set(key, value), map };
}

const MIN = { w: 320, h: 200 };

test('restoreOpen only reopens windows whose switch is on', () => {
  const stored = parseWindows(serialize({ messages: true, timings: true, quality: false }));
  assert.deepEqual(restoreOpen(stored, { messages: true, timings: false, quality: true }), { messages: true, timings: false, quality: false });
  assert.deepEqual(restoreOpen(stored, { messages: true, timings: true, quality: true }), { messages: true, timings: true, quality: false });
});

test('bad or missing windows json opens nothing', () => {
  const closed = { messages: false, timings: false, quality: false };
  for (const raw of [null, '', '{', 'null', '42', '"x"', '{"messages":"true","timings":1}']) assert.deepEqual(parseWindows(raw), closed);
  assert.deepEqual(restoreOpen(parseWindows('{bad'), { messages: true, timings: true, quality: true }), closed);
});

test('a window closed by its switch is stored as closed', () => {
  const storage = memory({ [WINDOWS_KEY]: serialize({ messages: true, timings: true, quality: true }) });
  const open = restoreOpen(parseWindows(storage.getItem(WINDOWS_KEY)), { messages: true, timings: false, quality: true });
  storage.setItem(WINDOWS_KEY, serialize(open));
  assert.deepEqual(parseWindows(storage.getItem(WINDOWS_KEY)), { messages: true, timings: false, quality: true });
});

test('clampBox pulls an off-screen box fully inside a smaller viewport', () => {
  const viewport = { w: 800, h: 600 };
  const box = clampBox({ x: 1500, y: 900, w: 500, h: 400 }, viewport, MIN);
  assert.deepEqual(box, { x: 300, y: 200, w: 500, h: 400 });
  assert.deepEqual(clampBox({ x: -50, y: -20, w: 500, h: 400 }, viewport, MIN), { x: 0, y: 0, w: 500, h: 400 });
});

test('clampBox shrinks oversize boxes and grows undersize ones', () => {
  assert.deepEqual(clampBox({ x: 100, y: 100, w: 2000, h: 1500 }, { w: 800, h: 600 }, MIN), { x: 0, y: 0, w: 800, h: 600 });
  assert.deepEqual(clampBox({ x: 10, y: 10, w: 50, h: 50 }, { w: 800, h: 600 }, MIN), { x: 10, y: 10, w: 320, h: 200 });
});

test('clampBox keeps an in-bounds box unchanged', () => {
  const box = { x: 40, y: 60, w: 600, h: 440 };
  assert.deepEqual(clampBox(box, { w: 1440, h: 900 }, MIN), box);
});

test('saveBox merges per id without clobbering others', () => {
  const storage = memory();
  saveBox(storage, 'timings', { x: 1, y: 2, w: 400, h: 300 });
  saveBox(storage, 'quality', { x: 5, y: 6, w: 500, h: 350 });
  saveBox(storage, 'timings', { x: 9, y: 9, w: 410, h: 310 });
  assert.deepEqual(parseBoxes(storage.getItem(BOXES_KEY)), { timings: { x: 9, y: 9, w: 410, h: 310 }, quality: { x: 5, y: 6, w: 500, h: 350 } });
});

test('parseBoxes drops malformed entries and survives bad json', () => {
  assert.deepEqual(parseBoxes('{oops'), {});
  assert.deepEqual(
    parseBoxes(JSON.stringify({ messages: { x: 1, y: 2, w: 3, h: 4 }, timings: { x: '1', y: 2, w: 3, h: 4 }, quality: null, other: { x: 1, y: 1, w: 1, h: 1 } })),
    {
      messages: { x: 1, y: 2, w: 3, h: 4 }
    }
  );
});
