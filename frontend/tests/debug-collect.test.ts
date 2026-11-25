import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { DebugSink } from '../src/infra/debug-flag.ts';
import { QualityCollector, TimingsCollector } from '../src/infra/debug/collector.ts';
import { METRIC_SIZE, QUALITY_SIZE, QualityRing, Timings } from '../src/infra/debug/rings.ts';
import { MAX_SESSIONS } from '../src/infra/debug/timeline.ts';
import type { StreamStats, VideoLine } from '../src/infra/stream-stats.ts';

function sample(i: number) {
  return { t: i, session: Math.floor(i / 100), width: 1280, height: 720, fps: 30, bitrate: i, lossPct: 0, droppedPerSec: 0, jitterMs: 1, rttMs: 20 };
}

function stats(bitrate: number): StreamStats {
  const video: VideoLine = {
    label: null,
    width: 1920,
    height: 1080,
    fps: 60,
    bitrate,
    lossPct: 0.5,
    nackPerSec: null,
    pliPerSec: null,
    droppedPerSec: null,
    keyframesPerSec: null,
    reason: null,
    jitterMs: 4
  };
  return { word: 'clear', video, others: [], audio: null, rttMs: 30, availableBps: null, path: 'relay', capBps: null, reason: null };
}

function rig() {
  const listeners = new Set<(s: StreamStats | null) => void>();
  const slot: { sink: DebugSink | null } = { sink: null };
  const queue: (() => void)[] = [];
  const clock = { now: 0, name: 'dummy-a' };
  const host = { fetch: (async () => new Response(null)) as typeof fetch };
  const fetchBefore = host.fetch;
  const timings = new TimingsCollector({ slot, host, origin: () => 'http://app.test', clock: () => clock.now, schedule: (fn) => queue.push(fn) });
  const collector = new QualityCollector({
    watch: (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    name: () => clock.name,
    now: () => clock.now,
    schedule: (fn) => queue.push(fn)
  });
  const emit = (s: StreamStats | null) => {
    for (const fn of listeners) fn(s);
  };
  return { collector, timings, slot, listeners, emit, queue, clock, host, fetchBefore };
}

test('the quality ring caps at 600 samples and wraps keeping the session of each sample', () => {
  const ring = new QualityRing();
  assert.equal(QUALITY_SIZE, 600);
  for (let i = 0; i < QUALITY_SIZE + 250; i++) ring.push(sample(i), 'direct');
  assert.equal(ring.count, QUALITY_SIZE);
  assert.equal(ring.cols.bitrate.length, QUALITY_SIZE);
  const bitrate = ring.series('bitrate');
  const session = ring.series('session');
  assert.equal(bitrate.length, QUALITY_SIZE);
  assert.equal(bitrate[0], 250);
  assert.equal(bitrate[QUALITY_SIZE - 1], QUALITY_SIZE + 249);
  for (let i = 0; i < QUALITY_SIZE; i++) assert.equal(session[i], Math.floor(bitrate[i]! / 100));
  assert.equal(session[0], 2);
  assert.equal(session[QUALITY_SIZE - 1], 8);
  assert.equal(ring.path, 'direct');
  ring.clear();
  assert.equal(ring.count, 0);
  assert.equal(ring.path, null);
  assert.deepEqual(ring.series('bitrate'), []);
});

test('timings keep the last 100 samples per metric as ms from the run start', () => {
  const timings = new Timings();
  for (let i = 0; i < 145; i++)
    timings.add('chat', 1000 * i, [
      ['press', 1000 * i],
      ['subbed', 1000 * i + i],
      ['history', 1000 * i + 2 * i]
    ]);
  timings.add('say', 50, [
    ['say', 50],
    ['ack', 62]
  ]);
  timings.add('say', 70, [
    ['say', 70],
    ['nack', 90]
  ]);
  const subbed = timings.values('chat-subbed');
  assert.equal(METRIC_SIZE, 100);
  assert.equal(subbed.length, METRIC_SIZE);
  assert.equal(subbed[0], 45);
  assert.equal(subbed[METRIC_SIZE - 1], 144);
  assert.equal(timings.values('chat-history')[METRIC_SIZE - 1], 288);
  assert.deepEqual(timings.values('chat-first-line'), []);
  assert.deepEqual(timings.values('say-ack'), [12]);
  assert.deepEqual(timings.values('watch-first-frame'), []);
  assert.equal(timings.rings.get('chat-subbed')!.buf.length, METRIC_SIZE);
  assert.equal(timings.size(), 201);
  timings.clear();
  assert.equal(timings.size(), 0);
  assert.equal(timings.rings.size, 0);
});

test('a finished watch run reaches its metrics through the sink', () => {
  const { timings: collector, slot } = rig();
  collector.start();
  slot.sink!('watch', 'cats', 100, [
    ['press', 100],
    ['ws-open', 140],
    ['ice-connected', 220.5],
    ['first-frame', 350.4],
    ['first-frame', 999]
  ]);
  assert.deepEqual(collector.timings!.values('watch-ws-open'), [40]);
  assert.deepEqual(collector.timings!.values('watch-ice'), [120.5]);
  assert.deepEqual(collector.timings!.values('watch-first-frame'), [250.39999999999998]);
  assert.deepEqual(collector.timings!.values('watch-decoded'), []);
  collector.stop();
});

test('stream stats fill the quality ring and the latest stats', () => {
  const { collector, emit } = rig();
  collector.start();
  emit(stats(2_000_000));
  emit(stats(3_000_000));
  assert.equal(collector.quality!.count, 2);
  assert.deepEqual(collector.quality!.series('bitrate'), [2_000_000, 3_000_000]);
  assert.ok(Number.isNaN(collector.quality!.at('droppedPerSec', 1)));
  assert.equal(collector.quality!.path, 'relay');
  assert.equal(collector.stats!.video.bitrate, 3_000_000);
  emit(null);
  assert.equal(collector.stats, null);
  collector.stop();
});

test('a session starts on the first stats, ends on null, and a new name starts the next', () => {
  const { collector, emit, clock } = rig();
  collector.start();
  emit(null);
  assert.equal(collector.sessions!.list.length, 0);
  clock.now = 1000;
  emit(stats(1));
  clock.now = 2000;
  emit(stats(2));
  assert.deepEqual(collector.sessions!.list, [{ id: 0, name: 'dummy-a', avatar: null, start: 1000, end: null }]);
  clock.now = 3000;
  emit(null);
  clock.now = 4000;
  emit(null);
  assert.deepEqual(collector.sessions!.list, [{ id: 0, name: 'dummy-a', avatar: null, start: 1000, end: 3000 }]);
  clock.now = 10_000;
  emit(stats(3));
  clock.now = 11_000;
  clock.name = 'dummy-b';
  emit(stats(4));
  assert.deepEqual(collector.sessions!.list, [
    { id: 0, name: 'dummy-a', avatar: null, start: 1000, end: 3000 },
    { id: 1, name: 'dummy-a', avatar: null, start: 10_000, end: 11_000 },
    { id: 2, name: 'dummy-b', avatar: null, start: 11_000, end: null }
  ]);
  assert.equal(collector.sessions!.current!.id, 2);
  assert.deepEqual(collector.quality!.series('session'), [0, 0, 1, 2]);
  collector.stop();
});

test('the session list keeps the last 50', () => {
  const { collector, emit, clock } = rig();
  collector.start();
  for (let i = 0; i < 70; i++) {
    clock.now = i * 10;
    clock.name = `s${i}`;
    emit(stats(i));
  }
  const list = collector.sessions!.list;
  assert.equal(list.length, MAX_SESSIONS);
  assert.equal(list[0]!.name, 's20');
  assert.equal(list[MAX_SESSIONS - 1]!.id, 69);
  collector.stop();
});

test('stop clears everything, lets go of the source and is idempotent', () => {
  const { collector, timings: t, slot, listeners, emit, host, fetchBefore } = rig();
  collector.start();
  t.start();
  emit(stats(1));
  slot.sink!('chat', 'room', 0, [
    ['press', 0],
    ['subbed', 5]
  ]);
  const timings = t.timings!;
  const quality = collector.quality!;
  const sessions = collector.sessions!;
  assert.equal(timings.size(), 1);
  collector.stop();
  t.stop();
  assert.equal(listeners.size, 0);
  assert.equal(slot.sink, null);
  assert.equal(host.fetch, fetchBefore);
  assert.equal(t.timings, null);
  assert.equal(t.api, null);
  assert.equal(collector.quality, null);
  assert.equal(collector.sessions, null);
  assert.equal(collector.stats, null);
  assert.equal(collector.running, false);
  assert.equal(t.running, false);
  assert.equal(timings.size(), 0);
  assert.equal(quality.count, 0);
  assert.equal(sessions.list.length, 0);
  collector.stop();
  t.stop();
  assert.equal(listeners.size, 0);
  assert.equal(slot.sink, null);
});

test('timings and quality start and stop on their own', () => {
  const { collector, timings, slot, listeners, host, fetchBefore } = rig();
  timings.start();
  assert.equal(listeners.size, 0);
  assert.notEqual(slot.sink, null);
  assert.notEqual(host.fetch, fetchBefore);
  collector.start();
  timings.stop();
  assert.equal(listeners.size, 1);
  assert.equal(slot.sink, null);
  assert.equal(host.fetch, fetchBefore);
  collector.stop();
  assert.equal(listeners.size, 0);
});

test('start twice subscribes once', () => {
  const { collector, timings, listeners, host, fetchBefore } = rig();
  collector.start();
  collector.start();
  timings.start();
  const wrapper = host.fetch;
  timings.start();
  assert.equal(host.fetch, wrapper);
  assert.equal(listeners.size, 1);
  collector.stop();
  timings.stop();
  assert.equal(listeners.size, 0);
  assert.equal(host.fetch, fetchBefore);
});

test('twenty start and stop cycles leave nothing behind', () => {
  const { collector, timings, slot, listeners, emit, queue, clock } = rig();
  for (let i = 0; i < 20; i++) {
    collector.start();
    timings.start();
    assert.equal(collector.sessions!.list.length, 0);
    assert.equal(collector.quality!.count, 0);
    assert.equal(timings.timings!.size(), 0);
    clock.name = `s${i}`;
    emit(stats(i));
    emit(null);
    slot.sink!('say', 'room', 0, [
      ['say', 0],
      ['ack', 5]
    ]);
    collector.stop();
    timings.stop();
    assert.equal(listeners.size, 0);
    assert.equal(slot.sink, null);
    assert.equal(timings.timings, null);
    assert.equal(collector.quality, null);
    assert.equal(collector.sessions, null);
  }
  assert.ok(queue.length <= 2);
});

test('updates for the view are batched until the scheduled flush', () => {
  const { collector, emit, queue } = rig();
  let heard = 0;
  const off = collector.subscribe(() => heard++);
  collector.start();
  emit(stats(1));
  emit(stats(2));
  assert.equal(queue.length, 1);
  queue.shift()!();
  assert.equal(heard, 1);
  assert.equal(collector.snapshot(), collector.version);
  off();
  collector.stop();
});
