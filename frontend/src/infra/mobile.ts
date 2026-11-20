import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
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
 * visual viewport's own pans are `useVisibleViewport(on, true)`'s). `keepPlace`: for a sheet over
 * a page that scrolls (the auth dialog), the page stays drawn where it was scrolled to while
 * pinned, and is scrolled back there after.
 */
export function useLockedDocument(on: boolean, keepPlace = false) {
  useEffect(() => {
    if (!on) return;
    const x = window.scrollX;
    const y = window.scrollY;
    const restores = [document.documentElement, document.body].map((el) => {
      const { overflow, overscrollBehavior, position, inset, width } = el.style;
      el.style.overflow = 'hidden';
      el.style.overscrollBehavior = 'none';
      el.style.position = 'fixed';
      el.style.inset = '0';
      el.style.width = '100%';
      return () => Object.assign(el.style, { overflow, overscrollBehavior, position, inset, width });
    });
    // the body is drawn up by what had been scrolled; `inset` is restored above, which puts these back
    if (keepPlace) {
      document.body.style.top = `${-y}px`;
      document.body.style.left = `${-x}px`;
    }
    const top = () => {
      if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
    };
    // now, the next frame, and again once iOS has run its own scroll to the box (100 to 300ms later)
    let frame = 0;
    let later: number[] = [];
    const focused = () => {
      top();
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(top);
      later.forEach(clearTimeout);
      later = [100, 300].map((ms) => window.setTimeout(top, ms));
    };
    document.addEventListener('focusin', focused);
    return () => {
      document.removeEventListener('focusin', focused);
      cancelAnimationFrame(frame);
      later.forEach(clearTimeout);
      restores.forEach((restore) => restore());
      if (keepPlace) window.scrollTo(x, y);
    };
  }, [on, keepPlace]);
}

/** The stream chat's box (ChatPanel.tsx): its focus is what makes a phone's player a strip. */
const CHAT_TEXT = 'chat-text';

/** How long a blur waits before the player grows back: a tap on send blurs and refocuses within it. */
const BLUR_GRACE_MS = 150;

/**
 * Someone is typing in the stream's chat on a phone page that is the window (WatchPage.tsx,
 * LivePage.tsx): `#chat-text` has the focus. The focus, not the visual viewport, is the sign: iOS
 * Safari often pans the page (`offsetTop`) instead of shrinking it, and its `innerHeight` follows
 * the visual viewport, so no height gap says the keyboard is up. A blur waits `BLUR_GRACE_MS`, so
 * a tap on send does not flicker the player. `keyboard` is `useVisibleViewport`'s: where the
 * browser does shrink the window (Android), the keyboard going while the box keeps its focus (the
 * back button) blurs the box, so the player comes back with it.
 */
export function useChatTyping(on: boolean, keyboard: boolean): boolean {
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    if (!on) return;
    let timer = 0;
    const now = () => document.activeElement?.id === CHAT_TEXT;
    const focusin = () => {
      clearTimeout(timer);
      if (now()) setTyping(true);
    };
    const focusout = () => {
      clearTimeout(timer);
      timer = window.setTimeout(() => setTyping(now()), BLUR_GRACE_MS);
    };
    setTyping(now());
    document.addEventListener('focusin', focusin);
    document.addEventListener('focusout', focusout);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('focusin', focusin);
      document.removeEventListener('focusout', focusout);
      setTyping(false);
    };
  }, [on]);
  const hadKeyboard = useRef(false);
  useEffect(() => {
    if (hadKeyboard.current && !keyboard && document.activeElement?.id === CHAT_TEXT) (document.activeElement as HTMLElement).blur();
    hadKeyboard.current = keyboard;
  }, [keyboard]);
  return on && typing;
}

/** How the pinned player's box eases between its full 16:9 and the strip (`keyboardStrip`). */
const STRIP_EASE = 'duration-200 ease-out motion-reduce:transition-none';

/** The phone page's width: the window less the side safe areas the page's root pads. */
const PAGE_WIDTH = '(100vw - env(safe-area-inset-left) - env(safe-area-inset-right))';

/** How tall the strip is against the full 16:9 box, and so how far the frame scales down into it. */
const STRIP_SCALE = 0.4;

/**
 * The pinned player of a phone page that is the window (WatchPage.tsx, LivePage.tsx) while its chat
 * is typed in (`useChatTyping`): its box eases from the full 16:9 of the width to a strip 40% as
 * tall, and back on the blur, so the chat under it (flex-1) has the height. The box has an explicit
 * height (an aspect ratio would not shrink). The frame inside scales down with it from its top
 * middle, video, canvas and pictures as one, so the strip shows the whole 16:9 picture, centred on
 * black, nothing cropped, and the video is never remounted and plays on. `style` and `box` go on the
 * box, `frame` on the frame, `overlay` on what sits over the picture (the stats chip, the controls
 * bar): faded out and untouchable while a strip, since they would cover all of it.
 */
export function keyboardStrip(strip: boolean) {
  return {
    style: { height: `calc(${PAGE_WIDTH} * 9 / 16 * ${strip ? STRIP_SCALE : 1})` },
    box: `overflow-hidden bg-black transition-[height] ${STRIP_EASE}`,
    frame: cn(`origin-top transition-transform ${STRIP_EASE}`, strip && 'scale-[0.4]'),
    overlay: cn('transition-[opacity,transform,visibility] delay-0 duration-200 motion-reduce:transition-none', strip && 'pointer-events-none invisible opacity-0')
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
