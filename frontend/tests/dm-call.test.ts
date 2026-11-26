import assert from 'node:assert/strict';
import { test } from 'node:test';

import { briefPhase, callClock, callMarkOf, callStatus, isDmRoom } from '../src/infra/dm-call.ts';

test('a call clock reads m:ss, and h:mm:ss past the hour', () => {
  assert.equal(callClock(0), '0:00');
  assert.equal(callClock(9), '0:09');
  assert.equal(callClock(83), '1:23');
  assert.equal(callClock(83.9), '1:23');
  assert.equal(callClock(3599), '59:59');
  assert.equal(callClock(3661), '1:01:01');
  assert.equal(callClock(-5), '0:00');
  assert.equal(callClock(Number.NaN), '0:00');
});

test('only a dm pair room is a dm room', () => {
  assert.ok(isDmRoom(`dm--${'0a'.repeat(14)}`));
  assert.ok(!isDmRoom('lounge'));
  assert.ok(!isDmRoom('dm--abc'));
  assert.ok(!isDmRoom(`dm--${'0a'.repeat(12)}-0042`));
  assert.ok(!isDmRoom(`dm--${'G'.repeat(28)}`));
});

test('what the call window says', () => {
  assert.equal(callStatus('calling', 'ann', null, 0), 'calling ann…');
  assert.equal(callStatus('declined', 'ann', null, 0), 'declined');
  assert.equal(callStatus('no answer', 'ann', 5, 9), 'no answer');
  assert.equal(callStatus('live', 'ann', null, 0), 'connecting…');
  assert.equal(callStatus('live', 'ann', 1000, 84_000), '1:23');
  assert.ok(briefPhase('declined') && briefPhase('no answer'));
  assert.ok(!briefPhase('calling') && !briefPhase('live'));
});

test('a dm line keeps its call mark only when it is one', () => {
  assert.deepEqual(callMarkOf({ outcome: 'ended', secs: 83 }), { outcome: 'ended', secs: 83 });
  assert.deepEqual(callMarkOf({ outcome: 'missed', secs: null }), { outcome: 'missed', secs: null });
  assert.deepEqual(callMarkOf({ outcome: 'declined' }), { outcome: 'declined', secs: null });
  assert.equal(callMarkOf({ outcome: 'odd' }), null);
  assert.equal(callMarkOf(null), null);
  assert.equal(callMarkOf('ended'), null);
});
