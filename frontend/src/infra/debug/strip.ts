import type { MetricGroup } from './rings.ts';
import { summarize, type Summary } from './stats.ts';

export interface Pooled {
  n: number;
  median: number;
  p95: number;
  errors: number;
}

export interface Axis {
  lo: number;
  hi: number;
  ticks: number[];
}

export type SectionState = Record<MetricGroup, boolean>;

export const SECTIONS_KEY = 'settings.timingsSections';
export const DEFAULT_SECTIONS: SectionState = { chat: false, watch: false, api: true };
const GROUPS: readonly MetricGroup[] = ['chat', 'watch', 'api'];

export function pool(rows: readonly { recent: readonly number[]; errors?: number }[]): Pooled {
  const all: number[] = [];
  let errors = 0;
  for (const r of rows) {
    for (const v of r.recent) all.push(v);
    errors += r.errors ?? 0;
  }
  const s = summarize(all);
  return { n: s.n, median: s.median, p95: s.p95, errors };
}

function niceStep(raw: number): number {
  const mag = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw * (1 - 1e-9)) ?? raw;
}

const round = (v: number) => Math.round(v * 1e6) / 1e6;

export function axis(min: number, max: number, count = 4): Axis {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { lo: 0, hi: 1, ticks: [0, 1] };
  const span = max > min ? max - min : Math.max(1, Math.abs(max));
  const step = niceStep(span / count);
  const lo = round(Math.floor(min / step) * step);
  let hi = round(Math.ceil(max / step) * step);
  if (hi <= lo) hi = round(lo + step);
  const ticks: number[] = [];
  for (let i = 0; lo + i * step <= hi + step * 1e-9; i++) ticks.push(round(lo + i * step));
  return { lo, hi, ticks };
}

export function sectionAxis(summaries: readonly Summary[], count = 4): Axis {
  let min = Infinity;
  let max = -Infinity;
  for (const s of summaries) {
    if (!(s.n > 0)) continue;
    min = Math.min(min, s.min);
    max = Math.max(max, s.max);
  }
  return axis(min, max, count);
}

export function place(v: number, a: Axis): number {
  const at = (v - a.lo) / (a.hi - a.lo);
  return Math.min(100, Math.max(0, at * 100));
}

export function hotP95(s: Summary, ratio = 1.4): boolean {
  return s.n > 0 && s.p95 > s.median * ratio;
}

export function routeParts(key: string): { method: string; badge: string; path: string } {
  const space = key.indexOf(' ');
  const method = space < 0 ? '' : key.slice(0, space).toUpperCase();
  const route = space < 0 ? key : key.slice(space + 1);
  const path = route.startsWith('/api/') ? route.slice(4) : route;
  return { method, badge: method.slice(0, 1), path };
}

export function parseSections(raw: string | null): SectionState {
  let found: unknown = null;
  try {
    found = raw === null ? null : JSON.parse(raw);
  } catch {
    found = null;
  }
  const out = { ...DEFAULT_SECTIONS };
  if (!found || typeof found !== 'object' || Array.isArray(found)) return out;
  for (const g of GROUPS) {
    const v = (found as Record<string, unknown>)[g];
    if (typeof v === 'boolean') out[g] = v;
  }
  return out;
}

export function serializeSections(s: SectionState): string {
  return JSON.stringify({ chat: s.chat, watch: s.watch, api: s.api });
}

export function loadSections(storage: Pick<Storage, 'getItem'> | null): SectionState {
  try {
    return parseSections(storage?.getItem(SECTIONS_KEY) ?? null);
  } catch {
    return { ...DEFAULT_SECTIONS };
  }
}

export function saveSections(storage: Pick<Storage, 'setItem'> | null, s: SectionState): void {
  try {
    storage?.setItem(SECTIONS_KEY, serializeSections(s));
  } catch {
    return;
  }
}
