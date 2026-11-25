import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Mention } from '../src/infra/api.ts';
import { MENTION_SCAN, mentionQueryAt } from '../src/infra/mention-query.ts';
import {
  askMentions,
  cachedMentions,
  cacheMentions,
  localMentions,
  MENTION_CACHE,
  MENTION_LIMIT,
  type MentionLine,
  mentionRows,
  mergeMentions,
  moveMention,
  nearMentions
} from '../src/infra/mentions.ts';

function line(from: string, extra: Partial<MentionLine> = {}): MentionLine {
  return { from, verified: true, avatar: null, ...extra };
}

function person(name: string): Mention {
  return { name, verified: true, avatar: null };
}

const names = (list: readonly Mention[]) => list.map((m) => m.name);

test('a bare @ at the caret is an empty query', () => {
  assert.deepEqual(mentionQueryAt('@', 1), { start: 0, query: '' });
  assert.deepEqual(mentionQueryAt('hi @', 4), { start: 3, query: '' });
});

test('the word at the caret gives the query, lowercased, up to the caret', () => {
  assert.deepEqual(mentionQueryAt('hey @Ab_c-1', 11), { start: 4, query: 'ab_c-1' });
  assert.deepEqual(mentionQueryAt('hey @abc there', 7), { start: 4, query: 'ab' });
  assert.deepEqual(mentionQueryAt('(@abc', 5), { start: 1, query: 'abc' });
});

test('no query without an @ word at the caret', () => {
  assert.equal(mentionQueryAt('', 0), null);
  assert.equal(mentionQueryAt('hello', 5), null);
  assert.equal(mentionQueryAt('@abc def', 8), null);
  assert.equal(mentionQueryAt('@abc ', 5), null);
  assert.equal(mentionQueryAt('mail@host', 9), null);
  assert.equal(mentionQueryAt('@@ab', 4), null);
  assert.equal(mentionQueryAt('@a.b', 4), null);
  assert.equal(mentionQueryAt(':ab', 3), null);
});

test('the scan stops after 33 characters', () => {
  assert.equal(MENTION_SCAN, 33);
  const longest = '@' + 'a'.repeat(32);
  assert.deepEqual(mentionQueryAt(longest, longest.length), { start: 0, query: 'a'.repeat(32) });
  const tooLong = '@' + 'a'.repeat(33);
  assert.equal(mentionQueryAt(tooLong, tooLong.length), null);
});

test('local candidates are distinct authors, most recent first', () => {
  const lines = [line('ann'), line('bob'), line('ann'), line('cat'), line('bob')];
  assert.deepEqual(names(localMentions(lines, '')), ['bob', 'cat', 'ann']);
});

test('local candidates filter by prefix, case-insensitive', () => {
  const lines = [line('Abe'), line('bob'), line('abby'), line('cab')];
  assert.deepEqual(names(localMentions(lines, 'ab')), ['abby', 'Abe']);
});

test('guests, skipped lines and me are not candidates', () => {
  const lines = [line('guest', { verified: false }), line('bot', { groups: [{ name: 'bot' }, { name: 'mods' }] }), line('mod', { groups: [{ name: 'mods' }] }), line('me'), line('ann'), line('host', { verified: false, streamer: true })];
  const found = localMentions(lines, '', { me: 'me', hide: 'bot' });
  assert.deepEqual(names(found), ['host', 'ann', 'mod']);
});

test('the streamer is always first when it matches, even with no lines', () => {
  assert.deepEqual(names(localMentions([], '', { first: 'host' })), ['host']);
  const lines = [line('ann'), line('host', { streamer: true, avatar: 4 }), line('hal')];
  const found = localMentions(lines, 'h', { first: 'host' });
  assert.deepEqual(names(found), ['host', 'hal']);
  assert.equal(found[0]?.avatar, 4);
  assert.deepEqual(names(localMentions(lines, 'a', { first: 'host' })), ['ann']);
  assert.deepEqual(names(localMentions(lines, '', { first: 'host', me: 'host' })), ['host', 'hal', 'ann']);
});

test('a dm offers only the other user, filtered by prefix', () => {
  const other: Mention = { name: 'zed', verified: true, avatar: 2 };
  assert.deepEqual(localMentions([], '', { first: other }), [other]);
  assert.deepEqual(localMentions([], 'ze', { first: other }), [other]);
  assert.deepEqual(localMentions([], 'a', { first: other }), []);
});

test('merge puts local first, dedupes by name and caps at 6', () => {
  const merged = mergeMentions([person('ann'), person('abe')], [person('Ann'), person('al'), person('abe'), person('a1'), person('a2'), person('a3'), person('a4')]);
  assert.deepEqual(names(merged), ['ann', 'abe', 'al', 'a1', 'a2', 'a3']);
  assert.equal(merged.length, MENTION_LIMIT);
  assert.deepEqual(names(mergeMentions([], [person('x')])), ['x']);
});

test('the cache keeps at most 20 prefixes, dropping the least recently used', () => {
  const cache = new Map<string, Mention[]>();
  for (let i = 0; i < MENTION_CACHE; i++) cacheMentions(cache, `q${i}`, [person(`q${i}`)]);
  assert.ok(cachedMentions(cache, 'q0'));
  cacheMentions(cache, 'new', [person('new')]);
  assert.equal(cache.size, MENTION_CACHE);
  assert.ok(cache.has('q0'));
  assert.equal(cache.has('q1'), false);
  assert.ok(cache.has('new'));
});

