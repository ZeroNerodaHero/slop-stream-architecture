export type RunKind = 'chat' | 'say' | 'watch';
export type MetricGroup = 'chat' | 'watch';

export interface Metric {
  key: string;
  group: MetricGroup;
  label: string;
  kind: RunKind;
  phase: string;
}

export const METRICS: readonly Metric[] = [
  { key: 'chat-history', group: 'chat', label: 'first lines', kind: 'chat', phase: 'history' },
  { key: 'chat-subbed', group: 'chat', label: 'chat live', kind: 'chat', phase: 'subbed' },
  { key: 'chat-first-line', group: 'chat', label: 'first chat line', kind: 'chat', phase: 'first-line' },
  { key: 'say-ack', group: 'chat', label: 'say ack', kind: 'say', phase: 'ack' },
  { key: 'watch-ws-open', group: 'watch', label: 'ws open', kind: 'watch', phase: 'ws-open' },
  { key: 'watch-ice', group: 'watch', label: 'ice connected', kind: 'watch', phase: 'ice-connected' },
  { key: 'watch-first-frame', group: 'watch', label: 'first frame', kind: 'watch', phase: 'first-frame' },
  { key: 'watch-decoded', group: 'watch', label: 'first frame decoded', kind: 'watch', phase: 'first-frame-decoded' }
];

export const METRIC_GROUPS: readonly MetricGroup[] = ['chat', 'watch'];
export const METRIC_SIZE = 100;
export const QUALITY_SIZE = 600;
export const QUALITY_COLUMNS = ['t', 'session', 'width', 'height', 'fps', 'bitrate', 'lossPct', 'droppedPerSec', 'jitterMs', 'rttMs'] as const;

export type QualityColumn = (typeof QUALITY_COLUMNS)[number];
export type QualitySample = Record<QualityColumn, number>;
export type Path = 'direct' | 'relay' | null;

export class MetricRing {
  readonly buf: Float64Array;
  head = 0;
  count = 0;

  constructor(size = METRIC_SIZE) {
    this.buf = new Float64Array(size);
  }

  push(v: number): void {
    this.buf[this.head] = v;
    this.head = (this.head + 1) % this.buf.length;
    if (this.count < this.buf.length) this.count++;
  }

  values(): number[] {
    const size = this.buf.length;
    const out: number[] = [];
    for (let i = 0; i < this.count; i++) out.push(this.buf[(this.head - this.count + i + size) % size]!);
    return out;
  }

  clear(): void {
    this.buf.fill(0);
    this.head = 0;
    this.count = 0;
  }
}

export class Timings {
  readonly rings = new Map<string, MetricRing>();

  add(kind: RunKind, start: number, phases: readonly (readonly [string, number])[]): void {
    for (const m of METRICS) {
      if (m.kind !== kind) continue;
      const hit = phases.find(([name]) => name === m.phase);
      if (!hit) continue;
      let ring = this.rings.get(m.key);
      if (!ring) {
        ring = new MetricRing();
        this.rings.set(m.key, ring);
      }
      ring.push(Math.max(0, hit[1] - start));
    }
  }

  values(key: string): number[] {
    return this.rings.get(key)?.values() ?? [];
  }

  size(): number {
    let n = 0;
    for (const ring of this.rings.values()) n += ring.count;
    return n;
  }

  clear(): void {
    for (const ring of this.rings.values()) ring.clear();
    this.rings.clear();
  }
}

export class QualityRing {
  readonly cols: Record<QualityColumn, Float64Array>;
  head = 0;
  count = 0;
  path: Path = null;

  readonly size: number;

  constructor(size = QUALITY_SIZE) {
    this.size = size;
    const cols = {} as Record<QualityColumn, Float64Array>;
    for (const name of QUALITY_COLUMNS) cols[name] = new Float64Array(size);
    this.cols = cols;
  }

  push(sample: QualitySample, path: Path): void {
    for (const name of QUALITY_COLUMNS) this.cols[name][this.head] = sample[name];
    this.head = (this.head + 1) % this.size;
    if (this.count < this.size) this.count++;
    this.path = path;
  }

  at(col: QualityColumn, i: number): number {
    return this.cols[col][(this.head - this.count + i + this.size) % this.size]!;
  }

  series(col: QualityColumn): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.count; i++) out.push(this.at(col, i));
    return out;
  }

  clear(): void {
    for (const name of QUALITY_COLUMNS) this.cols[name].fill(0);
    this.head = 0;
    this.count = 0;
    this.path = null;
  }
}
