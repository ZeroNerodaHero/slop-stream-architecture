export interface PipCandidate {
  key: string;
  speaking: boolean;
  video: boolean;
  activeAt: number;
  self: boolean;
}

export const PIP_BIG = 2;
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