test('a shorter prefix with fewer than the limit narrows locally', () => {
  const cache = new Map<string, Mention[]>();
  cacheMentions(cache, 'a', [person('abby'), person('al'), person('Abe')]);
  assert.deepEqual(names(cachedMentions(cache, 'ab') ?? []), ['abby', 'Abe']);
  assert.deepEqual(cachedMentions(cache, 'xyz'), undefined);
});

test('a shorter prefix that hit the limit does not narrow', () => {
  const cache = new Map<string, Mention[]>();
  cacheMentions(cache, 'a', ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'].map(person));
  assert.equal(cachedMentions(cache, 'a1'), undefined);
  cacheMentions(cache, 'ab', [person('abe')]);
  assert.deepEqual(names(cachedMentions(cache, 'abe') ?? []), ['abe']);
});

test('while a longer prefix is asked, the nearest cached prefix previews it', () => {
  const cache = new Map<string, Mention[]>();
  cacheMentions(cache, 'a', ['a1', 'ab1', 'ab2', 'a4', 'a5', 'Abc'].map(person));
  cacheMentions(cache, 'ab', ['ab1', 'ab2', 'Abc', 'abd', 'abe', 'abf'].map(person));
  assert.deepEqual(names(nearMentions(cache, 'abc')), ['Abc']);
  assert.deepEqual(names(nearMentions(cache, 'ab')), ['ab1', 'ab2', 'Abc']);
  assert.deepEqual(nearMentions(cache, 'zz'), []);
});

test('rows run from the last number at the top down to #1 at the bottom', () => {
  assert.deepEqual(mentionRows(6), [5, 4, 3, 2, 1, 0]);
  assert.deepEqual(mentionRows(1), [0]);
  assert.deepEqual(mentionRows(0), []);
});

test('up moves toward the top, down toward #1, wrapping', () => {
  assert.equal(moveMention(0, 'ArrowUp', 6), 1);
  assert.equal(moveMention(5, 'ArrowUp', 6), 0);
  assert.equal(moveMention(1, 'ArrowDown', 6), 0);
  assert.equal(moveMention(0, 'ArrowDown', 6), 5);
  assert.equal(moveMention(0, 'ArrowUp', 1), 0);
  assert.equal(moveMention(0, 'ArrowDown', 0), 0);
});

test('a bare @ asks the server only when logged in and local candidates are short of the limit', () => {
  assert.equal(askMentions('room', 'me', '', 0), true);
  assert.equal(askMentions('room', 'me', '', MENTION_LIMIT - 1), true);
  assert.equal(askMentions('room', 'me', '', MENTION_LIMIT), false);
  assert.equal(askMentions('room', 'me', '', MENTION_LIMIT + 3), false);
  assert.equal(askMentions(null, 'me', '', 0), false);
  assert.equal(askMentions('room', null, '', 0), false);
  assert.equal(askMentions('room', undefined, 'a', 0), false);
});

test('a typed prefix always asks the server when logged in', () => {
  assert.equal(askMentions('room', 'me', 'a', 0), true);
  assert.equal(askMentions('room', 'me', 'a', MENTION_LIMIT + 3), true);
  assert.equal(askMentions(null, 'me', 'a', 0), false);
});

test('the bare @ server result never narrows a typed prefix', () => {
  const cache = new Map<string, Mention[]>();
  cacheMentions(cache, '', [person('host'), person('ann')]);
  assert.deepEqual(names(cachedMentions(cache, '') ?? []), ['host', 'ann']);
  assert.equal(cachedMentions(cache, 'a'), undefined);
  assert.deepEqual(nearMentions(cache, 'a'), []);
  assert.deepEqual(nearMentions(cache, ''), []);
});

test('a bare @ list merges the server tiers after the streamer, capped at 6, and navigates bottom-up', () => {
  const local = localMentions([], '', { first: 'host' });
  assert.deepEqual(names(local), ['host']);
  assert.equal(askMentions('room', 'me', '', local.length), true);
  const server = ['host', 'ann', 'bob', 'cat', 'dan', 'eve', 'fay'].map(person);
  const found = mergeMentions(local, server);
  assert.deepEqual(names(found), ['host', 'ann', 'bob', 'cat', 'dan', 'eve']);
  assert.equal(found.length, MENTION_LIMIT);
  assert.equal(new Set(names(found).map((n) => n.toLowerCase())).size, found.length);
  const rows = mentionRows(found.length);
  assert.deepEqual(rows, [5, 4, 3, 2, 1, 0]);
  assert.deepEqual(rows.map((i) => found[i]?.name), ['eve', 'dan', 'cat', 'bob', 'ann', 'host']);
  assert.equal(found[rows[rows.length - 1] ?? -1]?.name, 'host');
  let lit = 0;
  lit = moveMention(lit, 'ArrowUp', found.length);
  assert.equal(lit, 1);
  for (let i = 0; i < 4; i++) lit = moveMention(lit, 'ArrowUp', found.length);
  assert.equal(lit, 5);
  assert.equal(moveMention(lit, 'ArrowUp', found.length), 0);
  assert.equal(moveMention(0, 'ArrowDown', found.length), 5);
});
