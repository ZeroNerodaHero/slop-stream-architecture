import assert from 'node:assert/strict';
import { test } from 'node:test';

import { audioOf, audioSrc, clockOf, micRefusal, pickRecorderType, RECORDER_TYPES } from '../src/infra/chat-audio.ts';
import { fromWire } from '../src/infra/chat-wire.ts';

const ID = '6b1e0c3a-7c2d-4e5f-9a10-11b12c13d14e';

test('audioOf reads a voice message', () => {
  assert.deepEqual(audioOf({ id: ID, duration_ms: 4250 }), { id: ID, duration_ms: 4250 });
});

test('audioOf is undefined for anything that is not one', () => {
  for (const raw of [undefined, null, '', 0, ID, [], {}, { id: '' }, { id: 7, duration_ms: 1 }, { duration_ms: 1000 }]) {
    assert.equal(audioOf(raw), undefined, JSON.stringify(raw));
  }
});

test('audioOf keeps the id when the length is missing or bad', () => {
  assert.deepEqual(audioOf({ id: ID }), { id: ID, duration_ms: 0 });
  assert.deepEqual(audioOf({ id: ID, duration_ms: 'long' }), { id: ID, duration_ms: 0 });
  assert.deepEqual(audioOf({ id: ID, duration_ms: -5 }), { id: ID, duration_ms: 0 });
  assert.deepEqual(audioOf({ id: ID, duration_ms: Number.NaN }), { id: ID, duration_ms: 0 });
  assert.deepEqual(audioOf({ id: ID, duration_ms: 1234.6 }), { id: ID, duration_ms: 1235 });
});

test('fromWire gives a line without a voice message no audio', () => {
  const line = fromWire({ id: '1-0', from: 'alice', text: 'hi', streamer: false, verified: true, at: 1 } as Parameters<typeof fromWire>[0]);
  assert.equal(line.audio, undefined);
  const bad = fromWire({ id: '1-0', from: 'alice', text: 'hi', streamer: false, verified: true, at: 1, audio: 'nope' } as Parameters<typeof fromWire>[0]);
  assert.equal(bad.audio, undefined);
  const broken = fromWire({ id: '1-0', from: 'alice', text: 'hi', streamer: false, verified: true, at: 1, audio: { duration_ms: 3 } } as Parameters<typeof fromWire>[0]);
  assert.equal(broken.audio, undefined);
});

test('fromWire keeps a voice-message-only line whole', () => {
  const line = fromWire({
    id: '1-0',
    from: 'alice',
    text: '',
    streamer: false,
    verified: true,
    at: 1,
    audio: { id: ID, duration_ms: 9000 },
    pinned_by: 'bob',
    pinned_at: 2
  } as Parameters<typeof fromWire>[0]);
  assert.deepEqual(line.audio, { id: ID, duration_ms: 9000 });
  assert.deepEqual(line.images, []);
  assert.deepEqual(line.groups, []);
  assert.equal(line.video, null);
});

test('the recorder asks for opus in webm first, then mp4 for safari, then the browser default', () => {
  assert.equal(RECORDER_TYPES[0], 'audio/webm;codecs=opus');
  assert.equal(pickRecorderType(() => true), 'audio/webm;codecs=opus');
  assert.equal(pickRecorderType((t) => t === 'audio/mp4'), 'audio/mp4');
  assert.equal(pickRecorderType((t) => t.startsWith('audio/ogg')), 'audio/ogg;codecs=opus');
  assert.equal(pickRecorderType(() => false), '');
  assert.equal(pickRecorderType(undefined), '');
  assert.equal(
    pickRecorderType((t) => {
      if (t.includes('webm')) throw new Error('no');
      return true;
    }),
    'audio/mp4'
  );
});

test('a clock reads m:ss', () => {
  assert.equal(clockOf(0), '0:00');
  assert.equal(clockOf(999), '0:00');
  assert.equal(clockOf(9_500), '0:09');
  assert.equal(clockOf(61_000), '1:01');
  assert.equal(clockOf(120_000), '2:00');
  assert.equal(clockOf(Number.NaN), '0:00');
  assert.equal(clockOf(-5), '0:00');
});

test('a refused microphone says why in a few words', () => {
  assert.equal(micRefusal({ name: 'NotAllowedError' }), 'microphone blocked. allow it to record');
  assert.equal(micRefusal({ name: 'NotFoundError' }), 'no microphone found');
  assert.equal(micRefusal({ name: 'NotReadableError' }), 'the microphone is busy');
  assert.equal(micRefusal(new Error('x')), 'could not open the microphone');
  assert.equal(micRefusal(null), 'could not open the microphone');
});

test('a voice message is played from the api by its id', () => {
  assert.equal(audioSrc(ID), `/api/chat-audio/${ID}`);
  assert.equal(audioSrc('a/b'), '/api/chat-audio/a%2Fb');
});
