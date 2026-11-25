import assert from 'node:assert/strict';
import { test } from 'node:test';

import { matchParts } from '../src/utils/match.ts';

test('the matched part of a name is cut out whatever its case', () => {
  assert.deepEqual(matchParts('alice', 'al'), ['', 'al', 'ice']);
  assert.deepEqual(matchParts('Alice', 'aL'), ['', 'Al', 'ice']);
  assert.deepEqual(matchParts('bitrate_bob', 'bob'), ['bitrate_', 'bob', '']);
  assert.deepEqual(matchParts('alice', 'zz'), ['alice', '', '']);
  assert.deepEqual(matchParts('alice', ''), ['alice', '', '']);
});
