import { useEffect, useState, useSyncExternalStore } from 'react';

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
 * (LivePage.tsx) and the chat sheet (FriendChat.tsx). null while off, or where the browser has
 * no `visualViewport` (the box then falls back to `dvh`).
 */
export function useVisibleViewport(on: boolean): VisibleViewport | null {
  const [view, setView] = useState<VisibleViewport | null>(null);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!on || !vv) return;
    const read = () => {
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
  }, [on]);
  return on ? view : null;
}
