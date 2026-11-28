import assert from 'node:assert/strict';
import { test } from 'node:test';

import { bubbleCorners, nookOf } from '../src/infra/bubble-run.ts';

const set = (s: string) => new Set(s.split(' '));

test('others join on the left: first, middle, last, single', () => {
  assert.deepEqual(set(bubbleCorners(true, false, false)), set('bubble:rounded-bubble-outer bubble:rounded-bl-bubble-join'));
  assert.deepEqual(set(bubbleCorners(false, false, false)), set('bubble:rounded-bubble-outer bubble:rounded-tl-bubble-join bubble:rounded-bl-bubble-join'));
  assert.deepEqual(set(bubbleCorners(false, true, false)), set('bubble:rounded-bubble-outer bubble:rounded-tl-bubble-join'));
  assert.deepEqual(set(bubbleCorners(true, true, false)), set('bubble:rounded-bubble-outer'));
});

test('mine mirror onto the right', () => {
  assert.deepEqual(set(bubbleCorners(true, false, true)), set('bubble:rounded-bubble-outer bubble:rounded-br-bubble-join'));
  assert.deepEqual(set(bubbleCorners(false, false, true)), set('bubble:rounded-bubble-outer bubble:rounded-tr-bubble-join bubble:rounded-br-bubble-join'));
  assert.deepEqual(set(bubbleCorners(false, true, true)), set('bubble:rounded-bubble-outer bubble:rounded-tr-bubble-join'));
  assert.deepEqual(set(bubbleCorners(true, true, true)), set('bubble:rounded-bubble-outer'));
});

const line = { left: 0, right: 400, top: 100, bottom: 140 };
const lane = { left: 40, right: 400, top: 100, bottom: 140 };

test('the bar sits right of others, centred on the bubble', () => {
  const bubble = { left: 40, right: 200, top: 104, bottom: 136 };
  assert.deepEqual(nookOf(line, lane, bubble, bubble, 90, false), { left: 204, top: 20 });
});

test('the bar sits left of mine', () => {
  const bubble = { left: 250, right: 400, top: 100, bottom: 120 };
  assert.deepEqual(nookOf(line, lane, bubble, bubble, 90, true), { right: 154, top: 10 });
});

test('no room beside the bubble falls back to the top', () => {
  const wide = { left: 40, right: 350, top: 100, bottom: 140 };
  assert.equal(nookOf(line, lane, wide, wide, 90, false), null);
  const mineWide = { left: 100, right: 400, top: 100, bottom: 140 };
  assert.equal(nookOf(line, lane, mineWide, mineWide, 90, true), null);
});
