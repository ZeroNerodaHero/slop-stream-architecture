import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TopicRefs } from '../src/infra/rt/refs.ts';

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
