import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mean, niceTicks, percentile, summarize } from '../src/infra/debug/stats.ts';
import { layout, SessionLog, type Session } from '../src/infra/debug/timeline.ts';

test('percentiles interpolate between the sorted values', () => {
  const sorted = [10, 20, 30, 40, 50];
  assert.equal(percentile(sorted, 0.25), 20);
  assert.equal(percentile(sorted, 0.5), 30);
  assert.equal(percentile(sorted, 0.75), 40);
  assert.equal(percentile(sorted, 0.95), 48);
  assert.equal(percentile(sorted, 0), 10);
  assert.equal(percentile(sorted, 1), 50);
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(percentile([1, 2, 3, 4], 0.25), 1.75);
});

test('a summary sorts its input and gives the box numbers', () => {
  const s = summarize([100, 1, 50, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(s.n, 11);
  assert.equal(s.min, 1);
  assert.equal(s.p25, 3.5);
  assert.equal(s.median, 6);
  assert.equal(s.p75, 8.5);
  assert.equal(s.p95, 75);
  assert.equal(s.max, 100);
  assert.equal(s.mean, 195 / 11);
});

test('no samples give NaN and one sample gives itself everywhere', () => {
  const none = summarize([]);
  assert.equal(none.n, 0);
  for (const v of [none.min, none.p25, none.median, none.mean, none.p75, none.p95, none.max]) assert.ok(Number.isNaN(v));
  assert.ok(Number.isNaN(mean([])));
  const one = summarize([42]);
  assert.equal(one.n, 1);
  for (const v of [one.min, one.p5, one.p25, one.median, one.mean, one.p75, one.p95, one.max]) assert.equal(v, 42);
});

test('ticks cover the max in round steps', () => {
  assert.deepEqual(niceTicks(0), [0]);
  assert.deepEqual(niceTicks(380), [0, 100, 200, 300, 400]);
  assert.deepEqual(niceTicks(1000), [0, 250, 500, 750, 1000]);
});

test('gaps between sessions collapse and carry the time off', () => {
  const sessions: Session[] = [
    { id: 4, name: 'dummy-a', avatar: 7, start: 1000, end: 3500 },
    { id: 5, name: 'dummy-b', avatar: null, start: 60_000, end: null }
  ];
  const t = [1000, 2000, 3000, 60_000, 61_000, 63_000];
  const session = [4, 4, 4, 5, 5, 5];
  const l = layout(t, session, sessions);
  assert.deepEqual(l.xs, [0, 1000, 2000, 2000, 3000, 5000]);
  assert.equal(l.span, 5000);
  assert.deepEqual(l.runs, [
    { session: 4, name: 'dummy-a', avatar: 7, from: 0, to: 3, x: 0 },
    { session: 5, name: 'dummy-b', avatar: null, from: 3, to: 6, x: 2000 }
  ]);
  assert.deepEqual(l.gaps, [{ x: 2000, name: 'dummy-a', from: 3500, to: 60_000 }]);
});

test('an ended last session leaves a gap open to now', () => {
  const sessions: Session[] = [{ id: 0, name: 'dummy-a', avatar: null, start: 0, end: 2500 }];
  const l = layout([0, 1000, 2000], [0, 0, 0], sessions);
  assert.deepEqual(l.gaps, [{ x: 2000, name: 'dummy-a', from: 2500, to: null }]);
});

test('a session dropped from the list still lays out, timed by its samples', () => {
  const sessions: Session[] = [{ id: 2, name: 'dummy-b', avatar: null, start: 9000, end: null }];
  const l = layout([1000, 2000, 9000], [1, 1, 2], sessions);
  assert.deepEqual(l.xs, [0, 1000, 1000]);
  assert.equal(l.runs[0]!.name, '');
  assert.deepEqual(l.gaps, [{ x: 1000, name: '', from: 2000, to: 9000 }]);
});

test('no samples lay out to nothing', () => {
  const l = layout([], [], []);
  assert.deepEqual(l, { xs: [], span: 1, runs: [], gaps: [] });
});

test('the session log ends the open session when the next begins', () => {
  const log = new SessionLog();
  assert.equal(log.current, null);
  log.begin('dummy-a', 10);
  log.begin('dummy-b', 20);
  log.end(30);
  log.end(40);
  assert.deepEqual(log.list, [
    { id: 0, name: 'dummy-a', avatar: null, start: 10, end: 20 },
    { id: 1, name: 'dummy-b', avatar: null, start: 20, end: 30 }
  ]);
  assert.equal(log.current, null);
  log.clear();
  assert.equal(log.list.length, 0);
  assert.equal(log.begin('dummy-c', 50).id, 0);
});

test('a few samples sit at the right end of a line sized for the full buffer', () => {
  const sessions: Session[] = [{ id: 0, name: 'dummy-a', avatar: null, start: 0, end: null }];
  const l = layout([0, 1000, 2000, 3000, 4000], [0, 0, 0, 0, 0], sessions, 101);
  assert.equal(l.span, 100_000);
  assert.deepEqual(l.xs, [96_000, 97_000, 98_000, 99_000, 100_000]);
  assert.equal(l.runs[0]!.x, 96_000);
});

test('one sample sits at the right edge', () => {
  const sessions: Session[] = [{ id: 0, name: 'dummy-a', avatar: null, start: 0, end: null }];
  const l = layout([5000], [0], sessions, 600);
  assert.equal(l.span, 599_000);
  assert.deepEqual(l.xs, [599_000]);
});

test('gaps and sessions shift with the samples while the buffer fills', () => {
  const sessions: Session[] = [
    { id: 4, name: 'dummy-a', avatar: 7, start: 1000, end: 3500 },
    { id: 5, name: 'dummy-b', avatar: null, start: 60_000, end: null }
  ];
  const l = layout([1000, 2000, 3000, 60_000, 61_000, 62_000], [4, 4, 4, 5, 5, 5], sessions, 11);
  assert.equal(l.span, 8000);
  assert.deepEqual(l.xs, [4000, 5000, 6000, 6000, 7000, 8000]);
  assert.deepEqual(
    l.runs.map((r) => r.x),
    [4000, 6000]
  );
  assert.deepEqual(l.gaps, [{ x: 6000, name: 'dummy-a', from: 3500, to: 60_000 }]);
});

test('a full buffer stretches across the whole line as before', () => {
  const sessions: Session[] = [{ id: 0, name: 'dummy-a', avatar: null, start: 0, end: null }];
  const l = layout([0, 1000, 2000], [0, 0, 0], sessions, 3);
  assert.equal(l.span, 2000);
  assert.deepEqual(l.xs, [0, 1000, 2000]);
});
