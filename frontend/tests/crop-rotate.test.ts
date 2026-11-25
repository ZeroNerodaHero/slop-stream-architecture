import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  centredRect,
  cornerRect,
  drawTransform,
  keepsFile,
  maxZoom,
  nextTurn,
  outputSize,
  type Rect,
  rotatedCrop,
  SCENE_PICTURE,
  scaledRect,
  sourceRect,
  type Turns,
  turnedSize,
  turnPoint,
  turnRect,
  zoomOf
} from '../src/infra/picture.ts';

const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} is not ${b}`);
const same = (a: Rect, b: Rect) => {
  near(a.x, b.x);
  near(a.y, b.y);
  near(a.w, b.w);
  near(a.h, b.h);
};
const inside = (r: Rect, width: number, height: number) => {
  assert.ok(r.x >= -1e-9 && r.y >= -1e-9, 'starts inside');
  assert.ok(r.x + r.w <= width + 1e-9 && r.y + r.h <= height + 1e-9, 'ends inside');
};
const centre = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
const TURNS: Turns[] = [0, 1, 2, 3];
const ASPECTS = [1, 16 / 9, 4, null];

test('turns go round in quarters', () => {
  assert.deepEqual(
    [0, 1, 2, 3].map((t) => nextTurn(t as Turns)),
    [1, 2, 3, 0]
  );
});

test('a quarter turn swaps width and height', () => {
  assert.deepEqual(turnedSize(2000, 1000, 0), { width: 2000, height: 1000 });
  assert.deepEqual(turnedSize(2000, 1000, 1), { width: 1000, height: 2000 });
  assert.deepEqual(turnedSize(2000, 1000, 2), { width: 2000, height: 1000 });
  assert.deepEqual(turnedSize(2000, 1000, 3), { width: 1000, height: 2000 });
});

test('points turn clockwise', () => {
  assert.deepEqual(turnPoint({ x: 0, y: 0 }, 2000, 1000, 1), { x: 1000, y: 0 });
  assert.deepEqual(turnPoint({ x: 2000, y: 0 }, 2000, 1000, 1), { x: 1000, y: 2000 });
  assert.deepEqual(turnPoint({ x: 0, y: 1000 }, 2000, 1000, 1), { x: 0, y: 0 });
  assert.deepEqual(turnPoint({ x: 10, y: 20 }, 2000, 1000, 2), { x: 1990, y: 980 });
  assert.deepEqual(turnPoint({ x: 10, y: 20 }, 2000, 1000, 3), { x: 20, y: 1990 });
});

test('four quarter turns give the rect back, its centre turns with it', () => {
  const start: Rect = { x: 120, y: 40, w: 300, h: 500 };
  let r = start;
  let [w, h] = [2000, 1000];
  for (let i = 0; i < 4; i++) {
    const next = turnRect(r, w, h, 1);
    const c = turnPoint(centre(r), w, h, 1);
    near(centre(next).x, c.x);
    near(centre(next).y, c.y);
    near(next.w, r.h);
    near(next.h, r.w);
    inside(next, h, w);
    r = next;
    [w, h] = [h, w];
  }
  same(r, start);
});

test('sourceRect undoes turnRect', () => {
  const r: Rect = { x: 120, y: 40, w: 300, h: 500 };
  for (const t of TURNS) same(sourceRect(turnRect(r, 2000, 1000, t), 2000, 1000, t), r);
});

test('turning the crop keeps it inside a wide picture and keeps its zoom', () => {
  for (const aspect of ASPECTS) {
    let [w, h] = [2000, 1000];
    let r = scaledRect(centredRect(w, h, aspect), 1 / 2, aspect, w, h);
    r = { ...r, x: w - r.w, y: 0 };
    const zoom = zoomOf(r, w, h);
    for (let i = 0; i < 4; i++) {
      const next = rotatedCrop(r, w, h, aspect);
      [w, h] = [h, w];
      inside(next, w, h);
      if (aspect !== null) near(next.w / next.h, aspect, 1e-6);
      near(zoomOf(next, w, h), Math.min(zoom, maxZoom(w, h, aspect)), 1e-6);
      r = next;
    }
  }
});

test('free shape swaps the box, the fitted box turns into the fitted box', () => {
  const free = rotatedCrop({ x: 100, y: 200, w: 600, h: 300 }, 2000, 1000, null);
  same(free, { x: 500, y: 100, w: 300, h: 600 });
  for (const aspect of ASPECTS) {
    let [w, h] = [2000, 1000];
    let r = centredRect(w, h, aspect);
    for (let i = 0; i < 4; i++) {
      r = rotatedCrop(r, w, h, aspect);
      [w, h] = [h, w];
      same(r, centredRect(w, h, aspect));
      near(zoomOf(r, w, h), 1);
    }
  }
});

test('the centre is kept when there is room', () => {
  const r = scaledRect(centredRect(2000, 1000, 1), 1 / 3, 1, 2000, 1000);
  const moved = { ...r, x: r.x + 50, y: r.y + 10 };
  const next = rotatedCrop(moved, 2000, 1000, 1);
  const c = turnPoint(centre(moved), 2000, 1000, 1);
  near(centre(next).x, c.x, 1e-6);
  near(centre(next).y, c.y, 1e-6);
});

test('the zoom limit still holds after a turn', () => {
  for (const aspect of ASPECTS) {
    let [w, h] = [2000, 1000];
    let r = centredRect(w, h, aspect);
    for (let i = 0; i < 60; i++) r = scaledRect(r, 1 / 1.1, aspect, w, h);
    near(zoomOf(r, w, h), maxZoom(w, h, aspect), 1e-6);
    r = rotatedCrop(r, w, h, aspect);
    [w, h] = [h, w];
    assert.ok(zoomOf(r, w, h) <= maxZoom(w, h, aspect) + 1e-6);
    for (let i = 0; i < 60; i++) r = scaledRect(r, 1 / 1.1, aspect, w, h);
    near(zoomOf(r, w, h), maxZoom(w, h, aspect), 1e-6);
    const pulled = cornerRect(r, 1, 1, -5000, -5000, aspect, w, h);
    assert.ok(zoomOf(pulled, w, h) <= maxZoom(w, h, aspect) + 1e-6);
    inside(pulled, w, h);
  }
});

test('the export draws each source pixel where the turned picture has it', () => {
  const [W, H] = [1600, 900];
  for (const t of TURNS) {
    const turned = turnedSize(W, H, t);
    const rect: Rect = { x: turned.width * 0.1, y: turned.height * 0.2, w: turned.width * 0.5, h: turned.height * 0.3 };
    const [ow, oh] = [400, 300];
    const src = sourceRect(rect, W, H, t);
    const local = turnedSize(ow, oh, t);
    const [a, b, c, d, e, f] = drawTransform(t, ow, oh);
    for (const [fx, fy] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
      [0.3, 0.7]
    ]) {
      const p = { x: src.x + src.w * fx, y: src.y + src.h * fy };
      const u = ((p.x - src.x) * local.width) / src.w;
      const v = ((p.y - src.y) * local.height) / src.h;
      const drawn = { x: a * u + c * v + e, y: b * u + d * v + f };
      const q = turnPoint(p, W, H, t);
      near(drawn.x, ((q.x - rect.x) * ow) / rect.w, 1e-6);
      near(drawn.y, ((q.y - rect.y) * oh) / rect.h, 1e-6);
    }
  }
});

test('a free cut is sized in the turned picture, and a turned picture never goes up as it is', () => {
  const turned = turnedSize(2000, 1000, 1);
  const whole = centredRect(turned.width, turned.height, null);
  assert.deepEqual(outputSize(SCENE_PICTURE, whole, turned.width, turned.height), { width: 1000, height: 2000 });
  const file = new Blob([new Uint8Array(10)], { type: 'image/png' });
  assert.equal(keepsFile(SCENE_PICTURE, file, centredRect(2000, 1000, null), 2000, 1000, 0), true);
  for (const t of [1, 2, 3] as Turns[]) {
    const size = turnedSize(2000, 1000, t);
    assert.equal(keepsFile(SCENE_PICTURE, file, centredRect(size.width, size.height, null), size.width, size.height, t), false);
  }
});
