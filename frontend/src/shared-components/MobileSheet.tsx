import { type PointerEvent as ReactPointerEvent, type RefObject, useEffect, useLayoutEffect, useRef } from 'react';

import { MOBILE_QUERY, useIsMobile, useLockedDocument, useVisibleViewport } from '@/infra/mobile';
import { cn } from '@/utils/cn';

/**
 * A phone has no centered modal (below 768px, mobile.ts). Each dialog there is one of two
 * things, and a desktop's is left exactly as it was (every class here is `max-md:`, and the
 * back button is only held on a phone):
 *
 * - a sheet up from the foot of the window (`SHEET_DIALOG` on a native `<dialog>`, with
 *   `data-sheet` and a `SheetGrab` at its head): a tap on the dim page above it, Escape (the
 *   browser's, for a modal `<dialog>`), its own close or no, a drag down by the grabber, and the
 *   browser's back button (`useSheetBack`) all shut it;
 * - a page over the page (`PAGE_DIALOG`: the whole window, its close a finger's 44px), shut by
 *   its close, Escape and the back button.
 *
 * The page under either does not scroll (globals.css: `dialog:modal`, `data-sheet-open`), and
 * since the lock is a `:has()` on what is in the document, it goes the moment the thing does.
 */

/** Let go past this share of its height and a sheet shuts. */
export const SHEET_SNAP = 0.3;
/** A flick down this fast (px per ms) shuts it, however short. */
export const SHEET_FLICK = 0.5;
/** The slide, up or down. Matches `sheet-up` in globals.css. */
export const SHEET_MS = 200;

const GRIP = 'touch-none select-none [-webkit-touch-callout:none]';

/**
 * A native `<dialog>` as a phone's sheet: the browser's centring and size caps go, it sits on the
 * foot of the window at its full width, no taller than 90% of it, its top edge the one stroke.
 * Paired with `data-sheet` (the slide up, globals.css) and a `SheetGrab` first inside it.
 */
export const SHEET_DIALOG = cn(
  'max-md:mx-0 max-md:mb-0 max-md:mt-auto max-md:w-full max-md:max-w-none max-md:max-h-[90dvh] max-md:overflow-y-auto max-md:overscroll-contain',
  'max-md:border-x-0 max-md:border-b-0 max-md:pt-0 max-md:pb-[calc(1.25rem+env(safe-area-inset-bottom))]'
);

/** A native `<dialog>` as a phone's page over the page: the whole window, no margins, no caps, no stroke. Its close is `SHEET_CLOSE`. */
export const PAGE_DIALOG = 'max-md:m-0 max-md:h-dvh max-md:max-h-none max-md:w-full max-md:max-w-none max-md:border-0';

/** A close in a dialog's corner, on a phone: a finger's 44px square. */
export const SHEET_CLOSE = 'max-md:h-11 max-md:w-11';

/**
 * The bar a sheet is pulled down by, first thing in it, a phone's only: the sheet follows the
 * finger (its own transform, no render per move), and let go past `SHEET_SNAP` of its height,
 * or flicked, it slides the rest of the way out and `onDismiss` takes it off. Anything less and
 * it springs back. The sheet is the nearest `[data-sheet]` up from the bar.
 */
export function SheetGrab({ onDismiss, className }: { onDismiss: () => void; className?: string }) {
  const held = useRef<{ id: number; y: number; lastY: number; lastT: number; speed: number; sheet: HTMLElement } | null>(null);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  function down(e: ReactPointerEvent<HTMLDivElement>) {
    const sheet = e.currentTarget.closest<HTMLElement>('[data-sheet]');
    if (e.button !== 0 || held.current || !sheet) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    // the finger has it: no slide in, no easing, until it lets go
    sheet.style.animation = 'none';
    sheet.style.transition = 'none';
    held.current = { id: e.pointerId, y: e.clientY, lastY: e.clientY, lastT: e.timeStamp, speed: 0, sheet };
  }
  function move(e: ReactPointerEvent<HTMLDivElement>) {
    const h = held.current;
    if (!h || e.pointerId !== h.id) return;
    const dt = e.timeStamp - h.lastT;
    if (dt > 0) h.speed = (e.clientY - h.lastY) / dt;
    h.lastY = e.clientY;
    h.lastT = e.timeStamp;
    h.sheet.style.transform = `translateY(${Math.max(0, e.clientY - h.y)}px)`;
  }
  function up(e: ReactPointerEvent<HTMLDivElement>, cancelled = false) {
    const h = held.current;
    if (!h || e.pointerId !== h.id) return;
    held.current = null;
    const pulled = Math.max(0, e.clientY - h.y);
    const gone = !cancelled && (h.speed > SHEET_FLICK || pulled > h.sheet.getBoundingClientRect().height * SHEET_SNAP);
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    h.sheet.style.transition = still ? 'none' : `transform ${SHEET_MS}ms ease-out`;
    h.sheet.style.transform = gone ? 'translateY(100%)' : '';
    if (gone) timer.current = window.setTimeout(onDismiss, still ? 0 : SHEET_MS);
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
      <span className="h-1 w-10 bg-primaryStroke" />
    </div>
  );
}

