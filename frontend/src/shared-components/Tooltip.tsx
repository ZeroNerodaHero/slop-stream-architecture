import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { cn } from '@/utils/cn';

/** Which side of the children the tooltip goes on. */
export type TooltipAt = 'top' | 'bottom' | 'left' | 'right';

/** Between the tooltip and what it names. */
const GAP = 8;
/** The least it keeps from the edge of the window. */
const EDGE = 4;
/**
 * The box: the page's stroke on the secondary background and no shadow, like every floating box
 * over this page of boxes (PersonCard.tsx has the same). Over the open sidebar (z-40) and the
 * chat window (z-50). `left-0 top-0` until the layout effect puts it where it goes.
 */
const TIP =
  'pointer-events-none fixed left-0 top-0 z-[60] whitespace-nowrap border border-primaryStroke bg-backgroundSecondary px-2 py-1 text-xs font-semibold text-textPrimary';

interface TooltipProps {
  /** What shows while the pointer or the keyboard focus is on the children: a word, or any JSX. Nothing: no tooltip. */
  content: ReactNode;
  /** Which side of the children it goes on. Pushed back in when that side would put it off the window. */
  at?: TooltipAt;
  /** The id the tests key on, when one is needed. */
  id?: string;
  /** Classes for the tooltip box: a width, `whitespace-normal` for a line that may wrap. */
  className?: string;
  children: ReactNode;
}

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Where the children are on screen. The wrapper has no box of its own (`display: contents`), so this is the union of theirs. */
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

/** Where the box is drawn: the modal <dialog> the children are in, whose top layer nothing in the body reaches, else the body. */
function hostOf(wrapper: HTMLElement): HTMLElement {
  return wrapper.closest<HTMLElement>('dialog:modal') ?? document.body;
}

/**
 * A tooltip: `content` beside the children while the pointer rests on them or the keyboard
 * focus is in them (not the focus a click leaves behind), on the side `at` says, 8px off.
 * Escape hides it. The children are laid out as if it were not there. The box is drawn into
 * the body, `fixed`, so no scrolling list clips it and it sits over every panel, and it follows
 * the children through a scroll or a resize; inside a modal <dialog> it is drawn into the
 * dialog instead, since nothing in the body reaches the top layer. Where this is used the
 * native `title` goes: two tooltips for one button is one too many. For the name of an
 * icon-only button on the page (the sidebar's chat and ×); over a video, VideoControls'
 * ControlTip is the one that reads on the picture.
 */
export function Tooltip({ content, at = 'top', id, className, children }: TooltipProps) {
  const wrapper = useRef<HTMLSpanElement | null>(null);
  const tip = useRef<HTMLSpanElement | null>(null);
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  // known from the first arrival of the pointer or the focus; null until then
  const [host, setHost] = useState<HTMLElement | null>(null);
  const shown = (hover || focus) && !!content;

  // placed before it is painted: beside the children on the asked side, then kept in the
  // window. again on any scroll and on a resize while it shows, and when its content changes size
  useLayoutEffect(() => {
    const el = tip.current;
    if (!shown || !el) return;
    const place = () => {
      const box = wrapper.current && around(wrapper.current);
      if (!box) return;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const midX = (box.left + box.right - w) / 2;
      const midY = (box.top + box.bottom - h) / 2;
      const [x, y] =
        at === 'top' ? [midX, box.top - GAP - h] : at === 'bottom' ? [midX, box.bottom + GAP] : at === 'left' ? [box.left - GAP - w, midY] : [box.right + GAP, midY];
      // clientWidth, not innerWidth: the window's scrollbar is not room
      el.style.left = `${Math.max(EDGE, Math.min(x, document.documentElement.clientWidth - w - EDGE))}px`;
      el.style.top = `${Math.max(EDGE, Math.min(y, document.documentElement.clientHeight - h - EDGE))}px`;
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
        // a touch has no hover: a tap would flash the tooltip and take it away
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
