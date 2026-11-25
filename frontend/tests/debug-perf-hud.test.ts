import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEBUG_KEYS, migrateDebugSettings, PERF_KEY, PERF_MODES, perfModeOf } from '../src/infra/debug-flag.ts';
import {
  busyOf,
  fpsOf,
  kbpsOf,
  HISTORY,
  lagOf,
  type PerfDeps,
  PerfHistory,
  type PerfEntryLike,
  type PerfObserverCtor,
  type PerfSnapshot,
  PerfSampler,
  type PressureCtor,
  rangeOf,
  sparkLines
} from '../src/infra/debug/perf-hud.ts';

function rig(opts: { types?: string[]; memory?: number | null; pressure?: boolean; stats?: boolean } = {}) {
  let clock = 0;
  let nextId = 1;
  const rafs = new Map<number, () => void>();
  const intervals = new Map<number, () => void>();
  const observers = new Set<{ type: string; emit: (entries: PerfEntryLike[]) => void }>();
  const pressures = new Set<(records: { state: string }[]) => void>();
  const statsFns = new Set<(bitrate: number | null) => void>();

  class FakeObserver {
    static supportedEntryTypes = opts.types ?? ['longtask', 'resource'];
    private readonly cb: (list: { getEntries(): readonly PerfEntryLike[] }) => void;
    private handle: { type: string; emit: (entries: PerfEntryLike[]) => void } | null = null;
    constructor(cb: (list: { getEntries(): readonly PerfEntryLike[] }) => void) {
      this.cb = cb;
    }
    observe(o: { type: string }) {
      this.handle = { type: o.type, emit: (entries) => this.cb({ getEntries: () => entries }) };
      observers.add(this.handle);
    }
    disconnect() {
      if (this.handle) observers.delete(this.handle);
      this.handle = null;
    }
  }

  class FakePressure {
    private readonly cb: (records: { state: string }[]) => void;
    constructor(cb: (records: { state: string }[]) => void) {
      this.cb = cb;
    }
    observe() {
      pressures.add(this.cb);
      return Promise.resolve();
    }
    disconnect() {
      pressures.delete(this.cb);
    }
  }

  const deps: PerfDeps = {
    raf: (fn) => {
      const id = nextId++;
      rafs.set(id, fn);
      return id;
    },
    cancelRaf: (id) => {
      rafs.delete(id);
    },
    setInterval: (fn) => {
      const id = nextId++;
      intervals.set(id, fn);
      return id;
    },
    clearInterval: (id) => {
      intervals.delete(id as number);
    },
    now: () => clock,
    Observer: FakeObserver as unknown as PerfObserverCtor,
    memory: () => (opts.memory === undefined ? null : opts.memory),
    Pressure: opts.pressure ? (FakePressure as unknown as PressureCtor) : null,
    stats: opts.stats
      ? (fn) => {
          statsFns.add(fn);
          fn(null);
          return () => {
            statsFns.delete(fn);
          };
        }
      : null
  };

  const frames = (n: number) => {
    for (let i = 0; i < n; i++) {
      const pending = [...rafs.entries()];
      rafs.clear();
      for (const [, fn] of pending) fn();
    }
  };
  const tick = (ms = 1000) => {
    clock += ms;
    for (const fn of [...intervals.values()]) fn();
  };
  const emit = (type: string, entries: PerfEntryLike[]) => {
    for (const o of observers) if (o.type === type) o.emit(entries);
  };
  const active = () => rafs.size + intervals.size + observers.size + pressures.size + statsFns.size;
  const sampler = new PerfSampler(deps);
  const snaps: PerfSnapshot[] = [];
  return { sampler, snaps, frames, tick, emit, active, pressures, statsFns, start: () => sampler.start((s) => snaps.push(s)) };
}

