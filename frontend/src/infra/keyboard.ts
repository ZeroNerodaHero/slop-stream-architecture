import { type PointerEvent as ReactPointerEvent, type RefObject, useEffect, useSyncExternalStore } from 'react';

import { MOBILE_QUERY } from '@/infra/mobile';

/**
 * A phone's on-screen keyboard, the one place the site handles it (below 768px only; a desktop
 * gets none of this, `installMobileKeyboard` does nothing there). Every surface with a box to
 * type in reads it the same way:
 *
 * - The visual viewport, kept as css variables on <html>: `--vvh` its height, `--vvt` how far
 *   the browser has panned it down (iOS does that instead of shrinking the window), `--kbh` the
 *   keyboard's height under it. A box that sits on the keyboard is sized with them, not `dvh`:
 *   a page that is the window is `fixed top-[var(--vvt)] h-[var(--vvh)]`, a sheet is
 *   `mb-[var(--kbh)]`, a page over the page (`PAGE_DIALOG`) is the window's top and height.
 * - While a box has the focus the document is pinned (`data-kbd-lock`, globals.css): html and
 *   body `position: fixed`, no overscroll, the body drawn where it was scrolled to and moved
 *   down by the pan, so iOS can scroll nothing to bring the box into sight and nothing jumps. A
 *   blur waits `BLUR_GRACE_MS` (a tap on send, a hop from one box to the next) before the page
 *   is let go and put back where it was, once. No `window.scrollTo` while it is pinned.
 * - The box in use is kept over the keyboard by scrolling the pane it is in (`reveal`), never
 *   the window.
 * - `data-keyboard` on <html>: a box has the focus or the keyboard is up. Tailwind reads it as
 *   `[html[data-keyboard]_&]:` (a send row loses the home bar's padding).
 *
 * A page that is the window holds the pin the whole time it is up (`usePinnedPage`). React reads
 * the same numbers with `useKeyboard`. A send button beside a box keeps the focus
 * with `keepFocus`, and a list of lines that sits at its newest stays there with `useBottomPin`.
 */

/** The window is this much taller than the visual viewport, or more: the on-screen keyboard is what is under it. */
const KEYBOARD_GAP = 120;
/** How long a blur waits before the page is let go: a tap on send blurs and refocuses within it. */
export const BLUR_GRACE_MS = 150;
/** A finger that moves this far between down and up dragged, it did not tap. */
const TAP_SLOP = 10;
/** Kept between the box in use (or its form's submit) and the edge of what the keyboard leaves. */
const KEEP = 12;

export type Keyboard = {
  /** How tall the visible part of the window is. */
  height: number;
  /** How far the browser has panned the page down to keep a focused box in sight. */
  top: number;
  /** How far up from the window's foot the visible part ends: the keyboard's height, 0 without one. */
  bottom: number;
  /** The keyboard is up, or a box has the focus and it is on its way. */
  keyboard: boolean;
  /** The box being typed in (after the blur's grace), or null. */
  focused: HTMLElement | null;
};

const IDLE: Keyboard = { height: 0, top: 0, bottom: 0, keyboard: false, focused: null };
let state: Keyboard = IDLE;
let installed = false;
const listeners = new Set<() => void>();

function publish(next: Keyboard) {
  if (next.height === state.height && next.top === state.top && next.bottom === state.bottom && next.keyboard === state.keyboard && next.focused === state.focused)
    return;
  state = next;
  listeners.forEach((changed) => changed());
}

function subscribe(changed: () => void): () => void {
  listeners.add(changed);
  return () => listeners.delete(changed);
}

/** The keyboard and what it leaves of the window, on a phone. `IDLE` (all zero) on a desktop. */
export function useKeyboard(): Keyboard {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => IDLE
  );
}

// the pin (`data-kbd-lock`, globals.css): held while a box has the focus, and by a page that is the window
// (`usePinnedPage`). where the page was scrolled to when it was pinned, and on which page
const holders = new Set<string>();
let phoneNow = false;
let pinned: { y: number; path: string } | null = null;

function hold(by: string) {
  holders.add(by);
  repin();
}
function release(by: string) {
  holders.delete(by);
  repin();
}
function repin() {
  const root = document.documentElement;
  const want = phoneNow && holders.size > 0;
  if (want && !pinned) {
    pinned = { y: window.scrollY, path: location.pathname };
    root.style.setProperty('--lock-y', `${pinned.y}px`);
    root.setAttribute('data-kbd-lock', '');
  } else if (!want && pinned) {
    const was = pinned;
    pinned = null;
    root.removeAttribute('data-kbd-lock');
    root.style.removeProperty('--lock-y');
    // back where it was, once. not on another page (a send that navigated): that one starts at its own top
    if (was.y && was.path === location.pathname) window.scrollTo(0, was.y);
  }
}

