import { type PointerEvent as ReactPointerEvent, useEffect, useLayoutEffect, useRef } from 'react';

import { MOBILE_QUERY, useIsMobile } from '@/infra/mobile';
import { cn } from '@/utils/cn';

export const SHEET_SNAP = 0.3;
export const SHEET_FLICK = 0.5;
export const SHEET_MS = 200;

const GRIP = 'touch-none select-none [-webkit-touch-callout:none]';

export const SHEET_DIALOG = cn(
  'max-md:mx-0 max-md:rounded-t-panel max-md:mb-[var(--kbh,0px)] max-md:mt-auto max-md:w-full max-md:max-w-none max-md:max-h-[min(90dvh,calc(var(--vvh,100dvh)-24px))] max-md:overflow-y-auto max-md:overscroll-contain',
  'max-md:border-x-0 max-md:border-b-0 max-md:pt-0 max-md:pb-[calc(1.25rem+env(safe-area-inset-bottom))] max-md:[html[data-keyboard]_&]:pb-5'
);

export const PAGE_DIALOG = 'max-md:m-0 max-md:mt-[var(--vvt,0px)] max-md:h-[var(--vvh,100dvh)] max-md:max-h-none max-md:w-full max-md:max-w-none max-md:border-0';

export const SHEET_CLOSE = 'max-md:h-11 max-md:w-11';

export const SHEET_TALL = cn(
  'max-md:h-[min(60dvh,calc(var(--vvh,100dvh)-env(safe-area-inset-top)))] max-md:max-h-[min(92dvh,calc(var(--vvh,100dvh)-env(safe-area-inset-top)))]',
  'max-md:data-[sheet-size=tall]:h-[min(92dvh,calc(var(--vvh,100dvh)-env(safe-area-inset-top)))]'
);

interface Held {
  id: number;
  y: number;
  lastY: number;
  lastT: number;
  speed: number;
  sheet: HTMLElement;
  from: number;
  low: number;
  high: number;
  wasTall: boolean;
}

function sizeAt(sheet: HTMLElement, tall: boolean): number {
  if (tall) sheet.dataset.sheetSize = 'tall';
  else delete sheet.dataset.sheetSize;
  return sheet.getBoundingClientRect().height;
}

