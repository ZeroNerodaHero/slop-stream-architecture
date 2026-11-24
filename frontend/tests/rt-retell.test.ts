import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RETRY_FIRST_MS } from '../src/infra/rt/wire.ts';
import { rig } from './rt-harness.ts';

test('a tab that opens later knows who it is at once', () => {
  const { tab, up } = rig();
  tab();
  const s = up();
  s.hear({ type: 'me', name: 'ann', presence: 'online', status: 'online' });
  const late = tab();
  assert.deepEqual(late.frames('me'), [{ type: 'me', name: 'ann', presence: 'online', status: 'online' }]);
});

test('a second tab watching a name the browser already watches is told its word, which the server will not say again', () => {
  const { tab, up } = rig();
  const a = tab();
  const s = up();
  a.send({ kind: 'set', topics: ['presence:bob'] });
  s.hear({ type: 'presence', name: 'Bob', presence: 'busy' });
  const b = tab();
  const subs = s.subs().length;
  b.send({ kind: 'set', topics: ['presence:bob'] });
  assert.equal(s.subs().length, subs, 'the union did not change');
  assert.deepEqual(b.frames('presence'), [{ type: 'presence', name: 'Bob', presence: 'busy' }]);
  b.send({ kind: 'set', topics: ['presence:bob'] });
  assert.equal(b.frames('presence').length, 1, 'only on the set that adds it');
});

test('a second tab in a room another tab holds gets its count, and a wildcard gets every channel it covers', () => {
  const { tab, up } = rig();
  const a = tab();
  const s = up();
  a.send({ kind: 'set', topics: ['chat:cats', 'chat:g/*'] });
  s.hear({ type: 'count', topic: 'chat:cats', count: 4 });
  s.hear({ type: 'count', topic: 'chat:g/general', count: 2 });
  s.hear({ type: 'count', topic: 'chat:g/clips', count: 1 });
  const b = tab();
  b.send({ kind: 'set', topics: ['chat:cats'] });
  assert.deepEqual(
    b.frames('count').map((f) => [f.topic, f.count]),
    [['chat:cats', 4]]
  );
  b.send({ kind: 'set', topics: ['chat:cats', 'chat:g/*'] });
  assert.deepEqual(
    b
      .frames('count')
      .slice(1)
      .map((f) => [f.topic, f.count])
      .sort(),
    [
      ['chat:g/clips', 1],
      ['chat:g/general', 2]
    ]
  );
});

test('what the union lets go is forgotten, and a rename follows the name', () => {
  const { tab, up } = rig();
  const a = tab();
  const s = up();
  s.hear({ type: 'me', name: 'ann', presence: 'online', status: 'online' });
  a.send({ kind: 'set', topics: ['presence:bob', 'chat:cats'] });
  s.hear({ type: 'presence', name: 'bob', presence: 'online' });
  s.hear({ type: 'count', topic: 'chat:cats', count: 3 });
  a.send({ kind: 'set', topics: [] });
  const b = tab();
  b.send({ kind: 'set', topics: ['presence:bob', 'chat:cats'] });
  assert.equal(b.frames('presence').length, 0);
  assert.equal(b.frames('count').length, 0);
  s.hear({ type: 'renamed', name: 'ann', to: 'anna' });
  const c = tab();
  assert.equal(c.frames('me')[0]?.name, 'anna');
});

test('after a reconnect nothing stale is told: the new socket says it all again', () => {
  const { clock, tab, up } = rig();
  const a = tab();
  const first = up();
  a.send({ kind: 'set', topics: ['chat:cats'] });
  first.hear({ type: 'count', topic: 'chat:cats', count: 9 });
  first.serverClose(1006);
  clock.advance(RETRY_FIRST_MS);
  up();
  const b = tab();
  b.send({ kind: 'set', topics: ['chat:cats'] });
  assert.equal(b.frames('count').length, 0);
});
