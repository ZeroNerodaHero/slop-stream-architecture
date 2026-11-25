import assert from 'node:assert/strict';
import { test } from 'node:test';

import { clampPip, nextBig, parsePipAt, type PipCandidate, smallRows } from '../src/infra/voice-pip.ts';

const c = (key: string, over: Partial<PipCandidate> = {}): PipCandidate => ({ key, speaking: false, video: false, activeAt: 0, self: false, ...over });

test('one participant gets one big tile', () => {
  assert.deepEqual(nextBig([], [c('me', { self: true })]), ['me']);
});

test('with nobody active, others come before yourself and the list order breaks ties', () => {
  assert.deepEqual(nextBig([], [c('me', { self: true }), c('1'), c('2'), c('3')]), ['1', '2']);
});

test('live video is preferred when nobody has spoken', () => {
  assert.deepEqual(nextBig([], [c('1'), c('2'), c('3', { video: true }), c('4')]), ['3', '1']);
});

test('the current speaker takes the weakest big slot, in place', () => {
  const all = [c('1', { activeAt: 2 }), c('2', { activeAt: 1 }), c('3', { speaking: true, activeAt: 3 })];
  assert.deepEqual(nextBig(['1', '2'], all), ['1', '3']);
});

test('the most recent speaker wins over an older one when nobody is speaking', () => {
  const all = [c('1', { activeAt: 1 }), c('2', { activeAt: 2 }), c('3', { activeAt: 5 })];
  assert.deepEqual(nextBig([], all), ['3', '2']);
});

test('a speaker beats live video, and the speaker who stops keeps the slot', () => {
  const talking = [c('cam', { video: true, activeAt: 1 }), c('scr', { video: true, activeAt: 1 }), c('3', { speaking: true, activeAt: 4 })];
  const during = nextBig(['cam', 'scr'], talking);
  assert.deepEqual(during, ['3', 'scr']);
  const after = [c('cam', { video: true, activeAt: 1 }), c('scr', { video: true, activeAt: 1 }), c('3', { activeAt: 4 })];
  assert.deepEqual(nextBig(during, after), during);
});

test('ties never swap a big tile out', () => {
  const all = [c('1', { speaking: true, activeAt: 3 }), c('2', { speaking: true, activeAt: 3 }), c('3', { speaking: true, activeAt: 3 })];
  assert.deepEqual(nextBig(['2', '1'], all), ['2', '1']);
});

test('a big tile that left is refilled and the order of the one that stayed holds', () => {
  const all = [c('1'), c('3', { activeAt: 2 }), c('4', { activeAt: 1 })];
  assert.deepEqual(nextBig(['2', '3'], all), ['3', '4']);
});

test('nextBig is stable when run again on its own answer', () => {
  const all = [c('a', { activeAt: 1 }), c('b', { speaking: true, activeAt: 9 }), c('c', { video: true }), c('d', { activeAt: 4 })];
  const once = nextBig(['a', 'c'], all);
  assert.deepEqual(nextBig(once, all), once);
});

test('the rest fill up to two rows of four with no overflow tile', () => {
  const rest = Array.from({ length: 8 }, (_, i) => i);
  assert.deepEqual(smallRows(rest), { shown: rest, more: [] });
  assert.deepEqual(smallRows([1, 2]), { shown: [1, 2], more: [] });
});

test('past two rows the last slot becomes +N', () => {
  const rest = Array.from({ length: 10 }, (_, i) => i);
  const { shown, more } = smallRows(rest);
  assert.equal(shown.length, 7);
  assert.deepEqual(more, [7, 8, 9]);
  assert.equal(shown.length + 1, 8);
});

test('clampPip keeps the window inside the viewport', () => {
  assert.deepEqual(clampPip({ right: 24, bottom: 24 }, { w: 1280, h: 800 }, { w: 400, h: 300 }), { right: 24, bottom: 24 });
  assert.deepEqual(clampPip({ right: 1200, bottom: 900 }, { w: 1280, h: 800 }, { w: 400, h: 300 }), { right: 880, bottom: 500 });
  assert.deepEqual(clampPip({ right: -50, bottom: -10 }, { w: 1280, h: 800 }, { w: 400, h: 300 }), { right: 0, bottom: 0 });
  assert.deepEqual(clampPip({ right: 100, bottom: 100 }, { w: 300, h: 200 }, { w: 400, h: 300 }), { right: 0, bottom: 0 });
});

test('parsePipAt rejects anything but two finite numbers', () => {
  assert.deepEqual(parsePipAt({ right: 10, bottom: 20 }), { right: 10, bottom: 20 });
  assert.equal(parsePipAt(null), null);
  assert.equal(parsePipAt({ right: '10', bottom: 20 }), null);
  assert.equal(parsePipAt({ right: Number.NaN, bottom: 20 }), null);
});
