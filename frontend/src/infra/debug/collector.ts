import type { DebugSink } from '../debug-flag.ts';
import type { StreamStats } from '../stream-stats.ts';
import { QualityRing, Timings } from './rings.ts';
import { SessionLog } from './timeline.ts';

export interface CollectorDeps {
  slot: { sink: DebugSink | null };
  watch: (fn: (stats: StreamStats | null) => void) => () => void;
  name: () => string;
  now: () => number;
  schedule: (fn: () => void) => void;
}

const num = (v: number | null) => v ?? Number.NaN;

export class Collector {
  timings: Timings | null = null;
  quality: QualityRing | null = null;
  sessions: SessionLog | null = null;
  stats: StreamStats | null = null;
  version = 0;
  private readonly deps: CollectorDeps;
  private readonly listeners = new Set<() => void>();
  private off: (() => void) | null = null;
  private sink: DebugSink | null = null;
  private queued = false;

  constructor(deps: CollectorDeps) {
    this.deps = deps;
  }

  get running(): boolean {
    return this.off !== null;
  }

  start(): void {
    if (this.off) return;
    const timings = new Timings();
    this.timings = timings;
    this.quality = new QualityRing();
    this.sessions = new SessionLog();
    this.sink = (kind, _label, start, phases) => {
      timings.add(kind, start, phases);
      this.bump();
    };
    this.deps.slot.sink = this.sink;
    this.off = this.deps.watch((stats) => this.sample(stats));
  }

  stop(): void {
    const off = this.off;
    this.off = null;
    off?.();
    if (this.sink && this.deps.slot.sink === this.sink) this.deps.slot.sink = null;
    this.sink = null;
    this.timings?.clear();
    this.quality?.clear();
    this.sessions?.clear();
    this.timings = null;
    this.quality = null;
    this.sessions = null;
    this.stats = null;
    this.bump();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
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

  private bump(): void {
    this.version++;
    if (this.queued) return;
    this.queued = true;
    this.deps.schedule(() => {
      this.queued = false;
      for (const fn of this.listeners) fn();
    });
  }
}