test('pure helpers', () => {
  assert.equal(fpsOf(60, 1000), 60);
  assert.equal(fpsOf(30, 500), 60);
  assert.equal(fpsOf(10, 0), 0);
  assert.equal(busyOf(120), 0.12);
  assert.equal(busyOf(5000), 1);
  assert.equal(busyOf(-5), 0);
  assert.equal(lagOf(1004), 4);
  assert.equal(lagOf(990), 0);
  assert.equal(kbpsOf(2048, 1000), 2);
});

test('fps counts raf frames per second', () => {
  const r = rig();
  r.start();
  r.frames(58);
  r.tick();
  assert.equal(r.snaps.at(-1)?.fps, 58);
  r.frames(30);
  r.tick();
  assert.equal(r.snaps.at(-1)?.fps, 30);
  r.sampler.stop();
});

test('busy sums long tasks and caps at 100%', () => {
  const r = rig();
  r.start();
  r.emit('longtask', [{ duration: 80 }, { duration: 40 }]);
  r.tick();
  assert.equal(r.snaps.at(-1)?.busy, 0.12);
  r.emit('longtask', [{ duration: 900 }, { duration: 700 }]);
  r.tick();
  assert.equal(r.snaps.at(-1)?.busy, 1);
  r.tick();
  assert.equal(r.snaps.at(-1)?.busy, 0);
  r.sampler.stop();
});

test('busy is null without longtask support and lag comes from drift', () => {
  const r = rig({ types: ['resource'] });
  r.start();
  r.tick(1012);
  assert.equal(r.snaps.at(-1)?.busy, null);
  assert.equal(r.snaps.at(-1)?.lagMs, 12);
  r.sampler.stop();
});

test('network rate and session total from resource entries', () => {
  const r = rig();
  r.start();
  r.emit('resource', [{ duration: 1, transferSize: 1024 * 100 }, { duration: 1, transferSize: 0 }, { duration: 1 }]);
  r.tick();
  assert.equal(r.snaps.at(-1)?.downKBps, 100);
  r.emit('resource', [{ duration: 1, transferSize: 1024 * 1024 }]);
  r.tick();
  assert.equal(r.snaps.at(-1)?.downKBps, 1024);
  r.tick();
  assert.equal(r.snaps.at(-1)?.downKBps, 0);
  assert.equal(r.snaps.at(-1)?.totalMb, (1024 * 100 + 1024 * 1024) / (1024 * 1024));
  r.sampler.stop();
  r.start();
  r.tick();
  assert.equal(r.snaps.at(-1)?.totalMb, 0);
  r.sampler.stop();
});

test('memory is null when absent and MB when present', () => {
  const a = rig();
  a.start();
  a.tick();
  assert.equal(a.snaps.at(-1)?.memoryMb, null);
  a.sampler.stop();
  const b = rig({ memory: 50 * 1024 * 1024 });
  b.start();
  b.tick();
  assert.equal(b.snaps.at(-1)?.memoryMb, 50);
  b.sampler.stop();
});

test('pressure state passes through', () => {
  const r = rig({ pressure: true });
  r.start();
  r.tick();
  assert.equal(r.snaps.at(-1)?.pressure, null);
  for (const fn of r.pressures) fn([{ state: 'nominal' }, { state: 'fair' }]);
  r.tick();
  assert.equal(r.snaps.at(-1)?.pressure, 'fair');
  r.sampler.stop();
});

test('video kbps follows the stats source', () => {
  const r = rig({ stats: true });
  r.start();
  r.tick();
  assert.equal(r.snaps.at(-1)?.videoKbps, null);
  for (const fn of r.statsFns) fn(2_400_000);
  r.tick();
  assert.equal(r.snaps.at(-1)?.videoKbps, 2400);
  for (const fn of r.statsFns) fn(null);
  r.tick();
  assert.equal(r.snaps.at(-1)?.videoKbps, null);
  r.sampler.stop();
});

