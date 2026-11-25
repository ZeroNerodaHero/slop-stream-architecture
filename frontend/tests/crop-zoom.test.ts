import assert from 'node:assert/strict';
import { test } from 'node:test';

import { centredRect, cornerRect, MAX_ZOOM, maxZoom, minScale, minSide, type Rect, scaledRect, scaleOf, zoomedRect, zoomOf } from '../src/infra/picture.ts';

const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`);
const inside = (r: Rect, width: number, height: number) => {
  assert.ok(r.x >= -1e-9 && r.y >= -1e-9, 'starts inside');
  assert.ok(r.x + r.w <= width + 1e-9 && r.y + r.h <= height + 1e-9, 'ends inside');
};

test('the fitted box is zoom 1', () => {
  near(zoomOf(centredRect(2000, 1500, 1), 2000, 1500), 1);
  near(zoomOf(centredRect(2000, 1500, 4), 2000, 1500), 1);
  near(zoomOf(centredRect(2000, 1500, null), 2000, 1500), 1);
});

test('a big picture zooms to MAX_ZOOM and no further', () => {
  assert.equal(MAX_ZOOM, 4);
  near(maxZoom(2000, 1500, 1), MAX_ZOOM);
  near(maxZoom(2000, 1500, null), MAX_ZOOM);
  near(minScale(2000, 1500, 16 / 9), 1 / MAX_ZOOM);
});

test('a small picture keeps the smallest box rule', () => {
  const side = minSide(16, 16);
  assert.equal(side, 8);
  near(maxZoom(16, 16, 1), 2);
  let r = centredRect(16, 16, 1);
  for (let i = 0; i < 40; i++) r = scaledRect(r, 1 / 1.1, 1, 16, 16);
  near(r.w, 8);
  near(zoomOf(r, 16, 16), 2);
});

test('stepping in stops at the most, for every shape', () => {
  for (const aspect of [1, 4, 16 / 9, null]) {
    let r = centredRect(2000, 1500, aspect);
    for (let i = 0; i < 100; i++) r = scaledRect(r, 1 / 1.1, aspect, 2000, 1500);
    near(zoomOf(r, 2000, 1500), MAX_ZOOM);
    inside(r, 2000, 1500);
  }
});

test('one big jump in is clamped too', () => {
  const r = scaledRect(centredRect(2000, 1500, 1), 1 / 30.5, 1, 2000, 1500);
  near(zoomOf(r, 2000, 1500), MAX_ZOOM);
  near(r.w, 1500 / MAX_ZOOM);
});

test('stepping out stops at the fit', () => {
  let r = scaledRect(centredRect(2000, 1500, 1), 1 / 3, 1, 2000, 1500);
  for (let i = 0; i < 100; i++) r = scaledRect(r, 1.1, 1, 2000, 1500);
  near(zoomOf(r, 2000, 1500), 1);
  inside(r, 2000, 1500);
});

test('zoomedRect lands on the asked zoom and clamps outside the range', () => {
  const fit = centredRect(2000, 1500, 1);
  near(zoomOf(zoomedRect(fit, 2, 1, 2000, 1500), 2000, 1500), 2);
  near(zoomOf(zoomedRect(fit, 30.5, 1, 2000, 1500), 2000, 1500), MAX_ZOOM);
  near(zoomOf(zoomedRect(zoomedRect(fit, 3, 1, 2000, 1500), 0.2, 1, 2000, 1500), 2000, 1500), 1);
});

test('pulling a corner in cannot go past the most zoom', () => {
  const fit = centredRect(2000, 1500, 1);
  const r = cornerRect(fit, 1, 1, -5000, -5000, 1, 2000, 1500);
  near(r.w, 1500 / MAX_ZOOM);
  near(r.h, 1500 / MAX_ZOOM);
  near(r.x, fit.x);
  near(r.y, fit.y);
});

test('a free shape corner keeps one side at a quarter at least', () => {
  const whole = centredRect(2000, 1500, null);
  const r = cornerRect(whole, 1, 1, -1990, -1490, null, 2000, 1500);
  assert.ok(scaleOf(r, 2000, 1500) >= 1 / MAX_ZOOM - 1e-9);
  inside(r, 2000, 1500);
  const thin = cornerRect(whole, 1, 1, -1000, -1490, null, 2000, 1500);
  near(thin.w, 1000);
  assert.ok(thin.h >= minSide(2000, 1500));
});

test('a free shape corner near an edge grows the side that has room', () => {
  const from = { x: 0, y: 1400, w: 2000, h: 100 };
  const r = cornerRect(from, 1, -1, -1990, 0, null, 2000, 1500);
  assert.ok(scaleOf(r, 2000, 1500) >= 1 / MAX_ZOOM - 1e-9);
  inside(r, 2000, 1500);
});