// the back button

/** On the history entry pushed for the sheets: the one the back button leaves to shut them. */
const KEY = 'mobileSheet';

/** The sheets and pages up now, oldest first: the back button shuts the newest. */
const stack: { dismiss: () => void }[] = [];
let listening = false;

const marked = () => Boolean((window.history.state as Record<string, unknown> | null)?.[KEY]);

/** One entry over the page for every sheet up at once: a sheet opened from another (a profile's "message") adds none. */
function mark() {
  if (!marked()) window.history.pushState({ ...(window.history.state as object | null), [KEY]: true }, '');
}

function onPop() {
  if (marked()) {
    // landed on an entry left over from a sheet that went another way (a page change from inside it): step over it
    if (stack.length === 0) window.history.back();
    return;
  }
  const top = stack.pop();
  if (!top) return;
  top.dismiss();
  // more still up: the next back shuts the next one
  if (stack.length > 0) mark();
}

/**
 * Up, it holds an entry in the history; gone without the back button (its close, the backdrop,
 * a drag), it takes the entry back off, a tick later so a sheet that hands over to another (or a
 * link inside it, whose page is the new entry) is not undone.
 */
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

/**
 * The browser's back button shuts this sheet or page while it is up, on a phone, instead of
 * leaving the page under it. `dismiss` is how it shuts any other way (a dialog's `close()`).
 */
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

// the keyboard

/** The keyboard up, at least this much of the dimmed page stays above a sheet, to tap it shut. */
const KEYBOARD_ROOM = 24;
/** Kept between the box in use (or its form's submit) and the sheet's edge. */
const KEEP = 12;

/**
 * A dialog just opened with `showModal()`: the caret goes in its first box (`selector`) on a
 * desktop. On a phone it does not: that raises the keyboard while the sheet is still sliding up,
 * and iOS pans the page to the box, so the sheet reads as a box floating mid-window, a desktop's
 * modal, until the keyboard goes. There the keyboard comes when a box is tapped, so a box that
 * `showModal()` focused on its own is let go too. Read straight from the window, for the layout
 * effect that opens the dialog.
 */
export function focusOnOpen(dialog: HTMLDialogElement, selector: string) {
  if (!window.matchMedia(MOBILE_QUERY).matches) {
    dialog.querySelector<HTMLElement>(selector)?.focus();
    return;
  }
  const at = document.activeElement;
  if (at instanceof HTMLElement && dialog.contains(at) && at.matches('input, textarea, select, [contenteditable]')) at.blur();
}

/**
 * A form's sheet (`SHEET_DIALOG`) on a phone's keyboard, as the chat sheet does it (FriendChat.tsx):
 * while it is up the document is pinned where it was scrolled to (`useLockedDocument`), so iOS
 * cannot scroll the page to bring a box over the keyboard; with the keyboard up the sheet sits on
 * it, no taller than what it leaves (`useVisibleViewport`), and scrolls itself so the box in use,
 * and its form's submit when there is room for both, are in sight. Nothing on a desktop.
 */
export function useSheetKeyboard(ref: RefObject<HTMLDialogElement | null>) {
  const mobile = useIsMobile();
  const view = useVisibleViewport(mobile, true);
  useLockedDocument(mobile, true);
  const raised = view?.keyboard ? view : null;

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const s = dialog.style;
    if (!raised) {
      s.marginBottom = s.maxHeight = s.paddingBottom = '';
      return;
    }
    s.marginBottom = `${raised.bottom}px`;
    s.maxHeight = `${Math.max(0, raised.height - KEYBOARD_ROOM)}px`;
    // the keyboard covers the home bar: no safe area under the last row
    s.paddingBottom = '1.25rem';
    inSight(dialog);
  }, [ref, raised]);

  // another box tapped while the keyboard is already up
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || !raised) return;
    let frame = 0;
    const focused = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => inSight(dialog));
    };
    dialog.addEventListener('focusin', focused);
    return () => {
      dialog.removeEventListener('focusin', focused);
      cancelAnimationFrame(frame);
    };
  }, [ref, raised]);
}

/** Scroll the sheet so the box in use is in it, with its form's submit under it when both fit. */
function inSight(dialog: HTMLDialogElement) {
  const field = document.activeElement;
  if (!(field instanceof HTMLElement) || field === dialog || !dialog.contains(field)) return;
  const box = dialog.getBoundingClientRect();
  const at = field.getBoundingClientRect();
  const submit = field.closest('form')?.querySelector<HTMLElement>('[type="submit"]');
  const last = Math.max(at.bottom, submit?.getBoundingClientRect().bottom ?? at.bottom);
  let by = Math.max(0, last - (box.bottom - KEEP));
  // the box itself wins over the submit
  if (at.top - by < box.top + KEEP) by = at.top - box.top - KEEP;
  if (by) dialog.scrollTop += by;
}
