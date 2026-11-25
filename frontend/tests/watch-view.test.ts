import assert from 'node:assert/strict';
import { test } from 'node:test';

import { type View, viewFrame, viewOf, ViewSender } from '../src/infra/watch-view.ts';

test('the view is full if any full-size player is seen, small if only a corner is, hidden if none is', () => {
  assert.equal(viewOf(false, []), 'full');
  assert.equal(viewOf(true, []), 'hidden');
  assert.equal(viewOf(false, [{ small: false, seen: true }]), 'full');
  assert.equal(viewOf(false, [{ small: false, seen: false }]), 'hidden');
  assert.equal(viewOf(false, [{ small: true, seen: true }]), 'small');
  assert.equal(
    viewOf(false, [
      { small: true, seen: true },
      { small: false, seen: true }
    ]),
    'full'
  );
  assert.equal(
    viewOf(false, [
      { small: true, seen: false },
      { small: false, seen: false }
    ]),
    'hidden'
  );
  assert.equal(viewOf(true, [{ small: true, seen: true }]), 'small');
});

test('the frames are the exact ones the video server accepts', () => {
  assert.equal(viewFrame('full'), '{"view":"full"}');
  assert.equal(viewFrame('small'), '{"view":"small"}');
  assert.equal(viewFrame('hidden'), '{"view":"hidden"}');
});

function clock() {
  let now = 0;
  let next = 1;
  const due = new Map<number, { at: number; fn: () => void }>();
  return {
    timers: {
      set: (fn: () => void, ms: number) => {
        const id = next++;
        due.set(id, { at: now + ms, fn });
        return id;
      },
      clear: (id: unknown) => {
        due.delete(id as number);
      }
    },
    advance(ms: number) {
      now += ms;
      for (const [id, t] of [...due].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at > now) continue;
        due.delete(id);
        t.fn();
      }
    }
  };
}

test('hiding waits out the debounce, a quick look back cancels it, showing goes at once', () => {
  const c = clock();
  const sent: View[] = [];
  const s = new ViewSender((v) => sent.push(v), c.timers, 2000);
  s.update('full');
  assert.deepEqual(sent, []);
  s.update('hidden');
  c.advance(1500);
  s.update('full');
  c.advance(5000);
  assert.deepEqual(sent, []);
  s.update('hidden');
  c.advance(1000);
  s.update('hidden');
  c.advance(1000);
  assert.deepEqual(sent, ['hidden']);
  s.update('hidden');
  c.advance(5000);
  assert.deepEqual(sent, ['hidden']);
  s.update('full');
  assert.deepEqual(sent, ['hidden', 'full']);
  s.update('small');
  s.update('small');
  assert.deepEqual(sent, ['hidden', 'full', 'small']);
});

test('flapping visibility never sends more than one pause per debounce', () => {
  const c = clock();
  const sent: View[] = [];
  const s = new ViewSender((v) => sent.push(v), c.timers, 2000);
  for (let i = 0; i < 100; i++) {
    s.update(i % 2 === 0 ? 'hidden' : 'full');
    c.advance(300);
  }
  assert.deepEqual(sent, []);
});

test('a new socket starts from full and drops a pending pause', () => {
  const c = clock();
  const sent: View[] = [];
  const s = new ViewSender((v) => sent.push(v), c.timers, 2000);
  s.update('small');
  s.update('hidden');
  s.reset();
  c.advance(5000);
  assert.deepEqual(sent, ['small']);
  s.update('full');
  assert.deepEqual(sent, ['small']);
  s.update('small');
  assert.deepEqual(sent, ['small', 'small']);
});
