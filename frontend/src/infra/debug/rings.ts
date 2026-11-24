export type RunKind = 'chat' | 'say' | 'watch';

export interface TimedRun {
  label: string;
  at: number;
  phases: [string, number][];
}

export const RUN_KINDS: readonly RunKind[] = ['chat', 'say', 'watch'];
export const MAX_RUNS = 20;
export const QUALITY_SIZE = 300;
export const QUALITY_COLUMNS = ['t', 'width', 'height', 'fps', 'bitrate', 'lossPct', 'droppedPerSec', 'jitterMs', 'rttMs'] as const;

export type QualityColumn = (typeof QUALITY_COLUMNS)[number];
export type QualitySample = Record<QualityColumn, number>;
export type Path = 'direct' | 'relay' | null;

export class Timings {
  readonly runs: Record<RunKind, TimedRun[]> = { chat: [], say: [], watch: [] };

  add(kind: RunKind, run: TimedRun): void {
    const list = this.runs[kind];
    list.push(run);
    if (list.length > MAX_RUNS) list.splice(0, list.length - MAX_RUNS);
  }

  size(): number {
    return this.runs.chat.length + this.runs.say.length + this.runs.watch.length;
  }

  clear(): void {
    for (const kind of RUN_KINDS) this.runs[kind].length = 0;
  }
}

export function timedRun(label: string, start: number, phases: readonly (readonly [string, number])[], origin: number): TimedRun {
  return { label, at: origin + start, phases: phases.map(([name, t]) => [name, Math.round(t - start)]) };
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

const BARS = '▁▂▃▄▅▆▇█';

export function sparkline(values: readonly number[], width = 40): string {
  const tail = values.slice(-width).map((v) => (Number.isFinite(v) ? v : 0));
  if (tail.length === 0) return '';
  const lo = Math.min(...tail);
  const span = Math.max(...tail) - lo;
  return tail.map((v) => BARS[span > 0 ? Math.min(7, Math.floor(((v - lo) / span) * 8)) : 0]).join('');
}
