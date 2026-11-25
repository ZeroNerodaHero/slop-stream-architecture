import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hoverWords, liveHeader } from '../src/infra/debug/quality-header.ts';
import type { StreamStats } from '../src/infra/stream-stats.ts';

const stats = (video: Partial<StreamStats['video']>, path: StreamStats['path']) => ({ video: { width: 426, height: 240, droppedPerSec: 0, ...video }, path }) as unknown as StreamStats;

test('the header reads nothing while not watching', () => {
  assert.equal(liveHeader(null), null);
});

test('the header reads res, dropped and path while watching', () => {
  assert.equal(liveHeader(stats({}, 'direct')), '426x240 · dropped 0.0/s · direct');
  assert.equal(liveHeader(stats({ droppedPerSec: 2.345 }, 'relay')), '426x240 · dropped 2.3/s · relay');
});

test('the header leaves out an unknown res or path and dashes an unknown drop rate', () => {
  assert.equal(liveHeader(stats({ width: 0, height: 0, droppedPerSec: null }, null)), 'dropped -/s');
});

test('the hover line keeps the time and the stream and none of the graphed numbers', () => {
  const at = Date.UTC(2026, 10, 25, 2, 32, 24);
  const words = hoverWords(at, 'dummy-b');
  assert.equal(words, `${new Date(at).toLocaleTimeString()} · dummy-b`);
  assert.doesNotMatch(words, /bitrate|fps|loss|jitter|rtt/);
  assert.equal(hoverWords(at, ''), new Date(at).toLocaleTimeString());
});
