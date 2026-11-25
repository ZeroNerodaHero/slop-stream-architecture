export type Shape = 'block' | 'soft' | 'bubble';

export const SHAPES: readonly Shape[] = ['block', 'soft', 'bubble'];

export const DEFAULT_SHAPE: Shape = 'bubble';

export function shapeOf(raw: unknown): Shape {
  return (SHAPES as readonly unknown[]).includes(raw) ? (raw as Shape) : DEFAULT_SHAPE;
}

export function applyShapeTo(root: HTMLElement, shape: Shape) {
  if (shape === 'block') delete root.dataset.shape;
  else root.dataset.shape = shape;
}
