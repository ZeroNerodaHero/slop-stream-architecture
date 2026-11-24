import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LINGER_MS } from '../src/infra/rt/core.ts';
import { retryDelay, RETRY_MAX_MS, TAB_DEAD_MS, TAB_PING_MS, WATCHDOG_MS, wildcardOf, covers, rtWanted } from '../src/infra/rt/wire.ts';
import { rig } from './rt-harness.ts';

test('the first tab opens one socket and says hello with its nick', () => {
  const { sockets, tab, socket } = rig();
  tab('cat');
  tab('dog');
  assert.equal(sockets.length, 1);
  socket().opened();
  assert.deepEqual(socket().sent[0], { type: 'hello', v: 1, nick: 'dog' });
});

test('the worker asks for the union of every tab, and only when it changes', () => {
  const { tab, up } = rig();
  const a = tab();
  const b = tab();
  const s = up();
  a.send({ kind: 'set', topics: ['chat:cats', 'presence:x'] });
  b.send({ kind: 'set', topics: ['chat:cats', 'streams:*'] });
  assert.deepEqual(s.lastSub()?.topics, ['chat:cats', 'presence:x', 'streams:*']);
  const before = s.subs().length;
  b.send({ kind: 'set', topics: ['streams:*', 'chat:cats'] });
  assert.equal(s.subs().length, before, 'same union, no frame');
  a.send({ kind: 'set', topics: [] });
  assert.deepEqual(s.lastSub()?.topics, ['chat:cats', 'streams:*'], 'b still holds chat:cats');
  const revs = s.subs().map((f) => f.rev);
  assert.deepEqual(
    revs,
    revs.slice().sort((x, y) => x - y),
    'revs only rise'
  );
  assert.equal(new Set(revs).size, revs.length);
});

test('a frame goes only to the tabs that hold its topic, a wildcard covers its channels, events go to all', () => {
  const { tab, up } = rig();
  const a = tab();
  const b = tab();
  const s = up();
  a.send({ kind: 'set', topics: ['chat:cats'] });
  b.send({ kind: 'set', topics: ['chat:g/*'] });
  s.hear({ type: 'message', topic: 'chat:cats', id: '5-0', text: 'hi' });
  s.hear({ type: 'count', topic: 'chat:g/general', count: 3 });
  s.hear({ type: 'presence', name: 'x', presence: 'online' });
  assert.deepEqual(
    a.frames().map((f) => f.type),
    ['message', 'presence']
  );
  assert.deepEqual(
    b.frames().map((f) => f.type),
    ['count', 'presence']
  );
});

test('a tab that stops pinging is dropped after a minute and its topics leave the set', () => {
  const { clock, tab, up } = rig();
  const alive = tab();
  const dead = tab();
  const s = up();
  alive.send({ kind: 'set', topics: ['chat:a'] });
  dead.send({ kind: 'set', topics: ['chat:b'] });
  assert.deepEqual(s.lastSub()?.topics, ['chat:a', 'chat:b']);
  for (let t = 0; t < TAB_DEAD_MS * 2; t += TAB_PING_MS) {
    clock.advance(TAB_PING_MS);
    alive.send({ kind: 'ping' });
    s.hear({ type: 'beat', at: 0 });
  }
  assert.equal(dead.closed, true);
  assert.equal(alive.closed, false);
  assert.deepEqual(s.lastSub()?.topics, ['chat:a']);
});

test('bye on pagehide drops the tab at once; the socket lingers, then closes when no tab is left', () => {
  const { clock, core, tab, up } = rig();
  const a = tab();
  const s = up();
  a.send({ kind: 'set', topics: ['chat:a'] });
  a.send({ kind: 'bye' });
  assert.equal(core.tabCount(), 0);
  assert.deepEqual(s.lastSub()?.topics, []);
  clock.advance(LINGER_MS - 1);
  assert.equal(s.closedBy, null, 'a reload comes back within the linger');
  clock.advance(1);
  assert.notEqual(s.closedBy, null);
});

test('a tab from another build is told the worker is stale and is not attached', () => {
  const { core, tab } = rig();
  const old = tab(null, 'b0');
  assert.deepEqual(old.got, [{ kind: 'stale', build: 'b1' }]);
  assert.equal(core.tabCount(), 0);
});

