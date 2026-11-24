import type { DebugSink } from '../debug-flag.ts';
import type { StreamStats } from '../stream-stats.ts';
import { QualityRing, RouteTimings, Timings } from './rings.ts';
import { apiKey } from './routes.ts';
import { SessionLog } from './timeline.ts';

export interface FeedDeps {
  schedule: (fn: () => void) => void;
}

export interface TimingsDeps extends FeedDeps {
  slot: { sink: DebugSink | null };
  host: { fetch: typeof fetch };
  origin: () => string;
  clock: () => number;
}

export interface QualityDeps extends FeedDeps {
  watch: (fn: (stats: StreamStats | null) => void) => () => void;
  name: () => string;
  now: () => number;
}

const num = (v: number | null) => v ?? Number.NaN;

class Feed {
  version = 0;
  private readonly listeners = new Set<() => void>();
  private readonly schedule: (fn: () => void) => void;
  private queued = false;

  constructor(schedule: (fn: () => void) => void) {
    this.schedule = schedule;
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  snapshot = (): number => this.version;

  protected bump(): void {
    this.version++;
    if (this.queued) return;
    this.queued = true;
    this.schedule(() => {
      this.queued = false;
      for (const fn of this.listeners) fn();
    });
  }
}

export class TimingsCollector extends Feed {
  timings: Timings | null = null;
  api: RouteTimings | null = null;
  private readonly deps: TimingsDeps;
  private sink: DebugSink | null = null;
  private wrapper: typeof fetch | null = null;
  private original: typeof fetch | null = null;

  constructor(deps: TimingsDeps) {
    super(deps.schedule);
    this.deps = deps;
  }

  get running(): boolean {
    return this.timings !== null;
  }

  get wrapped(): boolean {
    return this.wrapper !== null && this.deps.host.fetch === this.wrapper;
  }

  start(): void {
    if (this.timings) return;
    const timings = new Timings();
    const api = new RouteTimings();
    this.timings = timings;
    this.api = api;
    this.sink = (kind, _label, start, phases) => {
      timings.add(kind, start, phases);
      this.bump();
    };
    this.deps.slot.sink = this.sink;
    const { host, origin, clock } = this.deps;
    const original = host.fetch;
    const done = (key: string, status: number, at: number) => {
      if (this.api !== api) return;
      api.add(key, status, clock() - at);
      this.bump();
    };
    const wrapper = ((input: RequestInfo | URL, init?: RequestInit) => {
      const key = this.api === api ? apiKey(input, init, origin()) : null;
      if (key === null) return original.call(host, input, init);
      const at = clock();
      return original.call(host, input, init).then(
        (res) => {
          done(key, res.status, at);
          return res;
        },
        (err: unknown) => {
          done(key, 0, at);
          throw err;
        }
      );
    }) as typeof fetch;
    this.original = original;
    this.wrapper = wrapper;
    host.fetch = wrapper;
  }

  stop(): void {
    if (!this.timings) return;
    const host = this.deps.host;
    if (this.wrapper && this.original && host.fetch === this.wrapper) host.fetch = this.original;
    this.wrapper = null;
    this.original = null;
    if (this.sink && this.deps.slot.sink === this.sink) this.deps.slot.sink = null;
    this.sink = null;
    this.timings?.clear();
    this.api?.clear();
    this.timings = null;
    this.api = null;
    this.bump();
  }
}

export class QualityCollector extends Feed {
  quality: QualityRing | null = null;
  sessions: SessionLog | null = null;
  stats: StreamStats | null = null;
  private readonly deps: QualityDeps;
  private off: (() => void) | null = null;

  constructor(deps: QualityDeps) {
    super(deps.schedule);
    this.deps = deps;
  }

  get running(): boolean {
    return this.off !== null;
  }

  start(): void {
    if (this.off) return;
    this.quality = new QualityRing();
    this.sessions = new SessionLog();
    this.off = this.deps.watch((stats) => this.sample(stats));
  }

  stop(): void {
    const off = this.off;
    if (!off) return;
    this.off = null;
    off();
    this.quality?.clear();
    this.sessions?.clear();
    this.quality = null;
    this.sessions = null;
    this.stats = null;
    this.bump();
  }

  private sample(stats: StreamStats | null): void {
    this.stats = stats;
    const sessions = this.sessions;
    const now = this.deps.now();
    if (!stats) {
      sessions?.end(now);
    } else if (sessions && this.quality) {
      const name = this.deps.name();
      const current = sessions.current;
      const session = current && current.name === name ? current : sessions.begin(name, now);
      const v = stats.video;
      this.quality.push(
        {
          t: now,
          session: session.id,
          width: v.width,
          height: v.height,
          fps: v.fps,
          bitrate: v.bitrate,
          lossPct: num(v.lossPct),
          droppedPerSec: num(v.droppedPerSec),
          jitterMs: num(v.jitterMs),
          rttMs: num(stats.rttMs)
        },
        stats.path
      );
    }
    this.bump();
  }
}
