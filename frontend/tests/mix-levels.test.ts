import assert from 'node:assert/strict';
import { test } from 'node:test';

import { faderMaster, faderRows, keepLevel, keptLevel } from '../src/infra/mix-levels.ts';

const master = { id: 'master', label: 'everyone hears', level: 1, muted: false };

test('a kept level is clamped and needs a number', () => {
  assert.deepEqual(keptLevel({ mic: { level: 2, muted: true } }, 'mic'), { level: 1, muted: true });
  assert.deepEqual(keptLevel({ mic: { level: -1 } }, 'mic'), { level: 0, muted: false });
  assert.equal(keptLevel({ mic: { level: 'loud' } }, 'mic'), null);
  assert.equal(keptLevel(null, 'mic'), null);
});

test('keeping a level leaves the others', () => {
  const raw = keepLevel({ master: { level: 0.5, muted: false } }, 'mic', { level: 0.3, muted: true });
  assert.deepEqual(raw, { master: { level: 0.5, muted: false }, mic: { level: 0.3, muted: true } });
  assert.deepEqual(keptLevel(raw, 'mic'), { level: 0.3, muted: true });
});

test('before the mixer opens the mic and the mix are faders from what was kept', () => {
  const raw = { mic: { level: 0.4, muted: true }, master: { level: 0.7, muted: false } };
  assert.deepEqual(faderRows(false, [], raw), [{ id: 'mic', label: 'mic', level: 0.4, muted: true }]);
  assert.deepEqual(faderRows(false, [], null), [{ id: 'mic', label: 'mic', level: 1, muted: false }]);
  assert.deepEqual(faderMaster(false, master, raw), { ...master, level: 0.7 });
});

test('once the mixer is open the rows are the mixer rows', () => {
  const rows = [{ id: 'mic', label: 'mic', level: 0.2, muted: false }];
  assert.equal(faderRows(true, rows, { mic: { level: 0.9 } }), rows);
  assert.equal(faderMaster(true, master, { master: { level: 0.1 } }), master);
});