test('a reply that does not match the set at that rev is resent; a stale reply is ignored', () => {
  const { clock, tab, up } = rig();
  const a = tab();
  const s = up();
  a.send({ kind: 'set', topics: ['chat:a', 'chat:b', 'chat:c'] });
  const rev = s.lastSub()!.rev;
  s.hear({ type: 'subbed', rev: rev - 1, topics: [], refused: [], evicted: [] });
  clock.advance(5000);
  assert.equal(s.lastSub()!.rev, rev, 'an old reply does not cause a resend');
  s.hear({ type: 'subbed', rev, topics: ['chat:a'], refused: [{ topic: 'chat:b', error: 'no such channel' }], evicted: [] });
  clock.advance(5000);
  assert.equal(s.lastSub()!.rev, rev + 1, 'chat:c went missing, so the set went again');
  s.hear({ type: 'subbed', rev: rev + 1, topics: ['chat:a', 'chat:c'], refused: [{ topic: 'chat:b', error: 'no such channel' }], evicted: [] });
  clock.advance(5000);
  assert.equal(s.lastSub()!.rev, rev + 1, 'refused topics are not a mismatch');
  s.hear({ type: 'subbed', rev: rev + 1, topics: ['chat:a'], refused: [{ topic: 'chat:b', error: 'no such channel' }], evicted: ['chat:c'] });
  clock.advance(5000);
  assert.equal(s.lastSub()!.rev, rev + 1, 'evicted topics are not a mismatch');
});

test('a duplicated or out of order subbed changes nothing', () => {
  const { clock, tab, up } = rig();
  const a = tab();
  const s = up();
  a.send({ kind: 'set', topics: ['chat:a'] });
  const rev = s.lastSub()!.rev;
  const ok = { type: 'subbed', rev, topics: ['chat:a'], refused: [], evicted: [] };
  s.hear(ok);
  s.hear(ok);
  s.hear({ type: 'subbed', rev: rev - 3, topics: ['chat:zzz'], refused: [], evicted: [] });
  clock.advance(5000);
  assert.equal(s.lastSub()!.rev, rev);
});

test('the full set goes again every minute and on focus', () => {
  const { clock, tab, up } = rig();
  const a = tab();
  const s = up();
  a.send({ kind: 'set', topics: ['chat:a'] });
  const n = s.subs().length;
  for (let i = 0; i < 3; i++) {
    clock.advance(20_000);
    s.hear({ type: 'beat', at: 0 });
    a.send({ kind: 'ping' });
  }
  assert.equal(s.subs().length, n + 1);
  a.send({ kind: 'focus' });
  assert.equal(s.subs().length, n + 2);
  assert.deepEqual(s.lastSub()!.topics, ['chat:a']);
});

test('reconnect: 250ms and up with jitter, doubling, capped at 30s; a ready resets it', () => {
  const { clock, sockets, tab, up } = rig();
  const a = tab();
  up();
  const waits: number[] = [];
  for (let i = 0; i < 12; i++) {
    const before = sockets.length;
    const s = sockets[sockets.length - 1]!;
    s.serverClose(1006);
    let waited = 0;
    while (sockets.length === before && waited <= RETRY_MAX_MS) {
      clock.advance(1);
      waited += 1;
      if (waited % 1000 === 0) a.send({ kind: 'ping' });
    }
    waits.push(waited);
  }
  assert.equal(waits[0], 250);
  assert.equal(waits[1], 500);
  assert.equal(waits[2], 1000);
  assert.ok(waits.every((w) => w <= RETRY_MAX_MS));
  assert.equal(waits[waits.length - 1], RETRY_MAX_MS);
  assert.equal(retryDelay(1, () => 1), 375, 'jitter adds up to half');
  up();
  sockets[sockets.length - 1]!.serverClose(1006);
  const before = sockets.length;
  clock.advance(250);
  assert.equal(sockets.length, before + 1, 'back to 250ms after a ready');
});

test('a 1001 restart comes back after a random 0-1.5s, not a backoff', () => {
  const { clock, sockets, tab, up } = rig();
  tab();
  const s = up();
  clock.rolls = [0.5];
  s.serverClose(1001);
  clock.advance(749);
  assert.equal(sockets.length, 1);
  clock.advance(1);
  assert.equal(sockets.length, 2);
});

test('a socket that hears nothing for 45s is cut by the watchdog and redialled', () => {
  const { clock, sockets, tab, up } = rig();
  const a = tab();
  const s = up();
  for (let i = 0; i < 5; i++) {
    clock.advance(20_000);
    s.hear({ type: 'beat', at: 0 });
    a.send({ kind: 'ping' });
  }
  assert.equal(sockets.length, 1, 'beats keep it');
  clock.advance(WATCHDOG_MS);
  assert.notEqual(s.closedBy, null);
  assert.deepEqual(a.phases().slice(-1), ['closed']);
  clock.advance(250);
  assert.equal(sockets.length, 2);
});

