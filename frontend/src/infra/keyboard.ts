import { type PointerEvent as ReactPointerEvent, type RefObject, useEffect, useSyncExternalStore } from 'react';

import { MOBILE_QUERY } from '@/infra/mobile';

const KEYBOARD_GAP = 120;
export const BLUR_GRACE_MS = 150;
const TAP_SLOP = 10;
const KEEP = 12;

export type Keyboard = {
  height: number;
  top: number;
  bottom: number;
  keyboard: boolean;
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

export function useKeyboard(): Keyboard {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => IDLE
  );
}

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
    if (was.y && was.path === location.pathname) window.scrollTo(0, was.y);
  }
}

let pages = 0;
export function usePinnedPage(on: boolean) {
  useEffect(() => {
    if (!on) return;
    const by = `page${++pages}`;
    hold(by);
    return () => release(by);
  }, [on]);
}

export function useTypingIn(id: string): boolean {
  return useKeyboard().focused?.id === id;
}

const NOT_TYPED = new Set(['checkbox', 'radio', 'range', 'file', 'color', 'button', 'submit', 'reset', 'image', 'hidden']);

function typedIn(el: Element | null): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled;
  if (el instanceof HTMLInputElement) return !NOT_TYPED.has(el.type) && !el.readOnly && !el.disabled;
  return false;
}

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

  let tap: { x: number; y: number; on: EventTarget | null } | null = null;
  const touchstart = (e: TouchEvent) => {
    const t = e.touches[0];
    tap = e.touches.length === 1 && t ? { x: t.clientX, y: t.clientY, on: e.target } : null;
  };
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

function canScroll(from: EventTarget | null, dy: number): boolean {
  for (let at = from instanceof Element ? from : null; at && at !== document.body && at !== document.documentElement; at = at.parentElement) {
    if (!(at instanceof HTMLElement) || at.scrollHeight <= at.clientHeight) continue;
    const { overflowY } = getComputedStyle(at);
    if (overflowY !== 'auto' && overflowY !== 'scroll') continue;
    if (dy > 0 ? at.scrollTop > 0 : at.scrollTop + at.clientHeight < at.scrollHeight - 1) return true;
  }
  return false;
}

function scroller(el: HTMLElement): HTMLElement | null {
  for (let at = el.parentElement; at && at !== document.body && at !== document.documentElement; at = at.parentElement) {
    const { overflowY } = getComputedStyle(at);
    if ((overflowY === 'auto' || overflowY === 'scroll') && at.scrollHeight > at.clientHeight) return at;
  }
  return null;
}

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
  if (at.top - by < lo) by = at.top - lo;
  if (by) pane.scrollTop += by;
}

export function keepFocus(e: ReactPointerEvent) {
  if (e.pointerType !== 'mouse' && typedIn(document.activeElement)) e.preventDefault();
}

const handled = new WeakMap<HTMLElement, { touching: boolean; at: number }>();
const HAND_MS = 250;

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

export function stuckAfterScroll(el: HTMLElement, stuck: boolean, nearPx: number): boolean {
  if (el.scrollHeight - el.scrollTop - el.clientHeight <= nearPx) return true;
  if (!state.height) return false;
  const hand = handled.get(el);
  if (!hand) return false;
  return hand.touching || performance.now() - hand.at < HAND_MS ? false : stuck;
}
