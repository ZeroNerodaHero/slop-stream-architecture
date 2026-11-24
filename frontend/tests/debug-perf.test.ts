import assert from 'node:assert/strict';
import { test } from 'node:test';

import { debug, onDebugChange, setDebug } from '../src/infra/debug-flag.ts';
import { makeEntry, Ring, RING_SIZE } from '../src/infra/frames.ts';
import { rtPerfAnswer, rtPerfBegin, rtPerfHeld, rtPerfMark, rtPerfSay } from '../src/infra/rt/perf.ts';
import { perfBegin, perfMark, watchPerfHeld } from '../src/infra/watch-perf.ts';

function ours(): string[] {
  return [...performance.getEntriesByType('mark'), ...performance.getEntriesByType('measure')]
    .map((e) => e.name)
    .filter((n) => n.startsWith('watch:') || n.startsWith('rt:'));
}

test('with debug off the perf calls make no marks and hold nothing', () => {
  setDebug(false, false);
  perfBegin('press', 'cats');
  perfMark('first-frame');
  rtPerfBegin('chat:cats', 'press');
  rtPerfMark('chat:cats', 'subbed');
  rtPerfSay('k1');
  rtPerfAnswer('k1', true);
  rtPerfSay('k2');
  assert.deepEqual(ours(), []);
  assert.equal(watchPerfHeld(), 0);
  assert.deepEqual(rtPerfHeld(), { runs: 0, says: 0 });
});

test('with debug on the perf calls mark, and turning off clears every mark and map', () => {
  setDebug(true, false);
  assert.equal(debug.on, true);
  perfBegin('press', 'dogs', 1);
  perfMark('mounted', 2);
  rtPerfBegin('chat:dogs', 'press', 1);
  rtPerfSay('k3', 1);
  assert.ok(ours().length > 0);
  assert.equal(watchPerfHeld(), 2);
  assert.deepEqual(rtPerfHeld(), { runs: 1, says: 1 });
  setDebug(false, false);
  assert.equal(debug.on, false);
  assert.deepEqual(ours(), []);
  assert.equal(watchPerfHeld(), 0);
  assert.deepEqual(rtPerfHeld(), { runs: 0, says: 0 });
});

test('a finished run is forgotten and unfinished runs stay bounded', () => {
  setDebug(true, false);
  rtPerfBegin('chat:a', 'press', 1);
  rtPerfMark('chat:a', 'subbed', 2);
  rtPerfMark('chat:a', 'history', 3);
  rtPerfMark('chat:a', 'first-line', 4);
  assert.equal(rtPerfHeld().runs, 0);
  for (let i = 0; i < 500; i++) {
    rtPerfBegin(`chat:${i}`, 'press', i);
    rtPerfSay(`say${i}`, i);
  }
  assert.ok(rtPerfHeld().runs <= 50);
  assert.ok(rtPerfHeld().says <= 50);
  for (let i = 0; i < 500; i++) perfMark(`p${i}`, i);
  assert.ok(watchPerfHeld() <= 50);
  setDebug(false, false);
  assert.deepEqual(ours(), []);
});

test('the perf query keeps debug on while the inspector is off', () => {
  setDebug(false, true);
  assert.equal(debug.on, true);
  assert.equal(debug.inspector, false);
  setDebug(false, false);
});

test('listeners hear only real changes', () => {
  setDebug(false, false);
  const heard: boolean[] = [];
  const stop = onDebugChange((on) => heard.push(on));
  setDebug(true, false);
  setDebug(true, true);
  setDebug(false, false);
  setDebug(false, false);
  stop();
  setDebug(true, false);
  setDebug(false, false);
  assert.deepEqual(heard, [true, false]);
});

test('the ring caps at RING_SIZE and clear releases every entry', () => {
  const ring = new Ring();
  for (let i = 0; i < RING_SIZE + 25; i++) ring.push(makeEntry('/t', 'in', { type: 'n', i }));
  assert.equal(ring.count, RING_SIZE);
  assert.equal(ring.toArray().length, RING_SIZE);
  assert.match(ring.at(0)!.text, new RegExp(`"i":${RING_SIZE + 24}`));
  ring.clear();
  assert.equal(ring.count, 0);
  assert.equal(ring.at(0), undefined);
  assert.deepEqual(ring.toArray(), []);
});

test('frames hide tokens and tickets', () => {
  const e = makeEntry('/t', 'out', { type: 'join', token: 'secret', ticket: 'secret' });
  assert.doesNotMatch(e.text, /secret/);
});