export function SheetGrab({ onDismiss, tall = false, className }: { onDismiss: () => void; tall?: boolean; className?: string }) {
  const held = useRef<Held | null>(null);
  const timer = useRef(0);
  const settle = useRef(0);
  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
      window.clearTimeout(settle.current);
    },
    []
  );

  function down(e: ReactPointerEvent<HTMLDivElement>) {
    const sheet = e.currentTarget.closest<HTMLElement>('[data-sheet]');
    if (e.button !== 0 || held.current || !sheet) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    window.clearTimeout(settle.current);
    sheet.style.animation = 'none';
    sheet.style.transition = 'none';
    if (tall) sheet.style.height = '';
    const from = sheet.getBoundingClientRect().height;
    const wasTall = sheet.dataset.sheetSize === 'tall';
    let low = from;
    let high = from;
    if (tall) {
      low = sizeAt(sheet, false);
      high = Math.max(low, sizeAt(sheet, true));
      sizeAt(sheet, wasTall);
      sheet.style.height = `${from}px`;
    }
    held.current = { id: e.pointerId, y: e.clientY, lastY: e.clientY, lastT: e.timeStamp, speed: 0, sheet, from, low, high, wasTall };
  }
  function move(e: ReactPointerEvent<HTMLDivElement>) {
    const h = held.current;
    if (!h || e.pointerId !== h.id) return;
    const dt = e.timeStamp - h.lastT;
    if (dt > 0) h.speed = (e.clientY - h.lastY) / dt;
    h.lastY = e.clientY;
    h.lastT = e.timeStamp;
    const want = h.from - (e.clientY - h.y);
    if (tall) h.sheet.style.height = `${Math.min(h.high, Math.max(h.low, want))}px`;
    h.sheet.style.transform = `translateY(${Math.max(0, (tall ? h.low : h.from) - want)}px)`;
  }
  function up(e: ReactPointerEvent<HTMLDivElement>, cancelled = false) {
    const h = held.current;
    if (!h || e.pointerId !== h.id) return;
    held.current = null;
    const want = h.from - (e.clientY - h.y);
    const pulled = Math.max(0, (tall ? h.low : h.from) - want);
    const flicked = h.speed > SHEET_FLICK && (!tall || (pulled > 0 && !h.wasTall));
    const gone = !cancelled && (flicked || pulled > (tall ? h.low : h.sheet.getBoundingClientRect().height) * SHEET_SNAP);
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    h.sheet.style.transition = still ? 'none' : `transform ${SHEET_MS}ms ease-out, height ${SHEET_MS}ms ease-out`;
    h.sheet.style.transform = gone ? 'translateY(100%)' : '';
    if (gone) {
      timer.current = window.setTimeout(onDismiss, still ? 0 : SHEET_MS);
      return;
    }
    if (!tall) return;
    const now = Math.min(h.high, Math.max(h.low, want));
    const toTall = cancelled ? h.wasTall : h.speed < -SHEET_FLICK ? true : h.speed > SHEET_FLICK ? false : now > (h.low + h.high) / 2;
    if (toTall) h.sheet.dataset.sheetSize = 'tall';
    else delete h.sheet.dataset.sheetSize;
    h.sheet.style.height = `${toTall ? h.high : h.low}px`;
    const sheet = h.sheet;
    settle.current = window.setTimeout(() => {
      sheet.style.height = '';
    }, still ? 0 : SHEET_MS);
  }

  return (
    <div
      aria-hidden
      data-sheet-grab=""
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={(e) => up(e)}
      onPointerCancel={(e) => up(e, true)}
      className={cn('flex shrink-0 cursor-grab justify-center pb-3 pt-2 md:hidden', GRIP, className)}
    >
      <span className="h-1 w-10 rounded-control bg-primaryStroke" />
    </div>
  );
}

const KEY = 'mobileSheet';

const stack: { dismiss: () => void }[] = [];
let listening = false;

const marked = () => Boolean((window.history.state as Record<string, unknown> | null)?.[KEY]);

function mark() {
  if (!marked()) window.history.pushState({ ...(window.history.state as object | null), [KEY]: true }, '');
}

function onPop() {
  if (marked()) {
    if (stack.length === 0) window.history.back();
    return;
  }
  const top = stack.pop();
  if (!top) return;
  top.dismiss();
  if (stack.length > 0) mark();
}

function hold(entry: { dismiss: () => void }): () => void {
  if (!listening) {
    window.addEventListener('popstate', onPop);
    listening = true;
  }
  stack.push(entry);
  mark();
  return () => {
    const at = stack.indexOf(entry);
    if (at < 0) return;
    stack.splice(at, 1);
    if (stack.length > 0) return;
    window.setTimeout(() => {
      if (stack.length === 0 && marked()) window.history.back();
    }, 0);
  };
}

export function useSheetBack(dismiss: () => void, up = true) {
  const mobile = useIsMobile();
  const latest = useRef(dismiss);
  useLayoutEffect(() => {
    latest.current = dismiss;
  });
  useEffect(() => {
    if (!up || !mobile || !window.matchMedia(MOBILE_QUERY).matches) return;
    return hold({ dismiss: () => latest.current() });
  }, [up, mobile]);
}

export function focusOnOpen(dialog: HTMLDialogElement, selector: string) {
  if (!window.matchMedia(MOBILE_QUERY).matches) {
    dialog.querySelector<HTMLElement>(selector)?.focus();
    return;
  }
  const at = document.activeElement;
  if (at instanceof HTMLElement && dialog.contains(at) && at.matches('input, textarea, select, [contenteditable]')) at.blur();
}
