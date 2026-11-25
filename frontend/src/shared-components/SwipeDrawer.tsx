import { RiCloseLine } from '@remixicon/react';
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useSheetBack } from '@/shared-components/MobileSheet';
import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

export type DrawerSide = 'left' | 'right';

const LOCK_PX = 10;
const SNAP = 0.4;
const FLICK = 0.5;
const DIM = 0.6;
const SLIDE_MS = 200;
const SLIDE = 'duration-200 ease-out motion-reduce:transition-none';

interface SwipeDrawerProps {
  side: DrawerSide;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  label: string;
  id?: string;
  className?: string;
  children: (shown: boolean) => ReactNode;
}

export function DrawerClose({ onClose, className }: { onClose: () => void; className?: string }) {
  return (
    <Tooltip content="close">
      <button
        type="button"
        aria-label="close"
        onClick={onClose}
        className={cn(
          'flex h-11 w-11 shrink-0 items-center justify-center rounded-control border border-transparent text-textSecondary hover:text-textPrimary focus-visible:border-primaryBlue focus-visible:outline-none',
          className
        )}
      >
        <RiCloseLine aria-hidden size={22} />
      </button>
    </Tooltip>
  );
}

export function SwipeDrawer({ side, open, onOpenChange, label, id, className, children }: SwipeDrawerProps) {
  const root = useRef<HTMLDivElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const [sliding, setSliding] = useState(false);
  const change = useRef(onOpenChange);
  useLayoutEffect(() => {
    change.current = onOpenChange;
  });

  useSheetBack(() => change.current(false), open);

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

  useEffect(() => {
    if (!open) return;
    const before = document.activeElement;
    panel.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('dialog:modal')) change.current(false);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (before instanceof HTMLElement && panel.current?.contains(document.activeElement)) before.focus({ preventScroll: true });
    };
  }, [open]);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    let start: { x: number; y: number; width: number } | null = null;
    let across = false;
    let at = 1;
    let lastX = 0;
    let lastT = 0;
    let speed = 0;
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
        if (Math.abs(dy) >= Math.abs(dx)) {
          start = null;
          return;
        }
        across = true;
      }
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
