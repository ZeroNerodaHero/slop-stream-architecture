import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import { sceneSendScheduler } from '../src/infra/scene-send.ts';

const MS = 150;

function fireTimes(scheduleAt: number[], afterMs: number): number[] {
  const fires: number[] = [];
  const sched = sceneSendScheduler(MS, () => fires.push(Date.now()));
  const start = Date.now();
  const last = scheduleAt[scheduleAt.length - 1];
  let next = 0;
  for (let elapsed = 0; elapsed <= last + afterMs; elapsed++) {
    while (next < scheduleAt.length && scheduleAt[next] === elapsed) {
      sched.schedule();
      next++;
    }
    mock.timers.tick(1);
  }
  return fires.map((f) => f - start);
}

test('schedule coalesces bursts into one send per debounce window', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const scheduleAt: number[] = [];
  for (let t = 0; t <= 660; t += 12) scheduleAt.push(t);
  scheduleAt.push(664);
  const fires = fireTimes(scheduleAt, 400);
  mock.timers.reset();

  assert.deepEqual(fires, [150, 306, 462, 618, 774]);
  for (let i = 1; i < fires.length; i++) assert.ok(fires[i] - fires[i - 1] >= MS, 'fires respect the debounce window');
});

test('a lone schedule fires once after the window', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const fires = fireTimes([0], 400);
  mock.timers.reset();
  assert.deepEqual(fires, [150]);
});

test('cancel drops a pending send', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const fires: number[] = [];
  const sched = sceneSendScheduler(MS, () => fires.push(Date.now()));
  sched.schedule();
  assert.equal(sched.pending(), true);
  for (let k = 0; k < 5; k++) mock.timers.tick(10);
  sched.cancel();
  assert.equal(sched.pending(), false);
  for (let k = 0; k < 40; k++) mock.timers.tick(10);
  mock.timers.reset();
  assert.deepEqual(fires, []);
});
