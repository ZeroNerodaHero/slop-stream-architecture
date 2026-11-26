import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  bigFit,
  clampPip,
  clampPipSize,
  nextBig,
  nextStage,
  PIP_MAX,
  PIP_MIN,
  parsePipAt,
  parsePipSize,
  type PipCandidate,
  smallRows,
  stripFit
} from '../src/infra/voice-pip.ts';

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

test('without screen shares the stage holds up to four people', () => {
  const all = [c('me', { self: true }), c('1'), c('2'), c('3'), c('4'), c('5')];
  assert.deepEqual(nextStage([], all), ['1', '2', '3', '4']);
  assert.deepEqual(nextStage([], [c('me', { self: true }), c('1')]), ['1', 'me']);
});

test('screen shares take the stage, at most two, and people go back when they stop', () => {
  const all = [c('1', { speaking: true, activeAt: 3 }), c('2'), c('2:screen', { screen: true, video: true }), c('3:screen', { screen: true, video: true }), c('4:screen', { screen: true, video: true, activeAt: 1 })];
  const during = nextStage(['1', '2'], all);
  assert.deepEqual(during, ['4:screen', '2:screen']);
  const after = nextStage(during, [c('1', { activeAt: 3 }), c('2')]);
  assert.deepEqual(after, ['1', '2']);
});

test('a single screen share is the whole stage', () => {
  assert.deepEqual(nextStage(['1', '2'], [c('1'), c('2'), c('2:screen', { screen: true, video: true })]), ['2:screen']);
});

test('smallRows with one row of the columns that fit leaves a +N slot when it overflows', () => {
  const rest = Array.from({ length: 9 }, (_, i) => i);
  assert.deepEqual(smallRows(rest, 5, 1), { shown: [0, 1, 2, 3], more: [4, 5, 6, 7, 8] });
  assert.deepEqual(smallRows([0, 1, 2], 5, 1), { shown: [0, 1, 2], more: [] });
  assert.deepEqual(smallRows([0, 1], 1, 1), { shown: [], more: [0, 1] });
});

test('stripFit counts how many small tiles fit across', () => {
  assert.equal(stripFit(384, 6), 5);
  assert.equal(stripFit(72, 6), 1);
  assert.equal(stripFit(10, 6), 1);
  assert.equal(stripFit(800, 6), 10);
});

test('bigFit keeps a wide stage in one row and stacks when tall', () => {
  assert.deepEqual(bigFit(4, 800, 120, 6), { cols: 4, rows: 1, tile: 195 });
  assert.equal(bigFit(4, 400, 400, 6).cols, 2);
  assert.equal(bigFit(4, 300, 900, 6).cols, 1);
  assert.deepEqual(bigFit(1, 384, 200, 6), { cols: 1, rows: 1, tile: 355 });
  assert.deepEqual(bigFit(2, 384, 200, 6), { cols: 2, rows: 1, tile: 189 });
});

test('bigFit only picks column counts that fill every row evenly', () => {
  assert.deepEqual(bigFit(4, 760, 250, 6), { cols: 2, rows: 2, tile: 216 });
  assert.deepEqual(bigFit(3, 500, 500, 6), { cols: 1, rows: 3, tile: 289 });
  for (const [n, w, h] of [[2, 300, 400], [3, 760, 250], [4, 760, 420], [4, 900, 300], [4, 500, 700]] as const) {
    const f = bigFit(n, w, h, 6);
    assert.equal(f.cols * f.rows, n);
  }
});

test('bigFit tiles never overflow the stage', () => {
  for (const [n, w, h] of [[1, 300, 100], [2, 600, 150], [3, 500, 500], [4, 280, 120], [4, 1200, 700]] as const) {
    const f = bigFit(n, w, h, 6);
    assert.ok(f.cols * f.rows >= n);
    assert.ok(f.tile * f.cols + 6 * (f.cols - 1) <= w + 1);
    assert.ok((f.tile / (16 / 9)) * f.rows + 6 * (f.rows - 1) <= h + 1);
  }
});

test('bigFit with nothing to place or no room is empty', () => {
  assert.equal(bigFit(0, 400, 300, 6).tile, 0);
  assert.equal(bigFit(2, 0, 300, 6).tile, 0);
});

test('clampPipSize keeps the window between the min, the max and the screen edge', () => {
  const view = { w: 1280, h: 800 };
  assert.deepEqual(clampPipSize({ w: 400, h: 300 }, view, { right: 24, bottom: 24 }), { w: 400, h: 300 });
  assert.deepEqual(clampPipSize({ w: 10, h: 10 }, view), PIP_MIN);
  assert.deepEqual(clampPipSize({ w: 5000, h: 5000 }, { w: 4000, h: 4000 }), PIP_MAX);
  assert.deepEqual(clampPipSize({ w: 1200, h: 790 }, view, { right: 200, bottom: 100 }), { w: 1080, h: 700 });
  assert.deepEqual(clampPipSize({ w: 400, h: 300 }, { w: 240, h: 150 }), { w: 240, h: 150 });
});

test('parsePipSize reads the size stored next to the position', () => {
  assert.deepEqual(parsePipSize({ right: 10, bottom: 20, w: 500, h: 360 }), { w: 500, h: 360 });
  assert.equal(parsePipSize({ right: 10, bottom: 20 }), null);
  assert.equal(parsePipSize({ w: 0, h: 300 }), null);
  assert.equal(parsePipSize({ w: Number.POSITIVE_INFINITY, h: 300 }), null);
  assert.deepEqual(parsePipAt({ right: 10, bottom: 20, w: 500, h: 360 }), { right: 10, bottom: 20 });
});
