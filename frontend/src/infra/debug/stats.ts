export interface Summary {
  n: number;
  min: number;
  p5: number;
  p25: number;
  median: number;
  mean: number;
  p75: number;
  p95: number;
  max: number;
}

export function percentile(sorted: ArrayLike<number>, p: number): number {
  const n = sorted.length;
  if (n === 0) return Number.NaN;
  if (n === 1) return sorted[0]!;
  const at = Math.min(1, Math.max(0, p)) * (n - 1);
  const lo = Math.floor(at);
  const hi = Math.min(n - 1, lo + 1);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (at - lo);
}

export function mean(values: ArrayLike<number>): number {
  if (values.length === 0) return Number.NaN;
  let sum = 0;
  for (let i = 0; i < values.length; i++) sum += values[i]!;
  return sum / values.length;
}

export function summarize(values: ArrayLike<number>): Summary {
  const sorted = Float64Array.from(values).sort();
  return {
    n: sorted.length,
    min: percentile(sorted, 0),
    p5: percentile(sorted, 0.05),
    p25: percentile(sorted, 0.25),
    median: percentile(sorted, 0.5),
    mean: mean(sorted),
    p75: percentile(sorted, 0.75),
    p95: percentile(sorted, 0.95),
    max: percentile(sorted, 1)
  };
}

export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = 0; v <= max + step * 1e-9; v += step) out.push(Math.round(v * 1e6) / 1e6);
  if (out[out.length - 1]! < max) out.push(out[out.length - 1]! + step);
  return out;
}
