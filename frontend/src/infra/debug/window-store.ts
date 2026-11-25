import { type WindowId, WINDOW_IDS } from './window-open.ts';

export { parseWindows, pick, restoreOpen, serialize, type WindowId, WINDOW_IDS, WINDOWS_KEY, type WindowsOpen } from './window-open.ts';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Boxes = Partial<Record<WindowId, Box>>;

export interface KeyStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const BOXES_KEY = 'settings.debugBoxes';

function parse(raw: string | null): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(raw ?? '');
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function asBox(v: unknown): Box | null {
  if (!v || typeof v !== 'object') return null;
  const { x, y, w, h } = v as Record<string, unknown>;
  return [x, y, w, h].every((n) => typeof n === 'number' && Number.isFinite(n)) ? { x, y, w, h } as Box : null;
}

export function parseBoxes(raw: string | null): Boxes {
  const v = parse(raw);
  const out: Boxes = {};
  for (const id of WINDOW_IDS) {
    const box = asBox(v[id]);
    if (box) out[id] = box;
  }
  return out;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function clampBox(box: Box, viewport: { w: number; h: number }, min: { w: number; h: number }): Box {
  const w = clamp(box.w, min.w, viewport.w);
  const h = clamp(box.h, min.h, viewport.h);
  return { x: clamp(box.x, 0, viewport.w - w), y: clamp(box.y, 0, viewport.h - h), w, h };
}

export function saveBox(storage: KeyStore, id: WindowId, box: Box): void {
  storage.setItem(BOXES_KEY, JSON.stringify({ ...parseBoxes(storage.getItem(BOXES_KEY)), [id]: box }));
}
