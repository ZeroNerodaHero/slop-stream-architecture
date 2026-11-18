import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { cn } from '@/utils/cn';

export type DrawerSide = 'left' | 'right';

/** The strip at the screen's very edge an opening swipe may not start in: the browser's own back (and forward) swipe is there. */
const EDGE_INSET = 16;
/** How wide the band past it is where an opening swipe may start. */
const EDGE_BAND = 40;
/** How far a finger moves before the drawer decides it is a swipe across and not a scroll down. */
const LOCK_PX = 10;
/** Past this share of its width, from where it started, the drawer goes the rest of the way when let go. */
const SNAP = 0.4;
/** A flick this fast (px per ms) goes the way it was going, however short. */
const FLICK = 0.5;
/** How dark the page behind gets, fully open. */
const DIM = 0.6;
/** The slide, open or shut. The finger's own drag has none: the drawer is where the finger is. */
const SLIDE_MS = 200;
const SLIDE = 'duration-200 ease-out motion-reduce:transition-none';

interface SwipeDrawerProps {
  side: DrawerSide;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Its name for a screen reader. */
  label: string;
  id?: string;
  /** Classes for the panel. */
  className?: string;
  /** What is in it. `shown`: on screen at all (open, being dragged, or sliding shut), so what it holds can draw its open state while it slides. */
  children: (shown: boolean) => ReactNode;
}

/**
 * A phone's drawer (below 768px, mobile.ts): a panel 90% of the window's width that slides in
 * from one side over the page, the 10% left over the page dimmed. A swipe in from the side
 * opens it, starting a little inside the edge (`EDGE_INSET`, the browser's back swipe is at the
 * edge itself); a swipe back, or a tap on the dim sliver, shuts it, and so does Escape. The
 * panel follows the finger while it drags and, let go, goes open or shut once it has come
 * `SNAP` of the way (or was flicked). A swipe that starts mostly down is a scroll and is left
 * alone. One open drawer keeps the other's edge shut, and an open dialog both. The page under it
 * does not scroll (globals.css, `data-drawer-open`). The safe areas are the panel's padding:
 * the top, the foot and the outer side. Drawn into the body, over the page's sticky row, the
 * friend chat and the players (z-50, later in the document); a tooltip is over it (z-[60]).
 */
