import assert from 'node:assert/strict';
import { test } from 'node:test';

import { contrast, contrastWords, DARK, LIGHT, parseHex } from '../src/infra/theme.ts';

test('hex input takes six or three digits with or without a hash', () => {
  assert.equal(parseHex('4F8BFF'), '#4f8bff');
  assert.equal(parseHex('#1c1418'), '#1c1418');
  assert.equal(parseHex(' fff '), '#ffffff');
  assert.equal(parseHex('#a1b'), '#aa11bb');
});

test('anything else is not a colour', () => {
  for (const raw of ['', '#', '12', '1234', '12345', '1234567', 'ggg', '#zzzzzz', '##fff', 'red']) assert.equal(parseHex(raw), null);
});

test('contrast reads as a sentence', () => {
  assert.deepEqual(contrastWords(contrast(DARK.textPrimary, DARK.background)), { text: '17.0:1 · reads well', readable: true });
  assert.deepEqual(contrastWords(contrast(LIGHT.textPrimary, LIGHT.background)), { text: '18.6:1 · reads well', readable: true });
  assert.deepEqual(contrastWords(4.5), { text: '4.5:1 · reads well', readable: true });
  assert.deepEqual(contrastWords(4.46), { text: '4.5:1 · hard to read', readable: false });
  assert.deepEqual(contrastWords(1.3), { text: '1.3:1 · hard to read', readable: false });
});
