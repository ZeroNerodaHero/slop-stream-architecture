import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyCopy, applyLayers, bitrateFor, cameraLayers, copyEncodings, type Encoding, sendEncodings, singleLayer, VP9_MODE } from '../src/infra/simulcast.ts';
import { mergeLayers, type VideoLine } from '../src/infra/stream-stats.ts';

const heights = (source: number, layers = cameraLayers(source)) => layers.map((l) => (l.active ? Math.round(source / l.scaleResolutionDownBy) : 0));

test('a 1080p camera sends 360, 720 and 1080, low to high, 2.5 Mbps on top, all at 30fps', () => {
  const layers = cameraLayers(1080);
  assert.deepEqual(
    layers.map((l) => l.rid),
    ['q', 'h', 'f']
  );
  assert.deepEqual(heights(1080), [360, 720, 1080]);
  assert.deepEqual(
    layers.map((l) => l.maxBitrate),
    [500_000, 1_200_000, 2_500_000]
  );
  assert.ok(layers.every((l) => l.active && l.maxFramerate === 30));
});

test('a bigger source is scaled down to 1080 at the top', () => {
  assert.deepEqual(heights(2160), [360, 720, 1080]);
  assert.equal(cameraLayers(2160)[2]!.scaleResolutionDownBy, 2);
});

test('a 720p camera keeps 720 at 1.2 Mbps on top and adds 480 and 240', () => {
  assert.deepEqual(heights(720), [240, 480, 720]);
  assert.equal(cameraLayers(720)[2]!.maxBitrate, 1_200_000);
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
  assert.equal(bitrateFor(900), 1_850_000);
  assert.equal(bitrateFor(4000), 2_500_000);
});

test('a browser without simulcast keeps the old single 720p at 2.5 Mbps, capped at 30fps', () => {
  const one: Encoding[] = [{ maxBitrate: 1 }];
  assert.equal(applyLayers(one, 1080), 2_500_000);
  assert.deepEqual(one, [{ maxBitrate: 2_500_000, scaleResolutionDownBy: 1.5, maxFramerate: 30 }]);
  assert.deepEqual(singleLayer(720, { height: 360, maxBitrate: 400_000 }), { scaleResolutionDownBy: 2, maxBitrate: 400_000, maxFramerate: 30 });
  assert.deepEqual(singleLayer(480), { scaleResolutionDownBy: 1, maxBitrate: 2_500_000, maxFramerate: 30 });
});

test('applying layers sets each encoding by its rid and sums the active caps', () => {
  const encodings: Encoding[] = sendEncodings(1080).map((e) => ({ ...e, maxBitrate: 1 }));
  assert.equal(applyLayers(encodings, 480), bitrateFor(480) + bitrateFor(320));
  assert.ok(encodings.every((e) => e.maxFramerate === 30));
  assert.deepEqual(
    encodings.map((e) => [e.rid, e.active]),
    [
      ['q', false],
      ['h', true],
      ['f', true]
    ]
  );
});

test('a VP9 camera sends the same sizes at 70% of the VP8 caps, 30fps, one stream per encoding', () => {
  const encodings = sendEncodings(1080, 'vp9');
  assert.deepEqual(
    encodings.map((e) => [e.rid, e.maxBitrate, e.maxFramerate, e.scalabilityMode]),
    [
      ['q', 350_000, 30, VP9_MODE],
      ['h', 840_000, 30, VP9_MODE],
      ['f', 1_750_000, 30, VP9_MODE]
    ]
  );
  assert.deepEqual(heights(1080, cameraLayers(1080, undefined, 'vp9')), [360, 720, 1080]);
  assert.ok(sendEncodings(1080).every((e) => e.scalabilityMode === undefined));
  assert.equal(bitrateFor(900, 'vp9'), Math.round(1_850_000 * 0.7));
  const beside = cameraLayers(1080, { height: 360, maxBitrate: 500_000 }, 'vp9');
  assert.deepEqual(
    beside.map((l) => l.maxBitrate),
    [60_000, 157_500, 350_000]
  );
  const tuned = sendEncodings(1080, 'vp9');
  assert.equal(applyLayers(tuned, 1080, undefined, 'vp9'), 350_000 + 840_000 + 1_750_000);
  assert.ok(tuned.every((e) => e.scalabilityMode === VP9_MODE));
});

test('the VP8 copy sends the lowest layer always and the next one only when asked', () => {
  const copy = copyEncodings(1080);
  assert.deepEqual(
    copy.map((e) => [e.rid, e.active, e.maxBitrate, e.maxFramerate]),
    [
      ['cq', true, 500_000, 30],
      ['ch', false, 1_200_000, 30]
    ]
  );
  assert.deepEqual(
    copy.map((e) => Math.round(1080 / e.scaleResolutionDownBy!)),
    [360, 720]
  );
  assert.equal(applyCopy(copy, 1080, undefined, true), 1_700_000);
  assert.deepEqual(
    copy.map((e) => e.active),
    [true, true]
  );
  assert.equal(applyCopy(copy, 1080, undefined, false), 500_000);
  assert.deepEqual(
    copy.map((e) => e.active),
    [true, false]
  );
});

test('the copy takes the two lowest live camera sizes, so a small source never leaves it dark', () => {
  const copy = copyEncodings(480);
  assert.deepEqual(
    copy.map((e) => [e.active, Math.round(480 / e.scaleResolutionDownBy!)]),
    [
      [true, 320],
      [false, 480]
    ]
  );
  assert.equal(applyCopy(copy, 480, undefined, true), bitrateFor(320) + bitrateFor(480));
  const beside = copyEncodings(1080);
  assert.equal(applyCopy(beside, 1080, { height: 360, maxBitrate: 500_000 }, true), 225_000 + 500_000);
  assert.deepEqual(
    beside.map((e) => [e.active, Math.round(1080 / e.scaleResolutionDownBy!)]),
    [
      [true, 240],
      [true, 360]
    ]
  );
  const tiny = copyEncodings(240);
  assert.equal(applyCopy(tiny, 240, undefined, true), bitrateFor(240));
  assert.deepEqual(
    tiny.map((e) => e.active),
    [true, false]
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