let pages = 0;
/**
 * A phone's page that is the window (WatchPage.tsx, LivePage.tsx: `fixed`, the visual viewport's
 * top and height): the document under it is pinned the whole time it is up, not only while a box
 * has the focus, so a drag on it bounces nothing.
 */
export function usePinnedPage(on: boolean) {
  useEffect(() => {
    if (!on) return;
    const by = `page${++pages}`;
    hold(by);
    return () => release(by);
  }, [on]);
}

/**
 * Someone is typing in the box with this id on a phone (`useKeyboard`'s focus, so a blur waits
 * `BLUR_GRACE_MS` and a tap on send does not flicker). The stream's chat (`chat-text`) on a page
 * that is the window makes its player a strip (mobile.ts, `keyboardStrip`).
 */
export function useTypingIn(id: string): boolean {
  return useKeyboard().focused?.id === id;
}

const NOT_TYPED = new Set(['checkbox', 'radio', 'range', 'file', 'color', 'button', 'submit', 'reset', 'image', 'hidden']);

/** A box the keyboard comes up for. */
function typedIn(el: Element | null): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled;
  if (el instanceof HTMLInputElement) return !NOT_TYPED.has(el.type) && !el.readOnly && !el.disabled;
  return false;
}

/**
 * Once, at startup (main.tsx). On a phone's width it follows the visual viewport and the focus;
 * crossing to a desktop's width lets everything go.
 */
