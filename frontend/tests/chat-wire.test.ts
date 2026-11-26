import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fromWire } from '../src/infra/chat-wire.ts';

test('fromWire gives text-only channel pins empty images and groups for ChatPanel', () => {
  const pin = fromWire({
    id: '1729000000000-0',
    from: 'alice',
    text: 'hello',
    streamer: false,
    verified: true,
    at: 1729000000000,
    pinned_by: 'bob',
    pinned_at: 1729000001000
  } as Parameters<typeof fromWire>[0]);
  assert.deepEqual(pin.images, []);
  assert.deepEqual(pin.groups, []);
  assert.equal(pin.image, null);
});

test('fromWire keeps a lone image field as images', () => {
  const pin = fromWire({
    id: '1-0',
    from: 'alice',
    text: '',
    streamer: false,
    verified: false,
    at: 1,
    image: '6b1e0c3a-7c2d-4e5f-9a10-11b12c13d14e'
  } as Parameters<typeof fromWire>[0]);
  assert.deepEqual(pin.images, ['6b1e0c3a-7c2d-4e5f-9a10-11b12c13d14e']);
});

test('fromWire drops a bad groups field to an empty array', () => {
  const pin = fromWire({
    id: '1-0',
    from: 'alice',
    text: 'x',
    streamer: false,
    verified: false,
    at: 1,
    groups: null
  } as Parameters<typeof fromWire>[0]);
  assert.deepEqual(pin.groups, []);
});