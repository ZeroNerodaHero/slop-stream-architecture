import assert from 'node:assert/strict';
import { test } from 'node:test';

import { makeEntry } from '../src/infra/frames.ts';
import { TAB_DEAD_MS, TAB_PING_MS } from '../src/infra/rt/wire.ts';
import { type FakePort, rig } from './rt-harness.ts';

function taps(port: FakePort) {
  return port.got.flatMap((m) => (m.kind === 'tap' ? [{ dir: m.dir, type: (m.frame as { type?: unknown }).type }] : []));
}

function busy(r: ReturnType<typeof rig>, a: FakePort) {
  const s = r.up();
  s.hear({ type: 'beat', at: 0 });
  a.send({ kind: 'set', topics: ['chat:cats'] });
  a.send({ kind: 'ask', rid: 'x1', ask: { type: 'say', topic: 'chat:cats', text: 'hi' } });
  const rid = s.sent.find((f) => f.type === 'say')?.rid;
  s.hear({ type: 'ack', rid });
  s.hear({ type: 'message', topic: 'chat:cats', id: '5-0', text: 'yo' });
  return s;
}

test('no tab has debug: nothing is tapped', async () => {
  const r = rig();
  const a = r.tab('cat');
  const b = r.tab();
  busy(r, a);
  a.send({ kind: 'identify', nick: 'cat' });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(taps(a), []);
  assert.deepEqual(taps(b), []);
});

test('one tab with debug gets every frame both ways, the other tab gets none', async () => {
  const r = rig();
  const a = r.tab('cat');
  const b = r.tab();
  a.send({ kind: 'debug', on: true });
  const s = busy(r, a);
  a.send({ kind: 'identify', nick: 'cat' });
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(s.sent.some((f) => f.type === 'auth'));
  const got = taps(a);
  for (const type of ['hello', 'sub', 'say', 'auth']) assert.ok(got.some((t) => t.dir === 'out' && t.type === type), `out ${type}`);
  for (const type of ['ready', 'beat', 'ack', 'message']) assert.ok(got.some((t) => t.dir === 'in' && t.type === type), `in ${type}`);
  assert.equal(got.filter((t) => t.dir === 'out').length, s.sent.length);
  assert.deepEqual(taps(b), []);
});

test('debug off stops the taps, and toggling does not pile up', () => {
  const r = rig();
  const a = r.tab();
  for (let i = 0; i < 5; i++) {
    a.send({ kind: 'debug', on: true });
    a.send({ kind: 'debug', on: false });
  }
  a.send({ kind: 'debug', on: true });
  const s = r.up();
  s.hear({ type: 'beat', at: 0 });
  assert.deepEqual(
    taps(a).map((t) => t.type),
    ['hello', 'ready', 'sub', 'beat']
  );
  a.send({ kind: 'debug', on: false });
  a.got = [];
  s.hear({ type: 'beat', at: 0 });
  a.send({ kind: 'focus' });
  assert.deepEqual(taps(a), []);
});

test('bye stops the taps for that tab', () => {
  const r = rig();
  const a = r.tab();
  const b = r.tab();
  a.send({ kind: 'debug', on: true });
  const s = r.up();
  a.send({ kind: 'bye' });
  a.got = [];
  s.hear({ type: 'beat', at: 0 });
  b.send({ kind: 'focus' });
  assert.deepEqual(taps(a), []);
  assert.deepEqual(taps(b), []);
});

test('a dead tab stops getting taps', () => {
  const r = rig();
  const alive = r.tab();
  const dead = r.tab();
  dead.send({ kind: 'debug', on: true });
  const s = r.up();
  for (let t = 0; t < TAB_DEAD_MS * 2; t += TAB_PING_MS) {
    r.clock.advance(TAB_PING_MS);
    alive.send({ kind: 'ping' });
  }
  assert.equal(dead.closed, true);
  dead.got = [];
  s.hear({ type: 'beat', at: 0 });
  alive.send({ kind: 'focus' });
  assert.deepEqual(taps(dead), []);
  assert.deepEqual(taps(alive), []);
});

test('a log entry hides ticket and token', () => {
  const auth = makeEntry('/rt', 'out', { type: 'auth', ticket: 'secret-ticket', nick: 'cat' });
  assert.equal(auth.type, 'auth');
  assert.ok(!auth.text.includes('secret-ticket'));
  assert.equal(JSON.parse(auth.text).ticket, '…');
  const tok = makeEntry('/rt', 'in', JSON.stringify({ type: 'x', token: 'secret-token' }));
  assert.ok(!tok.text.includes('secret-token'));
  assert.equal(JSON.parse(tok.text).token, '…');
});
