import assert from 'node:assert/strict';
import { test } from 'node:test';

import { summarize } from '../src/infra/debug/stats.ts';
import {
  axis,
  DEFAULT_SECTIONS,
  hotP95,
  loadSections,
  parseSections,
  place,
  pool,
  routeParts,
  saveSections,
  SECTIONS_KEY,
  sectionAxis,
  serializeSections
} from '../src/infra/debug/strip.ts';

test('a section pools every sample of every metric in it', () => {
  const rows = [
    { recent: [10, 20, 30], errors: 1 },
    { recent: [40, 50] },
    { recent: [60, 70, 80, 90, 100], errors: 2 }
  ];
  const p = pool(rows);
  assert.equal(p.n, 10);
  assert.equal(p.median, 55);
  assert.equal(p.p95, summarize([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]).p95);
  assert.equal(p.errors, 3);
  const none = pool([]);
  assert.equal(none.n, 0);
  assert.equal(none.errors, 0);
  assert.ok(Number.isNaN(none.median));
});

test('the axis starts at a round value near the section min, not at 0', () => {
  const a = sectionAxis([summarize([45, 60, 70]), summarize([52, 103, 108])]);
  assert.deepEqual(a, { lo: 40, hi: 120, ticks: [40, 60, 80, 100, 120] });
  assert.ok(a.lo > 0);
  assert.ok(a.lo <= 45 && a.hi >= 108);
});

test('axis ticks are evenly spaced round numbers covering the range', () => {
  assert.deepEqual(axis(20, 1900), { lo: 0, hi: 2000, ticks: [0, 500, 1000, 1500, 2000] });
  assert.deepEqual(axis(310, 395), { lo: 300, hi: 400, ticks: [300, 325, 350, 375, 400] });
  const one = axis(74, 74);
  assert.ok(one.lo <= 74 && one.hi > 74);
  const flat = axis(Number.NaN, Number.NaN);
  assert.deepEqual(flat, { lo: 0, hi: 1, ticks: [0, 1] });
  assert.deepEqual(sectionAxis([summarize([])]), flat);
});

test('a value places as a clamped percent of the axis', () => {
  const a = { lo: 40, hi: 120, ticks: [] };
  assert.equal(place(40, a), 0);
  assert.equal(place(80, a), 50);
  assert.equal(place(120, a), 100);
  assert.equal(place(10, a), 0);
  assert.equal(place(500, a), 100);
});

test('p95 is flagged only well above the median', () => {
  assert.equal(hotP95(summarize([60, 60, 60, 60, 100])), true);
  assert.equal(hotP95(summarize([60, 62, 64, 66, 68])), false);
  assert.equal(hotP95(summarize([])), false);
});

test('an api key splits into a method badge and the path past /api', () => {
  assert.deepEqual(routeParts('GET /api/streamers/:name/about-page'), { method: 'GET', badge: 'G', path: '/streamers/:name/about-page' });
  assert.deepEqual(routeParts('POST /api/streams/:name/watch'), { method: 'POST', badge: 'P', path: '/streams/:name/watch' });
  assert.deepEqual(routeParts('DELETE /api/groups/:name'), { method: 'DELETE', badge: 'D', path: '/groups/:name' });
});

test('section state falls back to the defaults per key and on bad json', () => {
  assert.deepEqual(DEFAULT_SECTIONS, { chat: false, watch: false, api: true });
  assert.deepEqual(parseSections(null), DEFAULT_SECTIONS);
  assert.deepEqual(parseSections('{not json'), DEFAULT_SECTIONS);
  assert.deepEqual(parseSections('[true]'), DEFAULT_SECTIONS);
  assert.deepEqual(parseSections('null'), DEFAULT_SECTIONS);
  assert.deepEqual(parseSections('"open"'), DEFAULT_SECTIONS);
  assert.deepEqual(parseSections('{"chat":true}'), { chat: true, watch: false, api: true });
  assert.deepEqual(parseSections('{"api":false,"watch":"yes","x":true}'), { chat: false, watch: false, api: false });
});

test('section state round trips through storage under one key', () => {
  const map = new Map<string, string>();
  const storage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
  assert.deepEqual(loadSections(storage), DEFAULT_SECTIONS);
  const next = { chat: true, watch: false, api: false };
  saveSections(storage, next);
  assert.deepEqual([...map.keys()], [SECTIONS_KEY]);
  assert.equal(map.get('settings.timingsSections'), serializeSections(next));
  assert.deepEqual(loadSections(storage), next);
  const broken = {
    getItem: () => {
      throw new Error('denied');
    },
    setItem: () => {
      throw new Error('denied');
    }
  };
  assert.deepEqual(loadSections(broken), DEFAULT_SECTIONS);
  assert.doesNotThrow(() => saveSections(broken, next));
  assert.deepEqual(loadSections(null), DEFAULT_SECTIONS);
});
