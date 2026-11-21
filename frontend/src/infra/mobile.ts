import { useSyncExternalStore } from 'react';
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

/** How the pinned player's box eases between its full 16:9 and the strip (`keyboardStrip`). */
const STRIP_EASE = 'duration-200 ease-out motion-reduce:transition-none';

/** The phone page's width: the window less the side safe areas the page's root pads. */
const PAGE_WIDTH = '(100vw - env(safe-area-inset-left) - env(safe-area-inset-right))';

/** How tall the strip is against the full 16:9 box, and so how far the frame scales down into it. */
const STRIP_SCALE = 0.4;

/**
 * The pinned player of a phone page that is the window (WatchPage.tsx, LivePage.tsx) while its chat
 * is typed in (`useTypingIn('chat-text')`, keyboard.ts): its box eases from the full 16:9 of the width to a strip 40% as
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
 * `group/phone`, with `data-keyboard` from `useKeyboard` (keyboard.ts).
 */
export const CHAT_MOBILE =
  'min-h-0 border-0 bg-background [&>header]:px-3 [&_#chat-lines]:px-3 [&>footer]:px-3 [&>footer]:pt-2 [&>footer]:pb-[calc(0.5rem+env(safe-area-inset-bottom))] group-data-[keyboard=true]/phone:[&>footer]:pb-2';
