import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { age, reconnects, socketDetails, socketLine, SQUARE } from '../src/infra/debug/socket-words.ts';
import { resetSockets, SOCKET_NAMES, socketLink, socketList, socketTick, trackSocket } from '../src/infra/debug/sockets.ts';

class FakeSocket {
  readyState = 0;
  private readonly on = new Map<string, (() => void)[]>();
  addEventListener(type: string, fn: () => void) {
    this.on.set(type, [...(this.on.get(type) ?? []), fn]);
  }
  fire(type: 'open' | 'message' | 'error' | 'close') {
    if (type === 'open') this.readyState = 1;
    if (type === 'close') this.readyState = 3;
    for (const fn of this.on.get(type) ?? []) fn();
  }
}

const get = (name: string) => socketList().find((s) => s.name === name)!;

beforeEach(() => resetSockets());

test('every socket is listed and idle until it is used', () => {
  assert.deepEqual(
    socketList().map((s) => [s.name, s.state]),
    SOCKET_NAMES.map((n) => [n, 'idle'])
  );
  assert.deepEqual(socketDetails(get('voice'), 0), ['not in use']);
  assert.equal(SQUARE.idle, 'border border-textTertiary');
});

test('a tracked socket goes connecting, open and closed and counts the reconnects', () => {
  const a = trackSocket('video', new FakeSocket(), '/ws');
  assert.equal(get('video').state, 'connecting');
  a.fire('open');
  assert.equal(get('video').state, 'open');
  a.fire('message');
  assert.ok(get('video').last !== null);
  a.fire('close');
  assert.equal(get('video').state, 'closed');
  const b = trackSocket('video', new FakeSocket(), '/ws');
  b.fire('open');
  assert.equal(reconnects(get('video')), 1);
  assert.equal(get('video').path, '/ws');
});

test('an error stays red through the close, and an old socket closing does not touch the new one', () => {
  const a = trackSocket('chat', new FakeSocket(), '/chat/a');
  a.fire('error');
  a.fire('close');
  assert.equal(get('chat').state, 'error');
  const b = trackSocket('chat', new FakeSocket(), '/chat/b');
  b.fire('open');
  a.fire('close');
  assert.equal(get('chat').state, 'open');
  assert.equal(get('chat').path, '/chat/b');
});

test('a link phase from a worker maps to connecting, open, reconnecting and closed', () => {
  socketLink('rt', 'connecting', '/rt', 1000);
  assert.equal(get('rt').state, 'connecting');
  socketLink('rt', 'open', '/rt', 2000);
  assert.equal(get('rt').openedAt, 2000);
  socketLink('rt', 'closed', '/rt', 3000);
  assert.equal(get('rt').state, 'reconnecting');
  socketLink('rt', 'open', '/rt', 4000);
  assert.equal(reconnects(get('rt')), 1);
  socketLink('rt', 'off', '/rt', 5000);
  assert.equal(get('rt').state, 'closed');
  socketLink('events', 'off', '/events');
  assert.equal(get('events').state, 'idle');
});

test('the line reads the state, the last message age when open, and the reconnects', () => {
  socketLink('rt', 'open', '/rt', 0);
  socketTick('rt', 1000);
  assert.equal(socketLine(get('rt'), 3400), 'open · 2s');
  socketLink('rt', 'closed', '/rt', 4000);
  socketLink('rt', 'open', '/rt', 5000);
  assert.equal(socketLine(get('rt'), 61_000), 'open · 1m · ↻1');
  assert.equal(age(7_200_000), '2h');
  const details = socketDetails(get('rt'), 61_000);
  assert.equal(details[0], '/rt');
  assert.equal(details[2], 'reconnects 1');
  assert.equal(details[3], 'last message 1m ago');
});
