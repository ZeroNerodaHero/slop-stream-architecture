import { type PointerEvent as ReactPointerEvent, useLayoutEffect, useRef, useState } from 'react';

export const FRAME = 'border border-primaryStroke bg-backgroundSecondary';
export const GRIP = 'touch-none select-none [-webkit-touch-callout:none]';
const MIN_W = 320;
const MIN_H = 200;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const room = () => ({ w: document.documentElement.clientWidth, h: document.documentElement.clientHeight });

export function useDialogBox() {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const stop = useRef<(() => void) | null>(null);
  const [box, setBox] = useState<Box | null>(null);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.show();
    return () => {
      stop.current?.();
      if (dialog?.open) dialog.close();
    };
  }, []);

  const press = (e: ReactPointerEvent, kind: 'move' | 'resize') => {
    const el = dialogRef.current;
    if (e.button !== 0 || stop.current || !el) return;
    if ((e.target as Element).closest('button, input')) return;
    const rect = el.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const pointerId = e.pointerId;
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      const r = room();
      if (kind === 'move') {
        setBox({ x: clamp(rect.left + dx, 0, r.w - rect.width), y: clamp(rect.top + dy, 0, r.h - rect.height), w: rect.width, h: rect.height });
      } else {
        const w = clamp(rect.width + dx, MIN_W, r.w - rect.left);
        const h = clamp(rect.height + dy, MIN_H, r.h - rect.top);
        setBox({ x: rect.left, y: rect.top, w, h });
      }
    };
    const end = (ev: PointerEvent) => {
      if (ev.pointerId === pointerId) stop.current?.();
    };
    stop.current = () => {
      stop.current = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  };

  return { dialogRef, box, press };
}
