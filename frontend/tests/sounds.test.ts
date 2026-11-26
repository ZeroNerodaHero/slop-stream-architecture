import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BELLS,
  DEFAULT_VOLUME,
  NO_ROSTER,
  bellUrl,
  choiceOf,
  customRefusal,
  stepRoster,
  throttle,
  volumeOf,
  type RosterState
} from '../src/infra/sound-logic.ts';

test('choiceOf keeps a known choice and falls back to the event default', () => {
  assert.equal(choiceOf('glass', 'notification'), 'glass');
  assert.equal(choiceOf('none', 'voiceJoin'), 'none');
  assert.equal(choiceOf('custom', 'voiceLeave'), 'custom');
  assert.equal(choiceOf('kazoo', 'notification'), 'soft-chime');
  assert.equal(choiceOf(undefined, 'voiceJoin'), 'rise');
  assert.equal(choiceOf(42, 'voiceLeave'), 'fall');
  assert.equal(choiceOf(null, 'voiceLeave'), 'fall');
});

test('volumeOf clamps, rounds and defaults', () => {
  assert.equal(volumeOf(50), 50);
  assert.equal(volumeOf(-5), 0);
  assert.equal(volumeOf(250), 100);
  assert.equal(volumeOf(33.6), 34);
  assert.equal(volumeOf('80'), DEFAULT_VOLUME);
  assert.equal(volumeOf(Number.NaN), DEFAULT_VOLUME);
  assert.equal(volumeOf(undefined), DEFAULT_VOLUME);
});

test('every bell has a file under /sounds', () => {
  assert.equal(BELLS.length, 9);
  for (const b of BELLS) assert.equal(bellUrl(b.id), `/sounds/${b.id}.mp3`);
});

test('customRefusal turns away big, long and undecodable files', () => {
  assert.equal(customRefusal(1000, 2), '');
  assert.match(customRefusal(2 * 1024 * 1024, 1), /^too big/);
  assert.match(customRefusal(1000, 6), /^too long/);
  assert.match(customRefusal(1000, null), /^not /);
});

const run = (steps: { key: string; settled?: boolean; users: string[] | null }[], me = 'me') => {
  let state: RosterState = NO_ROSTER;
  return steps.map((s) => {
    const step = stepRoster(state, s.key, s.settled ?? true, s.users, me);
    state = step.state;
    return { joined: step.joined, left: step.left };
  });
};

test('the first snapshot of a channel is the baseline, not a burst', () => {
  const [first, second] = run([
    { key: 'g/a', users: ['ann', 'bob'] },
    { key: 'g/a', users: ['ann', 'bob', 'cat'] }
  ]);
  assert.deepEqual(first, { joined: [], left: [] });
  assert.deepEqual(second, { joined: ['cat'], left: [] });
});

test('leaving shows as left', () => {
  const steps = run([
    { key: 'g/a', users: ['ann', 'bob'] },
    { key: 'g/a', users: ['ann'] }
  ]);
  assert.deepEqual(steps[1], { joined: [], left: ['bob'] });
});

test('my own seats never count', () => {
  const steps = run([
    { key: 'g/a', users: ['ann'] },
    { key: 'g/a', users: ['ann', 'me'] },
    { key: 'g/a', users: ['ann'] }
  ]);
  assert.deepEqual(steps[1], { joined: [], left: [] });
  assert.deepEqual(steps[2], { joined: [], left: [] });
});

test('a second seat of the same user does not fire twice', () => {
  const steps = run([
    { key: 'g/a', users: ['ann'] },
    { key: 'g/a', users: ['ann', 'bob', 'bob'] },
    { key: 'g/a', users: ['ann', 'bob'] },
    { key: 'g/a', users: ['ann'] }
  ]);
  assert.deepEqual(steps[1], { joined: ['bob'], left: [] });
  assert.deepEqual(steps[2], { joined: [], left: [] });
  assert.deepEqual(steps[3], { joined: [], left: ['bob'] });
});

test('switching channel or hanging up resets the baseline', () => {
  const steps = run([
    { key: 'g/a', users: ['ann'] },
    { key: 'g/b', users: null },
    { key: 'g/b', users: ['bob', 'cat'] },
    { key: 'g/b', users: ['bob'] },
    { key: '', users: [] },
    { key: 'g/b', users: ['dan'] }
  ]);
  assert.deepEqual(steps[2], { joined: [], left: [] });
  assert.deepEqual(steps[3], { joined: [], left: ['cat'] });
  assert.deepEqual(steps[4], { joined: [], left: [] });
  assert.deepEqual(steps[5], { joined: [], left: [] });
});

test('snapshots before the call settles only move the baseline', () => {
  const steps = run([
    { key: 'g/a', settled: false, users: [] },
    { key: 'g/a', settled: false, users: ['ann', 'bob'] },
    { key: 'g/a', users: ['ann', 'bob'] },
    { key: 'g/a', users: ['ann', 'bob', 'cat'] }
  ]);
  assert.deepEqual(steps[1], { joined: [], left: [] });
  assert.deepEqual(steps[2], { joined: [], left: [] });
  assert.deepEqual(steps[3], { joined: ['cat'], left: [] });
});

test('one change with several people plays each event once', () => {
  const steps = run([
    { key: 'g/a', users: ['ann', 'bob'] },
    { key: 'g/a', users: ['cat', 'dan'] }
  ]);
  assert.deepEqual(steps[1], { joined: ['cat', 'dan'], left: ['ann', 'bob'] });
});

test('throttle lets one through per gap', () => {
  const may = throttle(1500);
  assert.equal(may(0), true);
  assert.equal(may(100), false);
  assert.equal(may(1499), false);
  assert.equal(may(1500), true);
});
