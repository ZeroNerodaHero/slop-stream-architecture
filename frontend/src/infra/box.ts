export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
export type Fit = 'cover' | 'contain';

export const LAYER_MIN = 0.05;

export const thousandth = (v: number) => Math.round(v * 1000) / 1000;

export function clampBox(box: Box): Box {
  const w = thousandth(Math.min(1, Math.max(LAYER_MIN, box.w)));
  const h = thousandth(Math.min(1, Math.max(LAYER_MIN, box.h)));
  return { x: thousandth(Math.min(1 - w, Math.max(0, box.x))), y: thousandth(Math.min(1 - h, Math.max(0, box.y))), w, h };
}
