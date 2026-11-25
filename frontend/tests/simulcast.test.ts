import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyLayers, bitrateFor, cameraLayers, type Encoding, sendEncodings, singleLayer } from '../src/infra/simulcast.ts';
import { mergeLayers, type VideoLine } from '../src/infra/stream-stats.ts';

const heights = (source: number, layers = cameraLayers(source)) => layers.map((l) => (l.active ? Math.round(source / l.scaleResolutionDownBy) : 0));

test('a 1080p camera sends 360, 720 and 1080, low to high, with the top above the old 2.5 Mbps', () => {
  const layers = cameraLayers(1080);
  assert.deepEqual(
    layers.map((l) => l.rid),
    ['q', 'h', 'f']
  );
  assert.deepEqual(heights(1080), [360, 720, 1080]);
  assert.deepEqual(
    layers.map((l) => l.maxBitrate),
    [480_000, 2_000_000, 4_500_000]
  );
  assert.ok(layers.every((l) => l.active));
});

test('a bigger source is scaled down to 1080 at the top', () => {
  assert.deepEqual(heights(2160), [360, 720, 1080]);
  assert.equal(cameraLayers(2160)[2]!.scaleResolutionDownBy, 2);
});

test('a 720p camera keeps 720 at 2.5 Mbps on top and adds 480 and 240', () => {
  assert.deepEqual(heights(720), [240, 480, 720]);
  assert.equal(cameraLayers(720)[2]!.maxBitrate, 2_500_000);
});

test('small sources turn the layers that would be too small off', () => {
  assert.deepEqual(heights(480), [0, 320, 480]);
  assert.deepEqual(heights(360), [0, 240, 360]);
  assert.deepEqual(heights(240), [0, 0, 240]);
});

test('an unknown size plans for 720', () => {
  assert.deepEqual(heights(720, cameraLayers(undefined)), [240, 480, 720]);
  assert.deepEqual(heights(720, cameraLayers(0)), [240, 480, 720]);
});

test('a camera beside a screen takes the old cap and size on top, and small shares below', () => {
  const layers = cameraLayers(1080, { height: 360, maxBitrate: 500_000 });
  assert.deepEqual(heights(1080, layers), [0, 240, 360]);
  assert.deepEqual(
    layers.map((l) => l.maxBitrate),
    [75_000, 225_000, 500_000]
  );
  assert.equal(cameraLayers(1080, { height: 90, maxBitrate: 150_000 })[0]!.maxBitrate, 60_000);
});

test('bitrates follow the height between the known points', () => {
  assert.equal(bitrateFor(100), 150_000);
  assert.equal(bitrateFor(900), 3_500_000);
  assert.equal(bitrateFor(4000), 4_500_000);
});

test('a browser without simulcast keeps the old single 720p at 2.5 Mbps', () => {
  const one: Encoding[] = [{ maxBitrate: 1 }];
  assert.equal(applyLayers(one, 1080), 2_500_000);
  assert.deepEqual(one, [{ maxBitrate: 2_500_000, scaleResolutionDownBy: 1.5 }]);
  assert.deepEqual(singleLayer(720, { height: 360, maxBitrate: 400_000 }), { scaleResolutionDownBy: 2, maxBitrate: 400_000 });
  assert.deepEqual(singleLayer(480), { scaleResolutionDownBy: 1, maxBitrate: 2_500_000 });
});

test('applying layers sets each encoding by its rid and sums the active caps', () => {
  const encodings: Encoding[] = sendEncodings(1080).map((e) => ({ ...e, maxBitrate: 1 }));
  assert.equal(applyLayers(encodings, 480), bitrateFor(480) + Math.round(bitrateFor(320) * 0.8));
  assert.deepEqual(
    encodings.map((e) => [e.rid, e.active]),
    [
      ['q', false],
      ['h', true],
      ['f', true]
    ]
  );
});

const line = (height: number, bitrate: number, extra: Partial<VideoLine> = {}): VideoLine => ({
  label: null,
  width: (height * 16) / 9,
  height,
  fps: 30,
  bitrate,
  lossPct: 1,
  nackPerSec: 1,
  pliPerSec: 0,
  droppedPerSec: 0,
  keyframesPerSec: 0,
  reason: 'none',
  jitterMs: 2,
  ...extra
});

test('the layers of one sent track read as one line: the biggest sending picture, the summed bits', () => {
  const merged = mergeLayers([
    { trackId: 'cam', remoteLoss: 1, line: line(360, 400_000) },
    { trackId: 'cam', remoteLoss: 4, line: line(1080, 0, { fps: 0, lossPct: 4, reason: 'bandwidth' }) },
    { trackId: 'cam', remoteLoss: 2, line: line(720, 1_800_000, { nackPerSec: 3 }) },
    { trackId: 'screen', remoteLoss: null, line: line(1080, 2_000_000) }
  ]);
  assert.equal(merged.length, 2);
  const cam = merged[0]!;
  assert.equal(cam.line.height, 720);
  assert.equal(cam.line.bitrate, 2_200_000);
  assert.equal(cam.line.nackPerSec, 5);
  assert.equal(cam.line.lossPct, 4);
  assert.equal(cam.remoteLoss, 4);
  assert.equal(cam.line.reason, 'bandwidth');
  assert.equal(merged[1]!.trackId, 'screen');
});

test('tracks without an id are never merged', () => {
  const merged = mergeLayers([
    { trackId: undefined, remoteLoss: null, line: line(360, 1) },
    { trackId: undefined, remoteLoss: null, line: line(720, 1) }
  ]);
  assert.equal(merged.length, 2);
});
