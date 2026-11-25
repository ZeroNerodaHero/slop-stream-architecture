export interface PerfEntryLike {
  duration: number;
  transferSize?: number;
}

export interface PerfObserverLike {
  observe(options: { type: string; buffered?: boolean }): void;
  disconnect(): void;
}

export interface PerfObserverCtor {
  new (callback: (list: { getEntries(): readonly PerfEntryLike[] }) => void): PerfObserverLike;
  readonly supportedEntryTypes?: readonly string[];
}

export interface PressureObserverLike {
  observe(source: 'cpu'): unknown;
  disconnect(): void;
}

export type PressureCtor = new (callback: (records: readonly { state: string }[]) => void) => PressureObserverLike;

export type Unsubscribe = () => void;

export interface PerfDeps {
  raf: (fn: () => void) => number;
  cancelRaf: (id: number) => void;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (id: unknown) => void;
  now: () => number;
  Observer: PerfObserverCtor | null;
  memory: () => number | null;
  Pressure: PressureCtor | null;
  stats: ((fn: (bitrate: number | null) => void) => Unsubscribe) | null;
}

export interface PerfSnapshot {
  fps: number;
  busy: number | null;
  lagMs: number;
  memoryMb: number | null;
  downKBps: number;
  totalMb: number;
  videoKbps: number | null;
  pressure: string | null;
}

export const TICK_MS = 1000;

export function fpsOf(frames: number, elapsedMs: number): number {
  return elapsedMs > 0 ? Math.round((frames * 1000) / elapsedMs) : 0;
}

export function busyOf(longTaskMs: number, windowMs = TICK_MS): number {
  return windowMs > 0 ? Math.min(Math.max(longTaskMs, 0), windowMs) / windowMs : 0;
}

export function lagOf(elapsedMs: number, expectedMs = TICK_MS): number {
  return Math.max(0, Math.round(elapsedMs - expectedMs));
}

export function kbpsOf(bytes: number, elapsedMs: number): number {
  return elapsedMs > 0 ? bytes / 1024 / (elapsedMs / 1000) : 0;
}

export function mbOf(bytes: number): number {
  return bytes / (1024 * 1024);
}

export class PerfSampler {
  private readonly deps: PerfDeps;
  private running = false;
  private rafId: number | null = null;
  private intervalId: unknown = null;
  private observers: PerfObserverLike[] = [];
  private pressureObserver: PressureObserverLike | null = null;
  private unsubscribe: Unsubscribe | null = null;
  private onTick: ((snapshot: PerfSnapshot) => void) | null = null;
  private frames = 0;
  private longTaskMs = 0;
  private bytes = 0;
  private totalBytes = 0;
  private lastTick = 0;
  private hasLongTask = false;
  private bitrate: number | null = null;
  private pressure: string | null = null;

  constructor(deps: PerfDeps) {
    this.deps = deps;
  }

  get active(): boolean {
    return this.running;
  }

  start(onTick: (snapshot: PerfSnapshot) => void): void {
    if (this.running) return;
    this.running = true;
    this.onTick = onTick;
    this.lastTick = this.deps.now();
    this.observe();
    this.watchPressure();
    if (this.deps.stats) this.unsubscribe = this.deps.stats((bitrate) => (this.bitrate = bitrate));
    const frame = () => {
      this.frames++;
      this.rafId = this.deps.raf(frame);
    };
    this.rafId = this.deps.raf(frame);
    this.intervalId = this.deps.setInterval(() => this.tick(), TICK_MS);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.rafId !== null) this.deps.cancelRaf(this.rafId);
    if (this.intervalId !== null) this.deps.clearInterval(this.intervalId);
    for (const o of this.observers) o.disconnect();
    this.pressureObserver?.disconnect();
    this.unsubscribe?.();
    this.rafId = null;
    this.intervalId = null;
    this.observers = [];
    this.pressureObserver = null;
    this.unsubscribe = null;
    this.onTick = null;
    this.frames = 0;
    this.longTaskMs = 0;
    this.bytes = 0;
    this.totalBytes = 0;
    this.lastTick = 0;
    this.hasLongTask = false;
    this.bitrate = null;
    this.pressure = null;
  }

  sample(): PerfSnapshot {
    const now = this.deps.now();
    const elapsed = now - this.lastTick;
    const memory = this.deps.memory();
    const snapshot: PerfSnapshot = {
      fps: fpsOf(this.frames, elapsed),
      busy: this.hasLongTask ? busyOf(this.longTaskMs) : null,
      lagMs: lagOf(elapsed),
      memoryMb: memory === null ? null : mbOf(memory),
      downKBps: kbpsOf(this.bytes, elapsed),
      totalMb: mbOf(this.totalBytes),
      videoKbps: this.bitrate === null ? null : Math.round(this.bitrate / 1000),
      pressure: this.pressure
    };
    this.lastTick = now;
    this.frames = 0;
    this.longTaskMs = 0;
    this.bytes = 0;
    return snapshot;
  }

  private tick(): void {
    if (!this.running) return;
    const snapshot = this.sample();
    this.onTick?.(snapshot);
  }

  private observe(): void {
    const Observer = this.deps.Observer;
    if (!Observer) return;
    const types = Observer.supportedEntryTypes ?? [];
    if (types.includes('longtask')) {
      const o = this.tryObserve(Observer, 'longtask', (entries) => {
        for (const e of entries) this.longTaskMs += e.duration;
      });
      this.hasLongTask = o;
    }
    if (types.includes('resource')) {
      this.tryObserve(Observer, 'resource', (entries) => {
        for (const e of entries) {
          const size = e.transferSize ?? 0;
          if (size > 0) {
            this.bytes += size;
            this.totalBytes += size;
          }
        }
      });
    }
  }

  private tryObserve(Observer: PerfObserverCtor, type: string, onEntries: (entries: readonly PerfEntryLike[]) => void): boolean {
    try {
      const o = new Observer((list) => {
        if (this.running) onEntries(list.getEntries());
      });
      this.observers.push(o);
      o.observe({ type, buffered: false });
      return true;
    } catch {
      return false;
    }
  }

  private watchPressure(): void {
    const Pressure = this.deps.Pressure;
    if (!Pressure) return;
    try {
      const o = new Pressure((records) => {
        const last = records[records.length - 1];
        if (this.running && last) this.pressure = last.state;
      });
      this.pressureObserver = o;
      const pending = o.observe('cpu');
      if (pending instanceof Promise) pending.catch(() => undefined);
    } catch {
      this.pressureObserver?.disconnect();
      this.pressureObserver = null;
    }
  }
}
