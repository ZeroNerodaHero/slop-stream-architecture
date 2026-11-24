import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RETRY_FIRST_MS } from '../src/infra/rt/wire.ts';
import { rig } from './rt-harness.ts';

test('a topic only peeked by every tab that holds it goes out as a peek', () => {
  const { tab, up } = rig();
  const a = tab();
  const b = tab();
  const s = up();
  a.send({ kind: 'set', topics: ['chat:cats', 'chat:dogs'], peek: ['chat:cats'] });
  assert.deepEqual(s.lastSub()?.topics, ['chat:cats', 'chat:dogs']);
  assert.deepEqual(s.lastSub()?.peek, ['chat:cats']);
  b.send({ kind: 'set', topics: ['chat:cats'] });
  assert.deepEqual(s.lastSub()?.topics, ['chat:cats', 'chat:dogs']);
  assert.equal(s.lastSub()?.peek, undefined, 'b really holds it, so the browser counts');
  b.send({ kind: 'set', topics: [] });
  assert.deepEqual(s.lastSub()?.peek, ['chat:cats'], 'b left, only a peek is left');
});

test('a takeover with the same topics still sends a set, now without the peek', () => {
  const { tab, up } = rig();
  const a = tab();
  const s = up();
  a.send({ kind: 'set', topics: ['chat:cats'], peek: ['chat:cats'] });
  const before = s.subs().length;
  a.send({ kind: 'set', topics: ['chat:cats'], peek: [] });
  assert.equal(s.subs().length, before + 1);
  assert.deepEqual(s.lastSub()?.topics, ['chat:cats']);
  assert.equal(s.lastSub()?.peek, undefined);
  a.send({ kind: 'set', topics: ['chat:cats'] });
  assert.equal(s.subs().length, before + 1, 'nothing changed, nothing sent');
});

test('a peek the tab does not hold is ignored, and a peek that expires leaves the set', () => {
  const { tab, up } = rig();
  const a = tab();
  const s = up();
  a.send({ kind: 'set', topics: ['chat:cats'], peek: ['chat:dogs'] });
  assert.deepEqual(s.lastSub()?.topics, ['chat:cats']);
  assert.equal(s.lastSub()?.peek, undefined);
  a.send({ kind: 'set', topics: ['chat:cats', 'chat:dogs'], peek: ['chat:dogs'] });
  assert.deepEqual(s.lastSub()?.peek, ['chat:dogs']);
  a.send({ kind: 'set', topics: ['chat:cats'], peek: [] });
  assert.deepEqual(s.lastSub()?.topics, ['chat:cats']);
  assert.equal(s.lastSub()?.peek, undefined);
});

test('the peek survives a reconnect: the first set on the new socket still names it', () => {
  const { clock, tab, up, sockets } = rig();
  const a = tab();
  const first = up();
  a.send({ kind: 'set', topics: ['chat:cats'], peek: ['chat:cats'] });
  first.serverClose(1006);
  clock.advance(RETRY_FIRST_MS);
  assert.equal(sockets.length, 2);
  const s = up();
  assert.deepEqual(s.lastSub()?.topics, ['chat:cats']);
  assert.deepEqual(s.lastSub()?.peek, ['chat:cats']);
});
