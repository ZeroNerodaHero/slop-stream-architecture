import assert from 'node:assert/strict';
import { test } from 'node:test';

import { keptOf, readKept, type Source } from '../src/infra/scene.ts';
import { capBounds, capOf, fitWithin, readScreenCap, SCREEN_CAPS, screenConstraints, stageScreenBitrate } from '../src/infra/screen-cap.ts';
import { stagedFrom } from '../src/infra/stage.ts';

test('a screen with no cap asks for its own pixels, up to 4k, scaled rather than a native mode', () => {
  assert.equal(capOf(undefined), 'native');
  assert.deepEqual(screenConstraints(undefined), { width: { max: 3840 }, height: { max: 2160 }, frameRate: { max: 30 }, resizeMode: 'crop-and-scale' });
  assert.equal(fitWithin(3024, 1964, 'native').width, 3024);
  assert.deepEqual(fitWithin(3840, 2160, 'native'), { width: 3840, height: 2160 });
  assert.deepEqual(fitWithin(5120, 2880, 'native'), { width: 3840, height: 2160 });
});

test('each cap bounds the height and leaves room for wide screens', () => {
  assert.deepEqual(capBounds('1440'), { width: 3360, height: 1440 });
  assert.deepEqual(capBounds('1080'), { width: 2520, height: 1080 });
  assert.deepEqual(capBounds('720'), { width: 1680, height: 720 });
  assert.deepEqual(fitWithin(3024, 1964, '1080'), { width: 1662, height: 1080 });
  assert.deepEqual(fitWithin(2560, 1440, '720'), { width: 1280, height: 720 });
  assert.deepEqual(fitWithin(5120, 1440, '1080'), { width: 2520, height: 708 });
  assert.deepEqual(fitWithin(5120, 1440, 'native'), { width: 3840, height: 1080 });
  assert.deepEqual(fitWithin(1280, 720, '1440'), { width: 1280, height: 720 });
  for (const cap of SCREEN_CAPS) assert.equal(screenConstraints(cap).frameRate && (screenConstraints(cap).frameRate as ConstrainULongRange).max, 30);
});

test('only known caps are read back', () => {
  assert.equal(readScreenCap('1080'), '1080');
  assert.equal(readScreenCap('4k'), undefined);
  assert.equal(readScreenCap(1080), undefined);
});

test('a big stage screen gets more of the budget, within the ceiling', () => {
  assert.equal(stageScreenBitrate(3_000_000, 1920, 1080, 6_000_000), 3_000_000);
  assert.equal(stageScreenBitrate(3_000_000, 1280, 720, 6_000_000), 3_000_000);
  assert.equal(stageScreenBitrate(3_000_000, undefined, undefined, 6_000_000), 3_000_000);
  assert.equal(stageScreenBitrate(3_000_000, 2560, 1440, 6_000_000), 4_000_000);
  assert.equal(stageScreenBitrate(3_000_000, 3840, 2160, 6_000_000), 6_000_000);
});

test('the cap is kept with the screen in a preset and comes back on the waiting source', () => {
  const screen: Source = { id: 's1', kind: 'screen', label: 'screen', slot: 1, box: { x: 0, y: 0, w: 1, h: 1 }, shown: true, cap: '720' };
  const kept = readKept(JSON.parse(JSON.stringify(keptOf([screen]))));
  assert.equal(kept?.s1?.cap, '720');
  assert.equal(readKept({ s1: { box: { x: 0, y: 0, w: 1, h: 1 }, cap: 'huge' } })?.s1?.cap, undefined);
  const staged = stagedFrom({ scene: kept ?? {}, images: {} }, [], [], () => 'i1');
  assert.equal(staged.sources[0]?.cap, '720');
  assert.equal(staged.sources[0]?.waiting, true);
});