export function installMobileKeyboard() {
  if (installed) return;
  installed = true;
  const phone = window.matchMedia(MOBILE_QUERY);
  const vv = window.visualViewport;
  const root = document.documentElement;
  let on = false;
  let grace = 0;
  let focused: HTMLElement | null = null;
  let hadKeyboard = false;
  // the window's height with no box focused, and its width then. iOS 26 shrinks `innerHeight` to the visual viewport once
  // the keyboard is up and the page is pinned, so the keyboard is measured against the height from before it came
  let full = window.innerHeight;
  let fullWidth = window.innerWidth;
  const pin = () => hold('focus');
  const unpin = () => release('focus');

  const measure = () => {
    if (!on) return;
    if (!focused || window.innerWidth !== fullWidth) {
      full = window.innerHeight;
      fullWidth = window.innerWidth;
    }
    const height = Math.round(vv ? vv.height : window.innerHeight);
    const top = Math.round(vv ? vv.offsetTop : 0);
    const bottom = Math.max(0, Math.round(full - height - top));
    const up = full - height > KEYBOARD_GAP;
    root.style.setProperty('--vvh', `${height}px`);
    root.style.setProperty('--vvt', `${top}px`);
    root.style.setProperty('--kbh', `${bottom}px`);
    // the keyboard went while the box kept the focus (android's back): the box lets go too, so the page comes back with it
    if (hadKeyboard && !up && focused && document.activeElement === focused) focused.blur();
    hadKeyboard = up;
    const keyboard = up || focused !== null;
    root.toggleAttribute('data-keyboard', keyboard);
    publish({ height, top, bottom, keyboard, focused });
    if (up && focused) reveal(focused, top, height);
  };

  const focusin = (e: FocusEvent) => {
    if (!typedIn(e.target as Element)) return;
    window.clearTimeout(grace);
    focused = e.target as HTMLElement;
    pin();
    measure();
    // another box tapped with the keyboard already up: no resize comes, so it is brought into sight here
    requestAnimationFrame(() => {
      if (focused && hadKeyboard) reveal(focused, state.top, state.height);
    });
  };
  const focusout = () => {
    window.clearTimeout(grace);
    grace = window.setTimeout(() => {
      const now = document.activeElement;
      if (typedIn(now)) {
        focused = now;
      } else {
        focused = null;
        unpin();
      }
      measure();
    }, BLUR_GRACE_MS);
  };

  // A tap on a box that does not have the focus yet gives it the focus here, with `preventScroll`, instead of the
  // browser's own focus. iOS's own scrolls the page to bring the box over the keyboard, animating the pan as the
  // keyboard rises and reporting it only once it is up, so whatever follows the pan is a frame behind it and the page
  // jumps. Pinned, nothing needs that scroll: the box is already where the keyboard leaves room (`--vvh`, `reveal`).
  // A drag that starts on a box is a drag, not a tap, and is left alone.
  let tap: { x: number; y: number; on: EventTarget | null } | null = null;
  const touchstart = (e: TouchEvent) => {
    const t = e.touches[0];
    tap = e.touches.length === 1 && t ? { x: t.clientX, y: t.clientY, on: e.target } : null;
  };
  // While a box has the focus, a drag that no pane under the finger can take (one at its end, or none at all) would
  // go on to the page, and iOS pans the whole of it up under the keyboard. It is stopped there instead: a pane
  // scrolls to its end and no further. Sideways drags are left alone.
  const touchmove = (e: TouchEvent) => {
    const t = e.touches[0];
    if (!focused || !tap || !t || !e.cancelable || e.touches.length !== 1) return;
    const dy = t.clientY - tap.y;
    if (Math.abs(dy) < Math.abs(t.clientX - tap.x)) return;
    if (!canScroll(e.target, dy)) e.preventDefault();
  };
  const touchend = (e: TouchEvent) => {
    const was = tap;
    tap = null;
    const box = e.target;
    const t = e.changedTouches[0];
    if (!was || !t || was.on !== box || !e.cancelable || Math.hypot(t.clientX - was.x, t.clientY - was.y) > TAP_SLOP) return;
    if (!(box instanceof HTMLInputElement || box instanceof HTMLTextAreaElement) || !typedIn(box) || document.activeElement === box) return;
    e.preventDefault();
    box.focus({ preventScroll: true });
  };

  const start = () => {
    if (on) return;
    on = true;
    phoneNow = true;
    repin();
    vv?.addEventListener('resize', measure);
    vv?.addEventListener('scroll', measure);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, { passive: true });
    document.addEventListener('touchstart', touchstart, { capture: true, passive: true });
    document.addEventListener('touchmove', touchmove, { capture: true, passive: false });
    document.addEventListener('touchend', touchend, { capture: true });
    document.addEventListener('focusin', focusin);
    document.addEventListener('focusout', focusout);
    if (typedIn(document.activeElement)) {
      focused = document.activeElement;
      pin();
    }
    measure();
  };
  const stop = () => {
    if (!on) return;
    on = false;
    vv?.removeEventListener('resize', measure);
    vv?.removeEventListener('scroll', measure);
    window.removeEventListener('resize', measure);
    window.removeEventListener('scroll', measure);
    document.removeEventListener('touchstart', touchstart, { capture: true });
    document.removeEventListener('touchmove', touchmove, { capture: true });
    document.removeEventListener('touchend', touchend, { capture: true });
    document.removeEventListener('focusin', focusin);
    document.removeEventListener('focusout', focusout);
    window.clearTimeout(grace);
    focused = null;
    hadKeyboard = false;
    holders.delete('focus');
    phoneNow = false;
    repin();
    for (const name of ['--vvh', '--vvt', '--kbh']) root.style.removeProperty(name);
    root.removeAttribute('data-keyboard');
    publish(IDLE);
  };

  phone.addEventListener('change', () => (phone.matches ? start() : stop()));
  if (phone.matches) start();
}

/** A pane from `from` up can still scroll for a finger moved `dy` (down is positive: the pane goes up). */
function canScroll(from: EventTarget | null, dy: number): boolean {
  for (let at = from instanceof Element ? from : null; at && at !== document.body && at !== document.documentElement; at = at.parentElement) {
    if (!(at instanceof HTMLElement) || at.scrollHeight <= at.clientHeight) continue;
    const { overflowY } = getComputedStyle(at);
    if (overflowY !== 'auto' && overflowY !== 'scroll') continue;
    if (dy > 0 ? at.scrollTop > 0 : at.scrollTop + at.clientHeight < at.scrollHeight - 1) return true;
  }
  return false;
}

/** The nearest pane up from `el` that scrolls on its own; never the document. */
function scroller(el: HTMLElement): HTMLElement | null {
  for (let at = el.parentElement; at && at !== document.body && at !== document.documentElement; at = at.parentElement) {
    const { overflowY } = getComputedStyle(at);
    if ((overflowY === 'auto' || overflowY === 'scroll') && at.scrollHeight > at.clientHeight) return at;
  }
  return null;
}

/**
 * The box in use, and its form's submit when there is room for both, scrolled into what the
 * keyboard leaves (`top` and `height` of the visual viewport, in the window's coordinates) by
 * the pane it is in. Nothing to do for a box already in sight, and nothing scrolls the window.
 */
