import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PEEK_TTL_MS, TopicRefs } from '../src/infra/rt/refs.ts';
import { FakeClock } from './rt-harness.ts';

function manual() {
  const queue: (() => void)[] = [];
  const sets: string[][] = [];
  const refs = new TopicRefs(
    (topics) => sets.push(topics),
    (run) => queue.push(run)
  );
  const flush = () => {
    while (queue.length) queue.shift()!();
  };
  return { refs, sets, flush };
}

test('two holders of a topic are one topic, and it leaves with the last', () => {
  const { refs, sets, flush } = manual();
  const a = refs.acquire('chat:cats');
  const b = refs.acquire('chat:cats');
  flush();
  assert.deepEqual(sets, [['chat:cats']]);
  a();
  flush();
  assert.equal(sets.length, 1, 'still held by b, so nothing is sent');
  b();
  flush();
  assert.deepEqual(sets, [['chat:cats'], []]);
});

test('a release is idempotent: calling it twice does not steal another holder', () => {
  const { refs, sets, flush } = manual();
  const a = refs.acquire('chat:cats');
  refs.acquire('chat:cats');
  a();
  a();
  a();
  flush();
  assert.equal(refs.count('chat:cats'), 1);
  assert.deepEqual(sets, [['chat:cats']]);
});

test('StrictMode mount, unmount, mount in one tick sends one set', () => {
  const { refs, sets, flush } = manual();
  const first = refs.acquire('chat:cats');
  first();
  const second = refs.acquire('chat:cats');
  flush();
  assert.deepEqual(sets, [['chat:cats']]);
  second();
  refs.acquire('chat:cats');
  flush();
  assert.deepEqual(sets, [['chat:cats']], 'the set did not change, so nothing more went out');
});

test('many changes in one tick are coalesced into one sorted set', () => {
  const { refs, sets, flush } = manual();
  refs.acquire('presence:b');
  refs.acquire('CHAT:Cats');
  const gone = refs.acquire('streams:*');
  gone();
  refs.acquire('presence:a');
  flush();
  assert.deepEqual(sets, [['chat:cats', 'presence:a', 'presence:b']]);
});

test('a set only goes out when the held set changes', () => {
  const { refs, sets, flush } = manual();
  const releases = [];
  for (let i = 0; i < 1000; i++) {
    releases.push(refs.acquire('chat:cats'));
    flush();
  }
  for (const r of releases) {
    r();
    flush();
  }
  assert.deepEqual(sets, [['chat:cats'], []]);
});

function timed() {
  const clock = new FakeClock();
  const queue: (() => void)[] = [];
  const sets: { topics: string[]; peek: string[] }[] = [];
  const refs = new TopicRefs(
    (topics, peek) => sets.push({ topics, peek }),
    (run) => queue.push(run),
    clock
  );
  const flush = () => {
    while (queue.length) queue.shift()!();
  };
  return { clock, refs, sets, flush };
}

test('a press peeks a topic for its ttl and then lets it go', () => {
  const { clock, refs, sets, flush } = timed();
  refs.peek('chat:cats');
  flush();
  assert.deepEqual(sets, [{ topics: ['chat:cats'], peek: ['chat:cats'] }]);
  assert.ok(refs.holds('chat:cats'));
  assert.ok(refs.peeking('chat:cats'));
  clock.advance(PEEK_TTL_MS - 1);
  flush();
  assert.equal(sets.length, 1);
  clock.advance(1);
  flush();
  assert.deepEqual(sets.at(-1), { topics: [], peek: [] });
  assert.ok(!refs.holds('chat:cats'));
});

test('the page that mounts takes the peek over: the topic stays, the ttl no longer applies', () => {
  const { clock, refs, sets, flush } = timed();
  refs.peek('chat:cats');
  flush();
  const release = refs.acquire('chat:cats');
  flush();
  assert.deepEqual(sets, [
    { topics: ['chat:cats'], peek: ['chat:cats'] },
    { topics: ['chat:cats'], peek: [] }
  ]);
  clock.advance(PEEK_TTL_MS * 3);
  flush();
  assert.equal(sets.length, 2, 'the expired peek timer did nothing');
  assert.ok(refs.holds('chat:cats'));
  release();
  flush();
  assert.deepEqual(sets.at(-1), { topics: [], peek: [] });
});

test('a press and a mount in one tick send the topic once, already taken over', () => {
  const { refs, sets, flush } = timed();
  refs.peek('chat:cats');
  refs.acquire('chat:cats');
  flush();
  assert.deepEqual(sets, [{ topics: ['chat:cats'], peek: [] }]);
});

test('a press on a topic already held changes nothing, and a press again restarts the ttl', () => {
  const { clock, refs, sets, flush } = timed();
  const release = refs.acquire('chat:dogs');
  refs.peek('chat:dogs');
  flush();
  assert.deepEqual(sets, [{ topics: ['chat:dogs'], peek: [] }]);
  release();
  refs.peek('chat:cats');
  flush();
  clock.advance(PEEK_TTL_MS - 100);
  refs.peek('chat:cats');
  clock.advance(PEEK_TTL_MS - 100);
  flush();
  assert.ok(refs.holds('chat:cats'), 'the second press pushed the end out');
  clock.advance(100);
  flush();
  assert.ok(!refs.holds('chat:cats'));
});

test('StrictMode after a press: mount, unmount, mount keeps the topic and drops the peek', () => {
  const { clock, refs, sets, flush } = timed();
  refs.peek('chat:cats');
  flush();
  const first = refs.acquire('chat:cats');
  first();
  refs.acquire('chat:cats');
  flush();
  clock.advance(PEEK_TTL_MS);
  flush();
  assert.deepEqual(sets.at(-1), { topics: ['chat:cats'], peek: [] });
  assert.equal(refs.count('chat:cats'), 1);
});

test('the page unmounting before its peek expires does not bring the peek back', () => {
  const { clock, refs, flush } = timed();
  refs.peek('chat:cats');
  const release = refs.acquire('chat:cats');
  release();
  flush();
  assert.ok(!refs.holds('chat:cats'), 'taken over then released: gone at once');
  clock.advance(PEEK_TTL_MS);
  flush();
  assert.deepEqual(refs.topics(), []);
});
