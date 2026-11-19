import { RiCloseLine } from '@remixicon/react';
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useSheetBack } from '@/shared-components/MobileSheet';
import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

export type DrawerSide = 'left' | 'right';

/** How far a finger moves before the drawer decides it is a swipe across and not a scroll down. */
const LOCK_PX = 10;
/** Past this share of its width the drawer shuts when let go. */
const SNAP = 0.4;
/** A flick this fast (px per ms) toward the edge shuts it, however short. */
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
  /** What is in it. `shown`: on screen at all (open, or sliding shut), so what it holds can draw its open state while it slides. */
  children: (shown: boolean) => ReactNode;
}

/**
 * A drawer's way out, for its head: a 44px ×, named `close`. The dim sliver and Escape shut it
 * too, but a finger needs something it can see.
 */
export function DrawerClose({ onClose, className }: { onClose: () => void; className?: string }) {
  return (
    <Tooltip content="close">
      <button
        type="button"
        aria-label="close"
        onClick={onClose}
        className={cn(
          'flex h-11 w-11 shrink-0 items-center justify-center border border-transparent text-textSecondary hover:text-textPrimary focus-visible:border-primaryBlue focus-visible:outline-none',
          className
        )}
      >
        <RiCloseLine aria-hidden size={22} />
      </button>
    </Tooltip>
  );
}

/**
 * A phone's drawer (below 768px, mobile.ts): a panel 90% of the window's width that slides in
 * from one side over the page, the 10% left over the page dimmed. A button opens it (the menu
 * at the left of the title row, a group's at the right), never a swipe in from the edge: the
 * left one is the browser's back swipe. A tap on the dim sliver shuts it, and so do Escape, its
 * own × (`DrawerClose`) and a swipe back toward its edge: the panel follows the finger and, let
 * go, shuts once it has come `SNAP` of the way (or was flicked). A swipe that starts mostly
 * down is a scroll and is left alone. The page under it does not scroll (globals.css,
 * `data-drawer-open`). The safe areas are the panel's padding: the top, the foot and the outer
 * side. Drawn into the body, over the page's sticky row, the friend chat and the players (z-50,
 * later in the document); a tooltip is over it (z-[60]).
 */
export function SwipeDrawer({ side, open, onOpenChange, label, id, className, children }: SwipeDrawerProps) {
  const root = useRef<HTMLDivElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  // how far open while a finger holds it, 0 to 1; null while nobody does
  const [drag, setDrag] = useState<number | null>(null);
  // still on screen while it slides shut
  const [sliding, setSliding] = useState(false);
  // the listeners below are made once: they read this
  const change = useRef(onOpenChange);
  useLayoutEffect(() => {
    change.current = onOpenChange;
  });

  // the browser's back button shuts it, as it does a sheet (MobileSheet.tsx)
  useSheetBack(() => change.current(false), open);

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
      // not while a modal dialog is over it: that escape is the dialog's. a panel merely shown (the notifications) does not count
      if (e.key === 'Escape' && !document.querySelector('dialog:modal')) change.current(false);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (before instanceof HTMLElement && panel.current?.contains(document.activeElement)) before.focus({ preventScroll: true });
    };
  }, [open]);

  // the finger, shutting it: touches on the drawer or the sliver, the only ones it gets (shut, it takes no pointer)
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    let start: { x: number; y: number; width: number } | null = null;
    let across = false;
    let at = 1;
    let lastX = 0;
    let lastT = 0;
    let speed = 0;
    // positive is the way that opens it
    const opening = (dx: number) => (side === 'left' ? dx : -dx);

    function begin(e: TouchEvent) {
      start = null;
      const touch = e.touches[0];
      if (e.touches.length !== 1 || !touch) return;
      start = { x: touch.clientX, y: touch.clientY, width: panel.current?.offsetWidth || window.innerWidth * 0.9 };
      across = false;
      at = 1;
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
      at = Math.min(1, Math.max(0, 1 + opening(dx) / start.width));
      const dt = e.timeStamp - lastT;
      if (dt > 0) speed = opening(touch.clientX - lastX) / dt;
      lastX = touch.clientX;
      lastT = e.timeStamp;
      setDrag(at);
    }

    function end() {
      if (!start) return;
      start = null;
      if (!across) return;
      const shut = Math.abs(speed) > FLICK ? speed < 0 : at < 1 - SNAP;
      setDrag(null);
      if (shut) change.current(false);
    }

    function cancel() {
      start = null;
      setDrag(null);
    }

    el.addEventListener('touchstart', begin, { passive: true });
    el.addEventListener('touchmove', move, { passive: false });
    el.addEventListener('touchend', end);
    el.addEventListener('touchcancel', cancel);
    return () => {
      el.removeEventListener('touchstart', begin);
      el.removeEventListener('touchmove', move);
      el.removeEventListener('touchend', end);
      el.removeEventListener('touchcancel', cancel);
    };
  }, [side]);

  const shown = open || sliding;
  const fraction = drag ?? (open ? 1 : 0);
  const offset = (side === 'left' ? fraction - 1 : 1 - fraction) * 100;

  return createPortal(
    <div
      ref={root}
      data-drawer={side}
      data-drawer-open={open || undefined}
      className={cn('fixed inset-0 z-50 overflow-hidden', !shown && 'invisible', !open && 'pointer-events-none')}
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
