import assert from 'node:assert/strict';
import { test } from 'node:test';

import { clampBox, LAYER_MIN } from '../src/infra/box.ts';
import {
  fittedModelBox,
  frameSizeOf,
  isOffStage,
  looseBox,
  modelFrameOf,
  modelWidthAspect,
  movedLoose,
  resizedLoose,
  STAGE_ASPECT,
  visibleBox,
  wideModelBox
} from '../src/infra/model-frame.ts';
import { CORNER, keptOf, layerOf, readKept, sceneOf, type Source } from '../src/infra/scene.ts';
import { readStage } from '../src/infra/stage.ts';

const model = (box = CORNER): Source => ({ id: 'cam', kind: 'camera', label: 'camera', slot: 0, box, shown: true });

test('a box on the stage is left alone by the loose clamp and the visible cut', () => {
  for (const box of [CORNER, { x: 0, y: 0, w: 1, h: 1 }, { x: 0.02, y: 0.631, w: 0.333, h: 0.333 }]) {
    assert.deepEqual(looseBox(box), clampBox(box));
    assert.deepEqual(visibleBox(box), box);
    assert.deepEqual(modelFrameOf(box), { aspect: Math.round((box.w / box.h) * STAGE_ASPECT * 10000) / 10000, view: { x: 0, y: 0, w: 1, h: 1 } });
  }
});

test('the model box can hang off every edge but keeps a sliver on the stage', () => {
  const right = movedLoose(CORNER, 0.5, 0);
  assert.equal(right.x, 1 - LAYER_MIN);
  assert.ok(isOffStage(right));
  const left = movedLoose(CORNER, -2, -2);
  assert.deepEqual(left, { x: LAYER_MIN - CORNER.w, y: LAYER_MIN - CORNER.h, w: CORNER.w, h: CORNER.h });
  const half = movedLoose(CORNER, 0.15, 0);
  assert.deepEqual(half, { x: 0.88, y: CORNER.y, w: 0.25, h: 0.25 });
});

test('the sent layer is only the part on the stage, so the relay keeps 0..1', () => {
  const off = { x: 0.88, y: -0.1, w: 0.25, h: 0.4 };
  const layer = layerOf(model(off));
  assert.deepEqual({ x: layer.x, y: layer.y, w: layer.w, h: layer.h }, { x: 0.88, y: 0, w: 0.12, h: 0.3 });
  for (const l of sceneOf([model(movedLoose(CORNER, -3, 3))]).layers) {
    for (const v of [l.x, l.y, l.w, l.h]) assert.ok(v >= 0 && v <= 1);
    assert.ok(l.x + l.w <= 1.0005 && l.y + l.h <= 1.0005);
  }
});

test('the drawn frame shows the same slice of the model as the stage does', () => {
  const frame = modelFrameOf({ x: 0.88, y: -0.1, w: 0.25, h: 0.4 });
  assert.equal(frame.aspect, Math.round((0.25 / 0.4) * STAGE_ASPECT * 10000) / 10000);
  assert.deepEqual(frame.view, { x: 0, y: 0.25, w: 0.48, h: 0.75 });
  const size = frameSizeOf(frame);
  assert.equal(size.fullHeight, 720);
  assert.equal(size.height, 540);
  assert.ok(Math.abs(size.width / size.height - (0.12 * 16) / (0.3 * 9)) < 0.02);
  const wide = frameSizeOf({ aspect: STAGE_ASPECT, view: { x: 0, y: 0, w: 1, h: 1 } });
  assert.deepEqual([wide.width, wide.height], [1280, 720]);
});

test('hugging keeps the height, the middle and so the size of the model', () => {
  const box = { x: 0.73, y: 0.714, w: 0.25, h: 0.25 };
  const hug = fittedModelBox(box, 0.8);
  assert.equal(hug.h, box.h);
  assert.equal(hug.y, box.y);
  assert.ok(Math.abs(hug.x + hug.w / 2 - (box.x + box.w / 2)) < 0.001);
  assert.ok(Math.abs((hug.w / hug.h) * STAGE_ASPECT - 0.8) < 0.01);
  const back = wideModelBox(hug);
  assert.ok(Math.abs(back.w - box.w) < 0.002 && Math.abs(back.x - box.x) < 0.002);
});

test('the model width aspect has a margin and stays in range', () => {
  assert.equal(modelWidthAspect(0.25, 1), 0.54);
  assert.equal(modelWidthAspect(10, 1), 1.7778);
  assert.equal(modelWidthAspect(0, 1), 0.3);
});

test('a locked resize off the stage keeps its shape and is not squeezed by the edge', () => {
  const box = { x: 0.9, y: 0.5, w: 0.2, h: 0.3 };
  const grown = resizedLoose(box, 1, 1, 0.1, 0, box.w / box.h);
  assert.ok(Math.abs(grown.w / grown.h - box.w / box.h) < 0.01);
  assert.equal(grown.w, 0.3);
  assert.equal(grown.x, 0.9);
});

test('an off stage model box survives a reload and old saved scenes still load', () => {
  const off = { x: -0.1, y: 0.7, w: 0.2, h: 0.4 };
  assert.deepEqual(readKept(JSON.parse(JSON.stringify(keptOf([model(off)]))))?.cam?.box, off);
  const old = readStage({ scene: { cam: { box: { x: 0.73, y: 0.714, w: 0.25, h: 0.25 }, shown: true } } });
  assert.deepEqual(old?.scene.cam?.box, { x: 0.73, y: 0.714, w: 0.25, h: 0.25 });
});