function reveal(field: HTMLElement, top: number, height: number) {
  const pane = scroller(field);
  if (!pane) return;
  const box = pane.getBoundingClientRect();
  const lo = Math.max(box.top, top) + KEEP;
  const hi = Math.min(box.bottom, top + height) - KEEP;
  const at = field.getBoundingClientRect();
  const submit = field.closest('form')?.querySelector<HTMLElement>('[type="submit"]');
  const last = Math.max(at.bottom, submit?.getBoundingClientRect().bottom ?? at.bottom);
  let by = Math.max(0, last - hi);
  // the box itself wins over the submit
  if (at.top - by < lo) by = at.top - lo;
  if (by) pane.scrollTop += by;
}

/**
 * `onPointerDown` for a send button beside a box: a finger's press does not take the focus from
 * the box, so the keyboard stays up and nothing under it moves. The click still sends. A mouse's
 * press is left as it was, and so is a press with no box focused.
 */
export function keepFocus(e: ReactPointerEvent) {
  if (e.pointerType !== 'mouse' && typedIn(document.activeElement)) e.preventDefault();
}

/** When a finger or a wheel last moved each pinned list: only they take it off its newest line. */
const handled = new WeakMap<HTMLElement, { touching: boolean; at: number }>();
/** A wheel's or a key's scroll counts this long after it. */
const HAND_MS = 250;

/**
 * A list of lines (a chat's, a dm's) that sits at its newest line stays there while its box
 * changes height under it: the keyboard coming and going, the player easing to a strip, a strip
 * of pictures opening over the box, a picture on a line loading. `stuck` is the list's own "at
 * the newest line"; `key` re-arms it for a new list element. Pair with `stuckAfterScroll` in
 * the list's `onScroll`.
 */
/** A line's media changed size with no `load` to say so (a video's poster): the list keeps its newest line in view through it. */
export const MEDIA_SIZED = 'chat-media-sized';

export function useBottomPin(list: RefObject<HTMLElement | null>, stuck: { current: boolean }, key?: unknown) {
  useEffect(() => {
    const el = list.current;
    if (!el) return;
    const hand = { touching: false, at: 0 };
    handled.set(el, hand);
    const restick = () => {
      if (stuck.current) el.scrollTop = el.scrollHeight;
    };
    const onLoad = (e: Event) => {
      if (e.target instanceof HTMLImageElement) restick();
    };
    // a chat video's poster coming in grows its line, and fires no `load` of its own (ChatVideoPlayer.tsx)
    el.addEventListener(MEDIA_SIZED, restick, true);
    const down = () => {
      hand.touching = true;
    };
    const up = () => {
      hand.touching = false;
      hand.at = performance.now();
    };
    const moved = () => {
      hand.at = performance.now();
    };
    // `load` does not bubble: caught on its way down
    el.addEventListener('load', onLoad, true);
    el.addEventListener('touchstart', down, { passive: true });
    el.addEventListener('touchend', up, { passive: true });
    el.addEventListener('touchcancel', up, { passive: true });
    el.addEventListener('wheel', moved, { passive: true });
    el.addEventListener('keydown', moved);
    const seen = new ResizeObserver(restick);
    seen.observe(el);
    return () => {
      seen.disconnect();
      el.removeEventListener('load', onLoad, true);
      el.removeEventListener(MEDIA_SIZED, restick, true);
      el.removeEventListener('touchstart', down);
      el.removeEventListener('touchend', up);
      el.removeEventListener('touchcancel', up);
      el.removeEventListener('wheel', moved);
      el.removeEventListener('keydown', moved);
      handled.delete(el);
    };
  }, [list, stuck, key]);
}

/**
 * What a scroll of a pinned list says about `stuck`. At the newest line: stuck. Off it: unstuck
 * on a desktop as always, and on a phone only when a finger or a wheel moved it. A phone's list
 * is also scrolled by its box changing height (the keyboard, the player's strip) and by iOS's
 * own nudges, and none of those is the reader leaving the newest line.
 */
export function stuckAfterScroll(el: HTMLElement, stuck: boolean, nearPx: number): boolean {
  if (el.scrollHeight - el.scrollTop - el.clientHeight <= nearPx) return true;
  if (!state.height) return false;
  const hand = handled.get(el);
  if (!hand) return false;
  return hand.touching || performance.now() - hand.at < HAND_MS ? false : stuck;
}
