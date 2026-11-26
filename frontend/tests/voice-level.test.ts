import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isSpeaking, PULSE_GROW, pulseStep, pulseTarget, SPEAKING, voiceOf } from '../src/infra/voice-level.ts';

test('quiet is exactly one', () => {
  assert.equal(pulseTarget(0), 1);
  assert.equal(pulseTarget(SPEAKING), 1);
  assert.equal(isSpeaking(voiceOf(0)), false);
});

test('speaking grows with the level up to the cap', () => {
  assert.equal(pulseTarget(1), 1 + PULSE_GROW);
  assert.ok(pulseTarget(0.5) > 1 && pulseTarget(0.5) < 1 + PULSE_GROW);
  assert.equal(pulseTarget(voiceOf(5)), 1 + PULSE_GROW);
});

test('attack is faster than release', () => {
  const up = pulseStep(1, 1.25, 16) - 1;
  const down = 1.25 - pulseStep(1.25, 1, 16);
  assert.ok(up > down);
});

test('release settles on exactly one and never leaves the range', () => {
  let s = 1.25;
  for (let i = 0; i < 200; i++) s = pulseStep(s, 1, 16);
  assert.equal(s, 1);
  assert.equal(pulseStep(1, 2, 1000), 1 + PULSE_GROW);
  assert.equal(pulseStep(1, 0.5, 1000), 1);
});