test('a fill after the history lands names only its topic, from the id the tab holds', () => {
  const { tab, up, clock } = rig();
  const a = tab();
  const s = up();
  a.send({ kind: 'set', topics: ['chat:a', 'chat:b'] });
  s.hear({ type: 'message', topic: 'chat:b', id: '30-0' });
  a.send({ kind: 'fill', since: { 'chat:a': '11-0' } });
  assert.deepEqual(s.lastSub()!.since, { 'chat:a': '11-0' });
  a.send({ kind: 'fill', since: { 'chat:a': '3-0' } });
  assert.deepEqual(s.lastSub()!.since, { 'chat:a': '3-0' }, 'a tab that is behind is filled from where it is');
  s.serverClose(1006);
  clock.advance(250);
  const again = up();
  assert.deepEqual(again.lastSub()!.since, { 'chat:a': '11-0', 'chat:b': '30-0' }, 'a reconnect asks from the newest id seen');
  const n = again.subs().length;
  a.send({ kind: 'fill', since: { 'chat:zzz': '1-0', 'chat:a': 'junk' } });
  assert.equal(again.subs().length, n, 'a topic not held or a bad id sends nothing');
  a.send({ kind: 'set', topics: ['chat:g/*'] });
  a.send({ kind: 'fill', since: { 'chat:g/one': '1-0', 'chat:g/two': '2-0' } });
  assert.deepEqual(again.lastSub()!.since, { 'chat:g/one': '1-0', 'chat:g/two': '2-0' }, 'every channel of a group in one set');
});

test('reconnect gap fill: the first set after ready carries since; behind sends it again', () => {
  const { clock, tab, up, sockets } = rig();
  const a = tab();
  const s = up();
  a.send({ kind: 'set', topics: ['chat:a', 'chat:g/*', 'presence:p'] });
  s.hear({ type: 'message', topic: 'chat:a', id: '10-0' });
  s.hear({ type: 'message', topic: 'chat:a', id: '9-0' });
  s.hear({ type: 'message', topic: 'chat:g/general', id: '20-1' });
  s.serverClose(1001);
  clock.advance(1500);
  assert.equal(sockets.length, 2);
  const again = up();
  assert.deepEqual(again.lastSub()!.topics, ['chat:a', 'chat:g/*', 'presence:p']);
  assert.deepEqual(again.lastSub()!.since, { 'chat:a': '10-0', 'chat:g/general': '20-1' });
  again.hear({ type: 'message', topic: 'chat:a', id: '12-0' });
  again.hear({ type: 'behind' });
  assert.deepEqual(again.lastSub()!.since, { 'chat:a': '12-0', 'chat:g/general': '20-1' });
  a.send({ kind: 'set', topics: ['presence:p'] });
  a.send({ kind: 'set', topics: ['chat:a', 'presence:p'] });
  assert.equal(again.lastSub()!.since, undefined, 'a topic that left forgets where it was');
});

test('say is answered on the tab that asked, under its own rid; a close nacks what is in flight', () => {
  const { tab, up, clock } = rig();
  const a = tab();
  const b = tab();
  const s = up();
  a.send({ kind: 'set', topics: ['chat:a'] });
  b.send({ kind: 'set', topics: ['chat:a'] });
  a.send({ kind: 'ask', rid: '1', ask: { type: 'say', topic: 'chat:a', text: 'hi' } });
  b.send({ kind: 'ask', rid: '1', ask: { type: 'say', topic: 'chat:a', text: 'yo' } });
  const [first, second] = s.sent.filter((f) => f.type === 'say');
  assert.notEqual(first!.rid, second!.rid, 'two tabs never share a wire rid');
  s.hear({ type: 'ack', rid: second!.rid, id: '7-0' });
  assert.deepEqual(b.answers(), [{ type: 'ack', rid: '1', id: '7-0' }]);
  assert.deepEqual(a.answers(), []);
  s.serverClose(1006);
  assert.deepEqual(a.answers(), [{ type: 'nack', rid: '1', error: 'chat is down' }]);
  clock.advance(250);
  a.send({ kind: 'ask', rid: '2', ask: { type: 'react', topic: 'chat:a', id: '7-0', emoji: 'x', on: true } });
  assert.deepEqual(a.answers()[1], { type: 'nack', rid: '2', error: 'chat is down' }, 'not ready yet');
});

