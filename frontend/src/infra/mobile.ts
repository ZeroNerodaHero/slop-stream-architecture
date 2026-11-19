import { useEffect, useState, useSyncExternalStore } from 'react';
import { cn } from '@/utils/cn';

/**
 * A phone: narrower than tailwind's `md` (768px). Below it the sidebar and a group's side columns
 * are drawers (SwipeDrawer.tsx); at it and above, the page is the desktop's, untouched. Classes
 * say the same with `max-md:` / `md:`; this is for the places that render something else.
 */
export const MOBILE_QUERY = '(max-width: 767.98px)';

function subscribe(changed: () => void): () => void {
  const list = window.matchMedia(MOBILE_QUERY);
  list.addEventListener('change', changed);
  return () => list.removeEventListener('change', changed);
}

/** Whether the window is a phone's width now, and again whenever it crosses the line. */
export function useIsMobile(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(MOBILE_QUERY).matches,
    () => false
  );
}

/** The window is this much shorter than the layout's, or more: the on-screen keyboard is what is under it. */
const KEYBOARD_GAP = 120;

/** What a phone's on-screen keyboard leaves of the window (`useVisibleViewport`). */
export type VisibleViewport = {
  /** How tall the visible part is. */
  height: number;
  /** How far the browser has panned the page down to keep a focused box in sight. */
  top: number;
  /** How far up from the layout viewport's foot the visible part ends: the keyboard's height, 0 without one. */
  bottom: number;
  /** The keyboard is up. */
  keyboard: boolean;
};

/**
 * The part of the window the on-screen keyboard leaves, from the visual viewport, kept as it
 * resizes and pans. The one hook for every phone box that sits on the keyboard: the /live page
 * (LivePage.tsx), the watch page (WatchPage.tsx) and the chat sheet (FriendChat.tsx). null while off, or where the browser has
 * no `visualViewport` (the box then falls back to `dvh`). `pinned`: the page is the window
 * (`useLockedDocument`), so any scroll iOS applies to bring a focused box into sight is put back
 * to the top first, and the box stays where it is while only what the keyboard leaves shrinks.
 */
export function useVisibleViewport(on: boolean, pinned = false): VisibleViewport | null {
  const [view, setView] = useState<VisibleViewport | null>(null);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!on || !vv) return;
    const read = () => {
      if (pinned && (window.scrollX || window.scrollY || vv.offsetTop)) window.scrollTo(0, 0);
      const height = Math.round(vv.height);
      const top = Math.round(vv.offsetTop);
      const bottom = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
      const keyboard = window.innerHeight - vv.height > KEYBOARD_GAP;
      setView((was) =>
        was && was.height === height && was.top === top && was.bottom === bottom && was.keyboard === keyboard ? was : { height, top, bottom, keyboard }
      );
    };
    read();
    vv.addEventListener('resize', read);
    vv.addEventListener('scroll', read);
    return () => {
      vv.removeEventListener('resize', read);
      vv.removeEventListener('scroll', read);
    };
  }, [on, pinned]);
  return on ? view : null;
}

/**
 * While on: the document does not scroll (nor bounce), so the page is the window and nothing else
 * moves. The go live page, the watch page and the chat sheet (FriendChat.tsx) on a phone. iOS scrolls a document that is only
 * `overflow: hidden` anyway to bring a focused box over the keyboard, so html and body are also
 * pinned (`position: fixed`, inset 0), and a focus puts back whatever scroll it applied (the
 * visual viewport's own pans are `useVisibleViewport(on, true)`'s).
 */
export function useLockedDocument(on: boolean) {
  useEffect(() => {
    if (!on) return;
    const restores = [document.documentElement, document.body].map((el) => {
      const { overflow, overscrollBehavior, position, inset, width } = el.style;
      el.style.overflow = 'hidden';
      el.style.overscrollBehavior = 'none';
      el.style.position = 'fixed';
      el.style.inset = '0';
      el.style.width = '100%';
      return () => Object.assign(el.style, { overflow, overscrollBehavior, position, inset, width });
    });
    let frame = 0;
    const top = () => {
      if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
    };
    // now, and again once iOS has run its own scroll to the box
    const focused = () => {
      top();
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(top);
    };
    document.addEventListener('focusin', focused);
    return () => {
      document.removeEventListener('focusin', focused);
      cancelAnimationFrame(frame);
      restores.forEach((restore) => restore());
    };
  }, [on]);
}

/** How the pinned player's box eases between its full 16:9 and the strip (`useKeyboardStrip`). */
const STRIP_EASE = 'duration-200 ease-out motion-reduce:transition-none';

/**
 * The pinned player of a phone page that is the window (WatchPage.tsx, LivePage.tsx) while the
 * keyboard is up: its box eases from the full 16:9 of its width to a strip a third as tall, and
 * back once the keyboard goes, so the chat under it (flex-1) has the height while typing. Only the
 * box's height moves: the frame inside keeps its 16:9 and is scaled down to fit the strip, whole,
 * so the video is never remounted and plays on. `ref`, `style` and `box` go on the box, `frame`
 * on the frame. The height is px from the measured width (a height in px is what eases).
 */
export function useKeyboardStrip(strip: boolean) {
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!box) return;
    const seen = new ResizeObserver(() => setWidth(box.clientWidth));
    seen.observe(box);
    return () => seen.disconnect();
  }, [box]);
  const full = (width * 9) / 16;
  return {
    ref: setBox,
    // until it is measured the box is as tall as the frame in it
    style: width ? { height: strip ? full / 3 : full } : undefined,
    box: `overflow-hidden transition-[height] ${STRIP_EASE}`,
    frame: cn(`origin-top transition-transform ${STRIP_EASE}`, strip && 'scale-[0.3333]')
  };
}

/**
 * The stream's chat on a phone page that is the window (LivePage.tsx, WatchPage.tsx): edge to
 * edge in its tab, no box, no least height (the tab is what is left of the window, less with the
 * keyboard up), and the send row's padding is the safe area at the foot, but not while the
 * keyboard covers that edge (ServerRoom.tsx's room does the same). The page's root is
 * `group/phone`, with `data-keyboard` from `useVisibleViewport`.
 */
export const CHAT_MOBILE =
  'min-h-0 border-0 bg-background [&>header]:px-3 [&_#chat-lines]:px-3 [&>footer]:px-3 [&>footer]:pt-2 [&>footer]:pb-[calc(0.5rem+env(safe-area-inset-bottom))] group-data-[keyboard=true]/phone:[&>footer]:pb-2';