test('stop releases every raf, interval, observer and subscription', () => {
  const r = rig({ pressure: true, stats: true });
  r.start();
  r.frames(3);
  assert.equal(r.active(), 6);
  r.start();
  assert.equal(r.active(), 6);
  r.sampler.stop();
  assert.equal(r.active(), 0);
  assert.equal(r.sampler.active, false);
  r.sampler.stop();
  assert.equal(r.active(), 0);
  const before = r.snaps.length;
  r.tick();
  assert.equal(r.snaps.length, before);
});

test('20 start/stop cycles leave nothing running', () => {
  const r = rig({ pressure: true, stats: true });
  for (let i = 0; i < 20; i++) {
    r.start();
    r.frames(2);
    r.emit('longtask', [{ duration: 10 }]);
    r.tick();
    r.sampler.stop();
  }
  assert.equal(r.active(), 0);
  assert.equal(r.snaps.length, 20);
});

test('the old inspector migration leaves the perf switch alone', () => {
  const data = new Map<string, string>([['settings.inspector', 'true']]);
  const storage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k)
  };
  migrateDebugSettings(storage);
  assert.equal(Object.values(DEBUG_KEYS).includes('settings.debugPerf'), false);
  assert.equal(data.has('settings.debugPerf'), false);
});

test('the perf setting reads the old switch as a mode', () => {
  assert.equal(PERF_KEY, 'settings.debugPerf');
  assert.deepEqual(PERF_MODES, ['off', 'on', 'extended']);
  assert.equal(perfModeOf(true), 'on');
  assert.equal(perfModeOf(false), 'off');
  assert.equal(perfModeOf('on'), 'on');
  assert.equal(perfModeOf('extended'), 'extended');
  for (const raw of ['off', 'true', 'ON', 1, 0, null, undefined, {}, []]) assert.equal(perfModeOf(raw), 'off');
});

function snapOf(i: number, extra: Partial<PerfSnapshot> = {}): PerfSnapshot {
  return { fps: i, busy: i / 100, lagMs: 0, memoryMb: 10 + i, downKBps: i, totalMb: 0, videoKbps: null, pressure: null, ...extra };
}

test('the history keeps the last 60 samples oldest first', () => {
  const h = new PerfHistory();
  assert.equal(h.size, HISTORY);
  assert.deepEqual(h.values('fps'), []);
  for (let i = 0; i < 3; i++) h.push(snapOf(i));
  assert.deepEqual(h.values('fps'), [0, 1, 2]);
  for (let i = 3; i < 75; i++) h.push(snapOf(i));
  const fps = h.values('fps');
  assert.equal(h.length, 60);
  assert.equal(fps.length, 60);
  assert.equal(fps[0], 15);
  assert.equal(fps[59], 74);
  assert.ok(h.values('videoKbps').every((v) => Number.isNaN(v)));
});

test('graph ranges: fps 0 to max(60, peak), busy 0 to 1, the rest auto', () => {
  assert.deepEqual(rangeOf('fps', [30, 58]), [0, 60]);
  assert.deepEqual(rangeOf('fps', [30, 120]), [0, 120]);
  assert.deepEqual(rangeOf('busy', [0.2]), [0, 1]);
  const [lo, hi] = rangeOf('memoryMb', [100, 110]);
  assert.ok(lo < 100 && lo > 90 && hi > 110 && hi < 120);
  const [dlo, dhi] = rangeOf('downKBps', [0, 0, Number.NaN]);
  assert.equal(dlo, 0);
  assert.ok(dhi > 0);
});

test('a sparkline is right aligned and breaks on a missing sample', () => {
  const lines = sparkLines([0, 60, Number.NaN, 30, 30], [0, 60], 96, 18, 5, 0);
  assert.equal(lines.length, 2);
  assert.equal(lines[0], '0.0,18.0 24.0,0.0');
  assert.equal(lines[1], '72.0,9.0 96.0,9.0');
  const short = sparkLines([10, 20], [0, 20], 96, 18, 60, 0);
  assert.equal(short[0], `${(96 - 96 / 59).toFixed(1)},9.0 96.0,0.0`);
});
