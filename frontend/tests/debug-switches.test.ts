import assert from 'node:assert/strict';
import { test } from 'node:test';

import { debug, DEBUG_KEYS, type DebugSink, migrateDebugSettings, onDebugChange, setDebug } from '../src/infra/debug-flag.ts';
import { QualityCollector, TimingsCollector } from '../src/infra/debug/collector.ts';
import { makeEntry, Ring } from '../src/infra/frames.ts';
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

function rig() {
  const fake = (async () => new Response(null)) as typeof fetch;
  const before = globalThis.fetch;
  globalThis.fetch = fake;
  const slot: { sink: DebugSink | null } = { sink: null };
  const timings = new TimingsCollector({ slot, host: globalThis, origin: () => ORIGIN, clock: () => 0, schedule: () => undefined });
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
  const frames: { ring: Ring | null } = { ring: null };
  const record = (i: number) => {
    if (debug.messages) (frames.ring ??= new Ring()).push(makeEntry('/t', 'in', { type: 'n', i }));
  };
  const offs = [
    onDebugChange('messages', (on) => {
      if (on) return;
      frames.ring?.clear();
      frames.ring = null;
    }),
    onDebugChange('timings', (on) => (on ? timings.start() : timings.stop())),
    onDebugChange('quality', (on) => (on ? quality.start() : quality.stop()))
  ];
  const done = () => {
    setDebug('messages', false);
    setDebug('timings', false, false);
    setDebug('quality', false);
    for (const off of offs) off();
    globalThis.fetch = before;
  };
  const fill = async (i: number) => {
    record(i);
    await fetch(`${ORIGIN}/api/groups/g${i}`);
    for (const fn of listeners) fn(stats(i));
  };
  return { fake, slot, timings, quality, listeners, frames, record, fill, done };
}

test('turning timings off removes the fetch wrapper and leaves quality and frames', async () => {
  const r = rig();
  try {
    setDebug('messages', true);
    setDebug('timings', true, false);
    setDebug('quality', true);
    assert.notEqual(globalThis.fetch, r.fake);
    await r.fill(1);
    setDebug('timings', false, false);
    assert.equal(globalThis.fetch, r.fake);
    assert.equal(r.timings.api, null);
    assert.equal(r.slot.sink, null);
    assert.equal(r.quality.quality!.count, 1);
    assert.equal(r.listeners.size, 1);
    assert.equal(r.frames.ring!.count, 1);
  } finally {
    r.done();
  }
});

test('turning quality off drops its data and leaves the fetch wrapper and frames', async () => {
  const r = rig();
  try {
    setDebug('messages', true);
    setDebug('timings', true, false);
    setDebug('quality', true);
    await r.fill(1);
    setDebug('quality', false);
    assert.equal(r.quality.quality, null);
    assert.equal(r.quality.sessions, null);
    assert.equal(r.listeners.size, 0);
    assert.notEqual(globalThis.fetch, r.fake);
    assert.equal(r.timings.api!.size(), 1);
    assert.equal(r.frames.ring!.count, 1);
  } finally {
    r.done();
  }
});

test('turning messages off clears only the frame ring', async () => {
  const r = rig();
  try {
    setDebug('messages', true);
    setDebug('timings', true, false);
    setDebug('quality', true);
    await r.fill(1);
    setDebug('messages', false);
    assert.equal(r.frames.ring, null);
    r.record(2);
    assert.equal(r.frames.ring, null);
    assert.notEqual(globalThis.fetch, r.fake);
    assert.equal(r.timings.api!.size(), 1);
    assert.equal(r.quality.quality!.count, 1);
    assert.equal(r.listeners.size, 1);
  } finally {
    r.done();
  }
});

test('each switch turned on alone starts only its own feature', () => {
  const r = rig();
  try {
    setDebug('messages', true);
    assert.equal(globalThis.fetch, r.fake);
    assert.equal(r.listeners.size, 0);
    setDebug('messages', false);
    setDebug('timings', true, false);
    assert.notEqual(globalThis.fetch, r.fake);
    assert.equal(r.listeners.size, 0);
    assert.equal(debug.messages, false);
    setDebug('timings', false, false);
    setDebug('quality', true);
    assert.equal(globalThis.fetch, r.fake);
    assert.equal(r.listeners.size, 1);
    assert.equal(debug.timings, false);
  } finally {
    r.done();
  }
});

test('twenty on and off cycles per switch leave nothing behind', async () => {
  const r = rig();
  try {
    for (let i = 0; i < 20; i++) {
      setDebug('messages', true);
      r.record(i);
      assert.equal(r.frames.ring!.count, 1);
      setDebug('messages', false);
      assert.equal(r.frames.ring, null);
    }
    for (let i = 0; i < 20; i++) {
      setDebug('timings', true, false);
      await fetch(`${ORIGIN}/api/groups/g${i}`);
      assert.equal(r.timings.api!.size(), 1);
      setDebug('timings', false, false);
      assert.equal(r.timings.api, null);
      assert.equal(r.timings.timings, null);
      assert.equal(r.slot.sink, null);
      assert.equal(globalThis.fetch, r.fake);
    }
    for (let i = 0; i < 20; i++) {
      setDebug('quality', true);
      for (const fn of r.listeners) fn(stats(i));
      assert.equal(r.quality.quality!.count, 1);
      setDebug('quality', false);
      assert.equal(r.quality.quality, null);
      assert.equal(r.quality.sessions, null);
      assert.equal(r.quality.stats, null);
      assert.equal(r.listeners.size, 0);
    }
    assert.deepEqual([debug.messages, debug.timings, debug.quality], [false, false, false]);
  } finally {
    r.done();
  }
});

function storage(items: Record<string, string>) {
  const map = new Map(Object.entries(items));
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key)
  };
}

const NEW_KEYS = Object.values(DEBUG_KEYS);

test('migration: the old switch on turns all three on and is removed', () => {
  const s = storage({ 'settings.inspector': 'true' });
  migrateDebugSettings(s);
  assert.deepEqual(
    NEW_KEYS.map((k) => s.map.get(k)),
    ['true', 'true', 'true']
  );
  assert.equal(s.map.has('settings.inspector'), false);
});

test('migration: the old switch off turns all three off and is removed', () => {
  const s = storage({ 'settings.inspector': 'false' });
  migrateDebugSettings(s);
  assert.deepEqual(
    NEW_KEYS.map((k) => s.map.get(k)),
    ['false', 'false', 'false']
  );
  assert.equal(s.map.has('settings.inspector'), false);
});

test('migration: no old switch writes nothing', () => {
  const s = storage({});
  migrateDebugSettings(s);
  assert.equal(s.map.size, 0);
});

test('migration: new keys already there are left untouched', () => {
  const s = storage({ 'settings.inspector': 'true', [DEBUG_KEYS.timings]: 'false' });
  migrateDebugSettings(s);
  assert.deepEqual(Object.fromEntries(s.map), { 'settings.inspector': 'true', [DEBUG_KEYS.timings]: 'false' });
});
