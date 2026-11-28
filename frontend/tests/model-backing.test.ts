import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isSeeThrough, isStoredBacking, NO_BACKING, readModelBacking, WIRE_BACKING, wireBackingOf } from '../src/infra/model-backing.ts';
import { readStage } from '../src/infra/stage.ts';

test('a model has nothing behind it unless a colour was picked', () => {
  assert.equal(readModelBacking(undefined), NO_BACKING);
  assert.equal(readModelBacking('none'), NO_BACKING);
  assert.equal(readModelBacking('red'), NO_BACKING);
  assert.equal(readModelBacking(WIRE_BACKING), NO_BACKING);
  assert.equal(readModelBacking('#181B22'), NO_BACKING);
  assert.equal(readModelBacking('#ff2266'), '#ff2266');
  assert.equal(isSeeThrough(NO_BACKING), true);
  assert.equal(isSeeThrough('#ff2266'), false);
});

test('viewers get the old dark colour behind a see-through model', () => {
  assert.equal(wireBackingOf(NO_BACKING), WIRE_BACKING);
  assert.equal(wireBackingOf('#ff2266'), '#ff2266');
});

test('a preset keeps none or a colour and drops junk', () => {
  assert.equal(isStoredBacking('none'), true);
  assert.equal(isStoredBacking('#102030'), true);
  assert.equal(isStoredBacking('blue'), false);
  assert.equal(readStage({ scene: {}, background: 'none' })?.background, 'none');
  assert.equal(readStage({ scene: {}, background: '#181b22' })?.background, '#181b22');
  assert.equal(readModelBacking(readStage({ scene: {}, background: '#181b22' })?.background), NO_BACKING);
});
