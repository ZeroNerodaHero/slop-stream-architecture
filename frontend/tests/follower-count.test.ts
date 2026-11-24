import assert from 'node:assert/strict';
import { test } from 'node:test';

import { recount } from '../src/infra/follower-count.ts';

const list = () => [
  { name: 'a', followers: 2, following: false },
  { name: 'b', followers: 0, following: false }
];

test('follow then unfollow moves the count up and back down', () => {
  const up = recount(list(), 'a', true);
  assert.deepEqual(up[0], { name: 'a', followers: 3, following: true });
  assert.deepEqual(up[1], list()[1]);
  assert.deepEqual(recount(up, 'a', false)[0], { name: 'a', followers: 2, following: false });
});

test('a repeat of the same state does not count twice', () => {
  const up = recount(list(), 'a', true);
  assert.equal(recount(up, 'a', true)[0].followers, 3);
});

test('the count never goes below zero', () => {
  const odd = [{ name: 'b', followers: 0, following: true }];
  assert.equal(recount(odd, 'b', false)[0].followers, 0);
});

test('a name not in the list leaves it alone', () => {
  assert.deepEqual(recount(list(), 'zz', true), list());
});
