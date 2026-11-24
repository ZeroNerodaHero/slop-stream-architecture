import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { cn } from '@/utils/cn';

export type TooltipAt = 'top' | 'bottom' | 'left' | 'right';

const GAP = 8;
const EDGE = 4;
const OPPOSITE: Record<TooltipAt, TooltipAt> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };
const TIP =
  'pointer-events-none fixed left-0 top-0 z-[60] whitespace-nowrap border border-primaryStroke bg-backgroundSecondary px-2 py-1 text-xs font-semibold text-textPrimary';

interface TooltipProps {
  content: ReactNode;
  at?: TooltipAt;
  id?: string;
  className?: string;
  children: ReactNode;
}

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function around(wrapper: HTMLElement): Box | null {
  let box: Box | null = null;
  for (const el of wrapper.children) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    box = box
      ? { left: Math.min(box.left, r.left), top: Math.min(box.top, r.top), right: Math.max(box.right, r.right), bottom: Math.max(box.bottom, r.bottom) }
      : { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  }
  return box;
}

function hostOf(wrapper: HTMLElement): HTMLElement {
  return wrapper.closest<HTMLElement>('dialog:modal') ?? document.body;
}

export function Tooltip({ content, at = 'top', id, className, children }: TooltipProps) {
  const wrapper = useRef<HTMLSpanElement | null>(null);
  const tip = useRef<HTMLSpanElement | null>(null);
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const shown = (hover || focus) && !!content;

  useLayoutEffect(() => {
    const el = tip.current;
    if (!shown || !el) return;
    const place = () => {
      const box = wrapper.current && around(wrapper.current);
      if (!box) return;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const vw = document.documentElement.clientWidth;
      const vh = document.documentElement.clientHeight;
      const midX = (box.left + box.right - w) / 2;
      const midY = (box.top + box.bottom - h) / 2;
      const spot = (side: TooltipAt): [number, number] =>
        side === 'top'
          ? [midX, box.top - GAP - h]
          : side === 'bottom'
            ? [midX, box.bottom + GAP]
            : side === 'left'
              ? [box.left - GAP - w, midY]
              : [box.right + GAP, midY];
      const room = (side: TooltipAt) => {
        const [x, y] = spot(side);
        return side === 'top' || side === 'bottom' ? y >= EDGE && y + h <= vh - EDGE : x >= EDGE && x + w <= vw - EDGE;
      };
      const [x, y] = spot(room(at) || !room(OPPOSITE[at]) ? at : OPPOSITE[at]);
      el.style.left = `${Math.max(EDGE, Math.min(x, vw - w - EDGE))}px`;
      el.style.top = `${Math.max(EDGE, Math.min(y, vh - h - EDGE))}px`;
    };
    place();
    const grew = new ResizeObserver(place);
    grew.observe(el);
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      grew.disconnect();
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [shown, at]);

  return (
    <>
      <span
        ref={wrapper}
        className="contents"
        onPointerEnter={(e) => {
          if (e.pointerType === 'touch') return;
          setHost(hostOf(e.currentTarget));
          setHover(true);
        }}
        onPointerLeave={() => setHover(false)}
        onFocus={(e) => {
          setHost(hostOf(e.currentTarget));
          setFocus(e.target instanceof Element && e.target.matches(':focus-visible'));
        }}
        onBlur={() => setFocus(false)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setHover(false);
            setFocus(false);
          }
        }}
      >
        {children}
      </span>
      {shown &&
        host &&
        createPortal(
          <span ref={tip} id={id} role="tooltip" className={cn(TIP, className)}>
            {content}
          </span>,
          host
        )}
    </>
  );
}
