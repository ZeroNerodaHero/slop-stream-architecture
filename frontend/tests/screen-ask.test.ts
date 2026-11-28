import assert from 'node:assert/strict';
import { test } from 'node:test';

import { askAfter, withAsk } from '../src/infra/screen-ask.ts';

test('a pick that comes back empty blocks its slot', () => {
  assert.equal(askAfter('none'), 'blocked');
  assert.equal(askAfter('shared'), null);
  assert.equal(askAfter('dropped'), null);
});

test('the blocked flag is per slot and clears on a share', () => {
  const picking = withAsk({}, 0, 'picking');
  assert.deepEqual(picking, { 0: 'picking' });
  const blocked = withAsk(withAsk(picking, 0, askAfter('none')), 1, 'blocked');
  assert.deepEqual(blocked, { 0: 'blocked', 1: 'blocked' });
  const shared = withAsk(blocked, 0, askAfter('shared'));
  assert.deepEqual(shared, { 1: 'blocked' });
  assert.equal(0 in shared, false);
  assert.deepEqual(blocked, { 0: 'blocked', 1: 'blocked' });
});