test('an unanswered ask is nacked after 10s', () => {
  const { tab, up, clock } = rig();
  const a = tab();
  up();
  a.send({ kind: 'set', topics: ['chat:a'] });
  a.send({ kind: 'ask', rid: 'x', ask: { type: 'say', topic: 'chat:a', text: 'hi' } });
  clock.advance(10_000);
  assert.deepEqual(a.answers(), [{ type: 'nack', rid: 'x', error: 'no answer' }]);
});

test('identify sends auth with a fresh ticket and the nick; a failed ticket redials', async () => {
  let fail = false;
  const { tab, up, sockets, clock } = rig(() => (fail ? Promise.reject(new Error('no')) : Promise.resolve('a'.repeat(32))));
  const a = tab('cat');
  const s = up();
  a.send({ kind: 'identify', nick: 'dog' });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(
    s.sent.find((f) => f.type === 'auth'),
    { type: 'auth', ticket: 'a'.repeat(32), nick: 'dog' }
  );
  fail = true;
  a.send({ kind: 'identify', nick: null });
  await Promise.resolve();
  await Promise.resolve();
  clock.advance(1500);
  assert.equal(sockets.length, 2);
});

test('fresh asks the server to look a wildcard up again', () => {
  const { tab, up } = rig();
  const a = tab();
  const s = up();
  a.send({ kind: 'set', topics: ['chat:g/*'] });
  a.send({ kind: 'fresh', topic: 'chat:g/*' });
  assert.deepEqual(s.lastSub()!.fresh, ['chat:g/*']);
  a.send({ kind: 'focus' });
  assert.equal(s.lastSub()!.fresh, undefined);
});

test('flapping a tab 1000 times leaves nothing held', () => {
  const { core, tab, up } = rig();
  const keep = tab();
  const s = up();
  keep.send({ kind: 'set', topics: ['chat:keep'] });
  for (let i = 0; i < 1000; i++) {
    const t = tab();
    t.send({ kind: 'set', topics: [`chat:r${i % 7}`, 'chat:keep'] });
    if (i % 2) t.send({ kind: 'bye' });
    else t.send({ kind: 'set', topics: [] });
    if (!(i % 2)) t.send({ kind: 'bye' });
  }
  assert.equal(core.tabCount(), 1);
  assert.deepEqual(core.topics(), ['chat:keep']);
  assert.deepEqual(s.lastSub()!.topics, ['chat:keep']);
});

test('topic helpers', () => {
  assert.equal(wildcardOf('chat:g/general'), 'chat:g/*');
  assert.equal(wildcardOf('chat:g/*'), null);
  assert.equal(wildcardOf('chat:cats'), null);
  assert.ok(covers(new Set(['chat:g/*']), 'chat:g/x'));
  assert.ok(!covers(new Set(['chat:g/*']), 'chat:h/x'));
  const store = new Map<string, string>();
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k)
  };
  assert.equal(rtWanted('https://x/watch/a', storage), true, 'on by default');
  assert.equal(rtWanted('https://x/?rt=0', storage), false);
  assert.equal(rtWanted('https://x/', storage), false, 'the opt-out is remembered');
  assert.equal(rtWanted('https://x/watch/a?rt=1', storage), true);
  assert.equal(rtWanted('https://x/', storage), true, 'and ?rt=1 forgets it');
  storage.setItem('rt', '1');
  assert.equal(rtWanted('https://x/', storage), true, 'the old opt-in still reads as on');
  assert.equal(rtWanted('https://x/?rt=0', null), false);
  assert.equal(rtWanted('https://x/', null), true);
});

test('a tab that asks for a topic the worker already holds is told the current subbed at once', () => {
  const { tab, up } = rig();
  const a = tab();
  const s = up();
  a.send({ kind: 'set', topics: ['chat:a'] });
  const rev = s.lastSub()!.rev;
  s.hear({ type: 'subbed', rev, topics: ['chat:a'], refused: [], evicted: [] });
  const n = s.subs().length;
  const b = tab();
  assert.deepEqual(b.frames('subbed').length, 1, 'told on attach');
  b.send({ kind: 'set', topics: ['chat:a'] });
  assert.equal(s.subs().length, n, 'the union did not change, so nothing went to the server');
  assert.deepEqual(b.frames('subbed').length, 2);
  assert.deepEqual((b.frames('subbed')[1] as { topics: string[] }).topics, ['chat:a']);
});
