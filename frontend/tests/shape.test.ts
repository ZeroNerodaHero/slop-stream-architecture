import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SHAPES, shapeOf } from '../src/infra/shape.ts';

test('the three shapes are kept as they are', () => {
  assert.deepEqual(SHAPES, ['block', 'soft', 'bubble']);
  for (const shape of SHAPES) assert.equal(shapeOf(shape), shape);
});

test('anything else is block', () => {
  for (const raw of [undefined, null, '', 'Soft', 'round', 0, 1, true, {}, ['soft'], { shape: 'bubble' }]) assert.equal(shapeOf(raw), 'block');
});