export function SwipeDrawer({ side, open, onOpenChange, label, id, className, children }: SwipeDrawerProps) {
  const root = useRef<HTMLDivElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  // how far open while a finger holds it, 0 to 1; null while nobody does
  const [drag, setDrag] = useState<number | null>(null);
  // still on screen while it slides shut
  const [sliding, setSliding] = useState(false);
  // the listeners below are the document's, made once: they read these
  const openNow = useRef(open);
  const change = useRef(onOpenChange);
  useLayoutEffect(() => {
    openNow.current = open;
    change.current = onOpenChange;
  });

  // shut: on screen until the slide is over, then gone (and so out of the tab order)
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) setSliding(true);
  }
  useEffect(() => {
    if (open) return;
    const done = window.setTimeout(() => setSliding(false), SLIDE_MS);
    return () => window.clearTimeout(done);
  }, [open]);

  // open: the focus goes in, so the keyboard and a screen reader are in the drawer. shut: back where it was
  useEffect(() => {
    if (!open) return;
    const before = document.activeElement;
    panel.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('dialog[open]')) change.current(false);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (before instanceof HTMLElement && panel.current?.contains(document.activeElement)) before.focus({ preventScroll: true });
    };
  }, [open]);

  // the finger: the document's touches, so a swipe in from the edge starts over the page
  useEffect(() => {
    let start: { x: number; y: number; from: number; width: number } | null = null;
    let across = false;
    let at = 0;
    let lastX = 0;
    let lastT = 0;
    let speed = 0;
    // positive is the way that opens it
    const opening = (dx: number) => (side === 'left' ? dx : -dx);

    function begin(e: TouchEvent) {
      start = null;
      const touch = e.touches[0];
      if (e.touches.length !== 1 || !touch) return;
      if (openNow.current) {
        // shutting: a touch on the drawer or the sliver
        if (!(e.target instanceof Node) || !root.current?.contains(e.target)) return;
      } else {
        // opening: from the band just inside this side's edge, with no dialog up and the other drawer shut
        const fromEdge = side === 'left' ? touch.clientX : window.innerWidth - touch.clientX;
        if (fromEdge < EDGE_INSET || fromEdge > EDGE_INSET + EDGE_BAND) return;
        if (document.querySelector('dialog[open], [data-drawer-open]')) return;
      }
      start = { x: touch.clientX, y: touch.clientY, from: openNow.current ? 1 : 0, width: panel.current?.offsetWidth || window.innerWidth * 0.9 };
      across = false;
      at = start.from;
      lastX = touch.clientX;
      lastT = e.timeStamp;
      speed = 0;
    }

    function move(e: TouchEvent) {
      const touch = e.touches[0];
      if (!start || !touch) return;
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      if (!across) {
        if (Math.abs(dx) < LOCK_PX && Math.abs(dy) < LOCK_PX) return;
        // mostly down: a scroll, not this drawer's
        if (Math.abs(dy) >= Math.abs(dx)) {
          start = null;
          return;
        }
        across = true;
      }
      // the page (or the drawer's list) does not scroll under a sideways drag
      e.preventDefault();
      at = Math.min(1, Math.max(0, start.from + opening(dx) / start.width));
      const dt = e.timeStamp - lastT;
      if (dt > 0) speed = opening(touch.clientX - lastX) / dt;
      lastX = touch.clientX;
      lastT = e.timeStamp;
      setDrag(at);
    }

    function end() {
      if (!start) return;
      const from = start.from;
      start = null;
      if (!across) return;
      const next = Math.abs(speed) > FLICK ? speed > 0 : from === 0 ? at > SNAP : at > 1 - SNAP;
      setDrag(null);
      if (next !== openNow.current) change.current(next);
    }

    function cancel() {
      start = null;
      setDrag(null);
    }

    document.addEventListener('touchstart', begin, { passive: true });
    document.addEventListener('touchmove', move, { passive: false });
    document.addEventListener('touchend', end);
    document.addEventListener('touchcancel', cancel);
    return () => {
      document.removeEventListener('touchstart', begin);
      document.removeEventListener('touchmove', move);
      document.removeEventListener('touchend', end);
      document.removeEventListener('touchcancel', cancel);
    };
  }, [side]);

  const shown = open || sliding || drag !== null;
  const fraction = drag ?? (open ? 1 : 0);
  const offset = (side === 'left' ? fraction - 1 : 1 - fraction) * 100;

  return createPortal(
    <div
      ref={root}
      data-drawer={side}
      data-drawer-open={open || undefined}
      className={cn('fixed inset-0 z-50 overflow-hidden', !shown && 'invisible', !open && drag === null && 'pointer-events-none')}
    >
      {/* the page, dimmed: a tap shuts the drawer. no panning on it, so the page under does not scroll */}
      <div
        aria-hidden
        onClick={() => onOpenChange(false)}
        className={cn('absolute inset-0 touch-none bg-black', drag === null && cn('transition-opacity', SLIDE))}
        style={{ opacity: fraction * DIM }}
      />
      <div
        ref={panel}
        id={id}
        role="dialog"
        aria-modal={open}
        aria-label={label}
        tabIndex={-1}
        inert={!shown}
        className={cn(
          'absolute inset-y-0 flex w-[90%] flex-col bg-background pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] text-base text-textPrimary outline-none',
          side === 'left'
            ? 'left-0 border-r border-primaryStroke pl-[env(safe-area-inset-left)]'
            : 'right-0 border-l border-primaryStroke pr-[env(safe-area-inset-right)]',
          drag === null && cn('transition-transform', SLIDE),
          className
        )}
        style={{ transform: `translateX(${offset}%)` }}
      >
        {children(shown)}
      </div>
    </div>,
    document.body
  );
}
