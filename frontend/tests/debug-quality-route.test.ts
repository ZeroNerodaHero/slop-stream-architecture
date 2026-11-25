import assert from 'node:assert/strict';
import { test } from 'node:test';

import { QualityRing, routeOf } from '../src/infra/debug/rings.ts';

const sample = (t: number) => ({ t, session: 0, width: 1280, height: 720, fps: 30, bitrate: 900_000, lossPct: 0, droppedPerSec: 0, jitterMs: 10, rttMs: 40 });

test('each sample keeps the path it was taken on', () => {
  const ring = new QualityRing(3);
  ring.push(sample(1), 'direct');
  ring.push(sample(2), null);
  ring.push(sample(3), 'relay');
  ring.push(sample(4), 'direct');
  assert.deepEqual(ring.series('route').map(routeOf), [null, 'relay', 'direct']);
  assert.equal(ring.path, 'direct');
});
