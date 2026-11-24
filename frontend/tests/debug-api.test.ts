import assert from 'node:assert/strict';
import { test } from 'node:test';

import { debug, onDebugChange, setDebug } from '../src/infra/debug-flag.ts';
import { QualityCollector, TimingsCollector } from '../src/infra/debug/collector.ts';
import type { StreamStats, VideoLine } from '../src/infra/stream-stats.ts';

const ORIGIN = 'http://app.test';

function stats(bitrate: number): StreamStats {
  const video: VideoLine = {
    label: null,
    width: 1280,
    height: 720,
    fps: 30,
    bitrate,
    lossPct: 0,
    nackPerSec: null,
    pliPerSec: null,
    droppedPerSec: null,
    keyframesPerSec: null,
    reason: null,
    jitterMs: 2
  };
  return { word: 'clear', video, others: [], audio: null, rttMs: 20, availableBps: null, path: 'direct', capBps: null, reason: null };
}

function fakeFetch() {
  const calls: string[] = [];
  const fn = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('fail')) throw new TypeError('network');
    return new Response(null, { status: url.includes('missing') ? 404 : 200 });
  }) as typeof fetch;
  return { fn, calls };
}

function timingsRig() {
  let now = 0;
  const slot: { sink: typeof debug.sink } = { sink: null };
  const timings = new TimingsCollector({ slot, host: globalThis, origin: () => ORIGIN, clock: () => (now += 5), schedule: () => undefined });
  return { timings, slot };
}

test('timings: api calls are timed only while on, and off forgets them', async () => {
  const fake = fakeFetch();
  const before = globalThis.fetch;
  globalThis.fetch = fake.fn;
  try {
    const { timings } = timingsRig();
    await fetch('/api/me');
    assert.equal(globalThis.fetch, fake.fn);
    timings.start();
    assert.notEqual(globalThis.fetch, fake.fn);
    await fetch(`${ORIGIN}/api/streams/dummy/watch`, { method: 'POST' });
    await fetch(`${ORIGIN}/api/groups/cats?roster=1`);
    await fetch(`${ORIGIN}/api/missing`);
    await assert.rejects(fetch(`${ORIGIN}/api/fail`));
    await fetch('https://elsewhere.test/api/me');
    await fetch(`${ORIGIN}/assets/x.js`);
    const api = timings.api!;
    assert.deepEqual([...api.routes.keys()].sort(), ['GET /api/fail', 'GET /api/groups/:name', 'GET /api/missing', 'POST /api/streams/:name/watch']);
    assert.deepEqual(api.values('POST /api/streams/:name/watch'), [5]);
    assert.equal(api.errors('GET /api/missing'), 1);
    assert.equal(api.errors('GET /api/fail'), 1);
    assert.equal(api.errors('GET /api/groups/:name'), 0);
    assert.equal(fake.calls.length, 7);
    timings.stop();
    assert.equal(globalThis.fetch, fake.fn);
    assert.equal(timings.api, null);
    assert.equal(api.routes.size, 0);
    timings.start();
    assert.equal(timings.api!.routes.size, 0);
    assert.equal(timings.timings!.size(), 0);
    await fetch(`${ORIGIN}/api/me`);
    assert.deepEqual([...timings.api!.routes.keys()], ['GET /api/me']);
    timings.stop();
  } finally {
    globalThis.fetch = before;
  }
});

test('timings: an answer that lands after off does not leak into the next on', async () => {
  let release: (r: Response) => void = () => undefined;
  const before = globalThis.fetch;
  globalThis.fetch = (() => new Promise<Response>((resolve) => (release = resolve))) as typeof fetch;
  try {
    const { timings } = timingsRig();
    timings.start();
    const pending = fetch(`${ORIGIN}/api/me`);
    timings.stop();
    timings.start();
    release(new Response(null));
    await pending;
    assert.equal(timings.api!.routes.size, 0);
    timings.stop();
  } finally {
    globalThis.fetch = before;
  }
});

test('timings: off leaves a fetch someone else wrapped on top alone', () => {
  const fake = fakeFetch();
  const before = globalThis.fetch;
  globalThis.fetch = fake.fn;
  try {
    const { timings } = timingsRig();
    timings.start();
    const ours = globalThis.fetch;
    const theirs = ((input: RequestInfo | URL, init?: RequestInit) => ours(input, init)) as typeof fetch;
    globalThis.fetch = theirs;
    timings.stop();
    assert.equal(globalThis.fetch, theirs);
    assert.equal(timings.wrapped, false);
  } finally {
    globalThis.fetch = before;
  }
});

test('twenty switch on and off cycles leave no data and no fetch wrapper', async () => {
  const fake = fakeFetch();
  const before = globalThis.fetch;
  globalThis.fetch = fake.fn;
  try {
    const { timings, slot } = timingsRig();
    const listeners = new Set<(s: StreamStats | null) => void>();
    const quality = new QualityCollector({
      watch: (fn) => {
        listeners.add(fn);
        return () => {
          listeners.delete(fn);
        };
      },
      name: () => 'dummy',
      now: () => 0,
      schedule: () => undefined
    });
    const stopTimings = onDebugChange('timings', (on) => (on ? timings.start() : timings.stop()));
    const stopQuality = onDebugChange('quality', (on) => (on ? quality.start() : quality.stop()));
    for (let i = 0; i < 20; i++) {
      setDebug('timings', true, false);
      setDebug('quality', true);
      assert.equal(debug.timings, true);
      assert.equal(debug.quality, true);
      assert.equal(timings.api!.size(), 0);
      assert.equal(timings.timings!.size(), 0);
      assert.equal(quality.quality!.count, 0);
      assert.notEqual(globalThis.fetch, fake.fn);
      await fetch(`${ORIGIN}/api/groups/g${i}`);
      slot.sink!('say', 'room', 0, [
        ['say', 0],
        ['ack', 5]
      ]);
      for (const fn of listeners) fn(stats(i));
      assert.equal(timings.api!.size(), 1);
      setDebug('timings', false, false);
      setDebug('quality', false);
      assert.equal(timings.api, null);
      assert.equal(timings.timings, null);
      assert.equal(quality.quality, null);
      assert.equal(slot.sink, null);
      assert.equal(listeners.size, 0);
      assert.equal(globalThis.fetch, fake.fn);
    }
    stopTimings();
    stopQuality();
    assert.equal(debug.timings, false);
    assert.equal(debug.quality, false);
  } finally {
    globalThis.fetch = before;
  }
});
