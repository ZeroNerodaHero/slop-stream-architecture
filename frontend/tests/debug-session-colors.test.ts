import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runAt, SESSION_COLORS, sessionColor } from '../src/infra/debug/session-colors.ts';
import { layout, SessionLog } from '../src/infra/debug/timeline.ts';

test('each watch session takes the next colour and the palette cycles', () => {
  const colors = SESSION_COLORS.map((_, i) => sessionColor(i));
  assert.equal(new Set(colors).size, SESSION_COLORS.length);
  assert.equal(sessionColor(SESSION_COLORS.length), sessionColor(0));
  assert.equal(sessionColor(SESSION_COLORS.length + 2), sessionColor(2));
});

test('going back to the same stream is a new session with a new colour and keeps its picture', () => {
  const log = new SessionLog();
  const a = log.begin('dummy-b', 0, 3);
  log.end(10);
  const b = log.begin('dummy-c', 20, null);
  log.end(30);
  const c = log.begin('dummy-b', 40, 3);
  const l = layout([0, 5, 20, 25, 40, 45], [a.id, a.id, b.id, b.id, c.id, c.id], log.list);
  assert.deepEqual(
    l.runs.map((r) => [r.name, r.avatar]),
    [
      ['dummy-b', 3],
      ['dummy-c', null],
      ['dummy-b', 3]
    ]
  );
  assert.notEqual(sessionColor(l.runs[0]!.session), sessionColor(l.runs[2]!.session));
});

test('a sample finds the run it belongs to', () => {
  const runs = [
    { from: 0, to: 3 },
    { from: 3, to: 6 }
  ];
  assert.equal(runAt(runs, 0), runs[0]);
  assert.equal(runAt(runs, 3), runs[1]);
  assert.equal(runAt(runs, 6), undefined);
});
