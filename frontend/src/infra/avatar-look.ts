import type { Box } from './box.ts';
import { SHAPES, type Shape } from './shape.ts';

export type AvatarShape = 'default' | Shape;

export interface AvatarLook {
  shape: AvatarShape;
  border: boolean;
  color: string;
  bounce: boolean;
}

export const AVATAR_SHAPES: readonly AvatarShape[] = ['default', ...SHAPES];
export const AVATAR_LOOK: AvatarLook = { shape: 'default', border: true, color: '', bounce: true };
export const AVATAR_RADII: Record<Shape, string> = { block: '0px', soft: '6px', bubble: '50%' };
export const SQUARE = 9 / 16;
export const AVATAR_FILL = 0.84;
export const AVATAR_GROW = 0.1;
export const AVATAR_LIFT = 0.03;

const HEX = /^#[0-9a-f]{6}$/i;

export function readAvatarLook(raw: unknown): AvatarLook | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const l = raw as Record<string, unknown>;
  return {
    shape: AVATAR_SHAPES.includes(l.shape as AvatarShape) ? (l.shape as AvatarShape) : AVATAR_LOOK.shape,
    border: l.border !== false,
    color: typeof l.color === 'string' && HEX.test(l.color) ? l.color.toLowerCase() : '',
    bounce: l.bounce !== false
  };
}

export const sameLook = (a: AvatarLook, b: AvatarLook) => a.shape === b.shape && a.border === b.border && a.color === b.color && a.bounce === b.bounce;

export const lookOf = (look: AvatarLook | undefined): AvatarLook => look ?? AVATAR_LOOK;

export const radiusVar = (look: AvatarLook): string | undefined => (look.shape === 'default' ? undefined : AVATAR_RADII[look.shape]);

export function squareIn(box: Box): Box {
  const side = Math.min(box.w, box.h * SQUARE);
  const w = side;
  const h = side / SQUARE;
  const x = box.x + box.w / 2 > 0.5 ? box.x + box.w - w : box.x;
  const y = box.y + box.h / 2 > 0.5 ? box.y + box.h - h : box.y;
  return { x, y, w, h };
}

export function centeredSquare(box: Box): Box {
  const w = Math.min(box.w, box.h * SQUARE);
  const h = w / SQUARE;
  return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
}

export function avatarRadius(shape: AvatarShape, side: number, rootRadius: string, rootFont: number): number {
  const raw = shape === 'default' ? rootRadius.trim() : AVATAR_RADII[shape];
  const n = parseFloat(raw);
  if (!Number.isFinite(n)) return side / 2;
  if (raw.endsWith('%')) return Math.min(side / 2, (n / 100) * side);
  const px = raw.endsWith('rem') ? n * rootFont : n;
  return Math.min(side / 2, px * (side / 48));
}

export interface AvatarFrame {
  x: number;
  y: number;
  side: number;
  talking: boolean;
}

export function avatarFrame(box: Box, look: AvatarLook, voice: number, talking: boolean): AvatarFrame {
  const base = Math.min(box.w, box.h) * AVATAR_FILL;
  const v = look.bounce ? voice : 0;
  const side = base * (1 + AVATAR_GROW * v);
  return { x: box.x + (box.w - side) / 2, y: box.y + (box.h - side) / 2 - AVATAR_LIFT * v * base, side, talking: look.border && talking };
}
