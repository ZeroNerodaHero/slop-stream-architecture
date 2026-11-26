export interface PipCandidate {
  key: string;
  speaking: boolean;
  video: boolean;
  activeAt: number;
  self: boolean;
  screen?: boolean;
}

export const PIP_BIG = 2;
export const PIP_BIG_PEOPLE = 4;
export const PIP_BIG_SCREENS = 2;
export const PIP_COLUMNS = 4;
export const PIP_ROWS = 2;

function better(a: PipCandidate, b: PipCandidate): number {
  if (a.speaking !== b.speaking) return a.speaking ? 1 : -1;
  if (a.activeAt !== b.activeAt) return a.activeAt > b.activeAt ? 1 : -1;
  if (a.video !== b.video) return a.video ? 1 : -1;
  if (a.self !== b.self) return a.self ? -1 : 1;
  return 0;
}

export function nextBig(prev: readonly string[], all: readonly PipCandidate[], max = PIP_BIG): string[] {
  if (max <= 0) return [];
  const held: PipCandidate[] = [];
  for (const key of prev) {
    const c = all.find((x) => x.key === key);
    if (c && !held.includes(c) && held.length < max) held.push(c);
  }
  const ranked = all
    .filter((c) => !held.includes(c))
    .map((c, i) => ({ c, i }))
    .toSorted((x, y) => better(y.c, x.c) || x.i - y.i);
  for (const { c } of ranked) {
    if (held.length < max) {
      held.push(c);
      continue;
    }
    let worst = 0;
    for (let j = 1; j < held.length; j++) if (better(held[j] as PipCandidate, held[worst] as PipCandidate) < 0) worst = j;
    if (better(c, held[worst] as PipCandidate) <= 0) break;
    held[worst] = c;
  }
  return held.map((c) => c.key);
}

export function nextStage(prev: readonly string[], all: readonly PipCandidate[]): string[] {
  const screens = all.filter((c) => c.screen);
  return screens.length > 0 ? nextBig(prev, screens, PIP_BIG_SCREENS) : nextBig(prev, all, PIP_BIG_PEOPLE);
}

export function smallRows<T>(rest: readonly T[], columns = PIP_COLUMNS, rows = PIP_ROWS): { shown: T[]; more: T[] } {
  const slots = Math.max(1, columns * rows);
  if (rest.length <= slots) return { shown: [...rest], more: [] };
  return { shown: rest.slice(0, slots - 1), more: rest.slice(slots - 1) };
}

export interface PipAt {
  right: number;
  bottom: number;
}

export function clampPip(at: PipAt, view: { w: number; h: number }, size: { w: number; h: number }): PipAt {
  const fit = (v: number, room: number) => Math.round(Math.max(0, Math.min(Math.max(0, room), v)));
  return { right: fit(at.right, view.w - size.w), bottom: fit(at.bottom, view.h - size.h) };
}

export function parsePipAt(v: unknown): PipAt | null {
  if (!v || typeof v !== 'object') return null;
  const { right, bottom } = v as Partial<PipAt>;
  if (typeof right !== 'number' || typeof bottom !== 'number' || !Number.isFinite(right) || !Number.isFinite(bottom)) return null;
  return { right, bottom };
}

export const PIP_ASPECT = 16 / 9;

export interface BigFit {
  cols: number;
  rows: number;
  tile: number;
}

export function bigFit(n: number, w: number, h: number, gap: number, aspect = PIP_ASPECT): BigFit {
  if (n <= 0 || w <= 0 || h <= 0) return { cols: Math.max(1, n), rows: 1, tile: 0 };
  let best: BigFit = { cols: n, rows: 1, tile: -1 };
  for (let cols = n; cols >= 1; cols--) {
    if (n % cols !== 0) continue;
    const rows = n / cols;
    const tile = Math.min((w - gap * (cols - 1)) / cols, ((h - gap * (rows - 1)) / rows) * aspect);
    if (tile > best.tile) best = { cols, rows, tile };
  }
  return { ...best, tile: Math.max(0, Math.floor(best.tile)) };
}

export const PIP_MINI_MIN = 72;

export function stripFit(w: number, gap: number, min = PIP_MINI_MIN): number {
  return Math.max(1, Math.floor((w + gap) / (min + gap)));
}

export interface PipSize {
  w: number;
  h: number;
}

export const PIP_SIZE: PipSize = { w: 400, h: 300 };
export const PIP_MIN: PipSize = { w: 280, h: 200 };
export const PIP_MAX: PipSize = { w: 1280, h: 960 };

export function clampPipSize(size: PipSize, view: { w: number; h: number }, at: PipAt = { right: 0, bottom: 0 }): PipSize {
  const fit = (v: number, lo: number, hi: number) => {
    const top = Math.max(0, hi);
    return Math.round(Math.min(top, Math.max(Math.min(lo, top), v)));
  };
  return {
    w: fit(size.w, PIP_MIN.w, Math.min(PIP_MAX.w, view.w - at.right)),
    h: fit(size.h, PIP_MIN.h, Math.min(PIP_MAX.h, view.h - at.bottom))
  };
}

export function parsePipSize(v: unknown): PipSize | null {
  if (!v || typeof v !== 'object') return null;
  const { w, h } = v as Partial<PipSize>;
  if (typeof w !== 'number' || typeof h !== 'number' || !Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  return { w, h };
}
