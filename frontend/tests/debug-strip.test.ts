import assert from 'node:assert/strict';
import { test } from 'node:test';

import { summarize } from '../src/infra/debug/stats.ts';
import {
  axis,
  DEFAULT_SECTIONS,
  DEFAULT_SORTS,
  hotP95,
  loadSections,
  loadSorts,
  nextSort,
  parseSorts,
  parseSections,
  place,
  pool,
  routeParts,
  saveSections,
  saveSorts,
  SECTIONS_KEY,
  sectionAxis,
  SORT_KEY,
  sortRows,
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

test('each section sorts its rows by med, p95, err or n, desc first, ties keep their order', () => {
  const row = (key: string, values: number[], errors = 0) => ({ key, summary: summarize(values), errors });
  const rows = [row('a', [10, 10, 10], 0), row('b', [50, 50, 400], 3), row('c', [30], 1), row('d', [20, 20, 20], 0)];
  const keys = (col: 'med' | 'p95' | 'err' | 'n', dir: 'desc' | 'asc') => sortRows(rows, { col, dir }).map((r) => r.key);
  assert.deepEqual(keys('med', 'desc'), ['b', 'c', 'd', 'a']);
  assert.deepEqual(keys('med', 'asc'), ['a', 'd', 'c', 'b']);
  assert.deepEqual(keys('p95', 'desc')[0], 'b');
  assert.deepEqual(keys('err', 'desc'), ['b', 'c', 'a', 'd']);
  assert.deepEqual(keys('n', 'desc'), ['a', 'b', 'd', 'c']);
  assert.deepEqual(keys('n', 'asc'), ['c', 'a', 'b', 'd']);
  assert.deepEqual(
    rows.map((r) => r.key),
    ['a', 'b', 'c', 'd']
  );
  assert.deepEqual(nextSort({ col: 'n', dir: 'desc' }, 'p95'), { col: 'p95', dir: 'desc' });
  assert.deepEqual(nextSort({ col: 'p95', dir: 'desc' }, 'p95'), { col: 'p95', dir: 'asc' });
  assert.deepEqual(nextSort({ col: 'p95', dir: 'asc' }, 'p95'), { col: 'p95', dir: 'desc' });
});

test('sort state defaults to most asked first and round trips per section', () => {
  assert.deepEqual(DEFAULT_SORTS.api, { col: 'n', dir: 'desc' });
  assert.deepEqual(parseSorts('{bad'), DEFAULT_SORTS);
  assert.deepEqual(parseSorts('{"chat":{"col":"med","dir":"asc"},"api":{"col":"x","dir":"asc"}}'), { ...DEFAULT_SORTS, chat: { col: 'med', dir: 'asc' } });
  const map = new Map<string, string>();
  const storage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
  assert.deepEqual(loadSorts(storage), DEFAULT_SORTS);
  const next = { ...DEFAULT_SORTS, chat: { col: 'med' as const, dir: 'desc' as const }, api: { col: 'p95' as const, dir: 'asc' as const } };
  saveSorts(storage, next);
  assert.deepEqual([...map.keys()], [SORT_KEY]);
  assert.equal(SORT_KEY, 'settings.timingsSort');
  assert.deepEqual(loadSorts(storage), next);
});
