import { type Box, LAYER_MIN, thousandth } from './box.ts';

export interface ModelFrame {
  aspect: number;
  view: Box;
}

export interface FrameSize {
  width: number;
  height: number;
  fullWidth: number;
  fullHeight: number;
}

export const STAGE_ASPECT = 16 / 9;
export const FRAME_WIDTH = 1280;
export const FRAME_HEIGHT = 720;
export const WIDE_FRAME: ModelFrame = { aspect: STAGE_ASPECT, view: { x: 0, y: 0, w: 1, h: 1 } };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const tenThousandth = (v: number) => Math.round(v * 10000) / 10000;
const even = (v: number) => Math.max(16, 2 * Math.round(v / 2));

export function looseBox(box: Box): Box {
  const w = thousandth(clamp(box.w, LAYER_MIN, 1));
  const h = thousandth(clamp(box.h, LAYER_MIN, 1));
  return { x: thousandth(clamp(box.x, LAYER_MIN - w, 1 - LAYER_MIN)), y: thousandth(clamp(box.y, LAYER_MIN - h, 1 - LAYER_MIN)), w, h };
}

export function visibleBox(box: Box): Box {
  const x = clamp(box.x, 0, 1 - LAYER_MIN);
  const y = clamp(box.y, 0, 1 - LAYER_MIN);
  const w = clamp(Math.min(1, box.x + box.w) - x, LAYER_MIN, 1 - x);
  const h = clamp(Math.min(1, box.y + box.h) - y, LAYER_MIN, 1 - y);
  return { x: thousandth(x), y: thousandth(y), w: thousandth(w), h: thousandth(h) };
}

export const isOffStage = (box: Box) => box.x < 0 || box.y < 0 || box.x + box.w > 1.0005 || box.y + box.h > 1.0005;

export function movedLoose(box: Box, dx: number, dy: number): Box {
  return looseBox({ ...box, x: box.x + dx, y: box.y + dy });
}

export function resizedLoose(box: Box, sx: number, sy: number, dx: number, dy: number, ratio: number | null): Box {
  const fx = sx < 0 ? box.x + box.w : box.x;
  const fy = sy < 0 ? box.y + box.h : box.y;
  let w: number;
  let h: number;
  if (ratio) {
    const byX = sx * dx;
    const byY = sy * dy * ratio;
    const pull = Math.abs(byX) >= Math.abs(byY) ? byX : byY;
    w = clamp(box.w + pull, LAYER_MIN, Math.max(LAYER_MIN, Math.min(1, ratio)));
    h = w / ratio;
  } else {
    w = clamp(box.w + sx * dx, LAYER_MIN, 1);
    h = clamp(box.h + sy * dy, LAYER_MIN, 1);
  }
  return looseBox({ x: sx < 0 ? fx - w : fx, y: sy < 0 ? fy - h : fy, w, h });
}

export function modelFrameOf(box: Box): ModelFrame {
  const seen = visibleBox(box);
  return {
    aspect: tenThousandth((box.w / box.h) * STAGE_ASPECT),
    view: {
      x: tenThousandth((seen.x - box.x) / box.w),
      y: tenThousandth((seen.y - box.y) / box.h),
      w: tenThousandth(Math.min(1, seen.w / box.w)),
      h: tenThousandth(Math.min(1, seen.h / box.h))
    }
  };
}

export const sameFrame = (a: ModelFrame, b: ModelFrame) =>
  a.aspect === b.aspect && a.view.x === b.view.x && a.view.y === b.view.y && a.view.w === b.view.w && a.view.h === b.view.h;

export function frameSizeOf(frame: ModelFrame): FrameSize {
  const fullHeight = FRAME_HEIGHT;
  const fullWidth = FRAME_HEIGHT * frame.aspect;
  const scale = Math.min(1, FRAME_WIDTH / Math.max(1, fullWidth * frame.view.w));
  return {
    width: even(fullWidth * frame.view.w * scale),
    height: even(fullHeight * frame.view.h * scale),
    fullWidth: fullWidth * scale,
    fullHeight: fullHeight * scale
  };
}

export function fittedModelBox(box: Box, aspect: number): Box {
  const w = (box.h * clamp(aspect, 0.1, STAGE_ASPECT)) / STAGE_ASPECT;
  return looseBox({ x: box.x + box.w / 2 - w / 2, y: box.y, w, h: box.h });
}

export const wideModelBox = (box: Box) => fittedModelBox(box, STAGE_ASPECT);

export function modelWidthAspect(halfWidth: number, span: number): number {
  return tenThousandth(clamp((2 * halfWidth * 1.08) / Math.max(0.01, span), 0.3, STAGE_ASPECT));
}
