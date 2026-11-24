import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { DebugSink } from '../src/infra/debug-flag.ts';
import { Collector } from '../src/infra/debug/collector.ts';
import { MAX_RUNS, QUALITY_SIZE, QualityRing, sparkline, timedRun, Timings } from '../src/infra/debug/rings.ts';
import type { StreamStats, VideoLine } from '../src/infra/stream-stats.ts';

function sample(i: number) {
  return { t: i, width: 1280, height: 720, fps: 30, bitrate: i, lossPct: 0, droppedPerSec: 0, jitterMs: 1, rttMs: 20 };
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
  const collector = new Collector({
    slot,
    watch: (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    now: () => 0,
    origin: 1000,
    schedule: (fn) => queue.push(fn)
  });
  const emit = (s: StreamStats | null) => {
    for (const fn of listeners) fn(s);
  };
  return { collector, slot, listeners, emit, queue };
}

test('the quality ring caps at 300 samples and wraps oldest first', () => {
  const ring = new QualityRing();
  for (let i = 0; i < QUALITY_SIZE + 50; i++) ring.push(sample(i), 'direct');
  assert.equal(ring.count, QUALITY_SIZE);
  assert.equal(ring.cols.bitrate.length, QUALITY_SIZE);
  const series = ring.series('bitrate');
  assert.equal(series.length, QUALITY_SIZE);
  assert.equal(series[0], 50);
  assert.equal(series[QUALITY_SIZE - 1], QUALITY_SIZE + 49);
  assert.equal(ring.path, 'direct');
  ring.clear();
  assert.equal(ring.count, 0);
  assert.equal(ring.path, null);
  assert.deepEqual(ring.series('bitrate'), []);
});

test('timings keep the last 20 runs per kind', () => {
  const timings = new Timings();
  for (let i = 0; i < 45; i++)
    timings.add(
      'chat',
      timedRun(
        `room${i}`,
        i,
        [
          ['press', i],
          ['subbed', i + 5]
        ],
        0
      )
    );
  timings.add(
    'say',
    timedRun(
      'room',
      0,
      [
        ['say', 0],
        ['ack', 12]
      ],
      0
    )
  );
  assert.equal(timings.runs.chat.length, MAX_RUNS);
  assert.equal(timings.runs.chat[0]!.label, 'room25');
  assert.deepEqual(timings.runs.chat[MAX_RUNS - 1]!.phases, [
    ['press', 0],
    ['subbed', 5]
  ]);
  assert.equal(timings.runs.say.length, 1);
  assert.equal(timings.runs.watch.length, 0);
});

test('a finished run reaches the timings through the sink as ms from its start', () => {
  const { collector, slot } = rig();
  collector.start();
  slot.sink!('watch', 'cats', 100, [
    ['press', 100],
    ['first-frame', 350.4]
  ]);
  assert.deepEqual(collector.timings!.runs.watch, [
    {
      label: 'cats',
      at: 1100,
      phases: [
        ['press', 0],
        ['first-frame', 250]
      ]
    }
  ]);
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

test('stop clears everything, lets go of the source and is idempotent', () => {
  const { collector, slot, listeners, emit } = rig();
  collector.start();
  emit(stats(1));
  slot.sink!('chat', 'room', 0, [['press', 0]]);
  const timings = collector.timings!;
  const quality = collector.quality!;
  collector.stop();
  assert.equal(listeners.size, 0);
  assert.equal(slot.sink, null);
  assert.equal(collector.timings, null);
  assert.equal(collector.quality, null);
  assert.equal(collector.stats, null);
  assert.equal(collector.running, false);
  assert.equal(timings.size(), 0);
  assert.equal(quality.count, 0);
  collector.stop();
  collector.stop();
  assert.equal(listeners.size, 0);
  assert.equal(slot.sink, null);
});

test('start twice subscribes once', () => {
  const { collector, listeners } = rig();
  collector.start();
  collector.start();
  assert.equal(listeners.size, 1);
  collector.stop();
  assert.equal(listeners.size, 0);
});

test('twenty start and stop cycles leave nothing behind', () => {
  const { collector, slot, listeners, emit, queue } = rig();
  for (let i = 0; i < 20; i++) {
    collector.start();
    emit(stats(i));
    slot.sink!('say', 'room', 0, [
      ['say', 0],
      ['ack', 5]
    ]);
    collector.stop();
    assert.equal(listeners.size, 0);
    assert.equal(slot.sink, null);
    assert.equal(collector.timings, null);
    assert.equal(collector.quality, null);
  }
  assert.ok(queue.length <= 1);
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
  off();
  collector.stop();
});

test('the sparkline spans the low to the high bar', () => {
  assert.equal(sparkline([]), '');
  assert.equal(sparkline([1, 1, 1]), '▁▁▁');
  assert.equal(sparkline([0, 7, 14]), '▁▅█');
});
