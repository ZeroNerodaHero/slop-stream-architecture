import { RiArrowLeftSLine } from '@remixicon/react';
import { type ReactNode, type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';

import { useIsMobile } from '@/infra/mobile';
import { buttonClassName } from '@/shared-components/Button';
import { NotificationsBell } from '@/shared-components/Notifications';
import { DrawerOpener } from '@/shared-components/UserPanel';
import { cn } from '@/utils/cn';

interface PageFrameProps {
  /** Without one (and without `aside`) the row is just the bell and go live, and the page starts at its top: home, whose part headings stand in it. */
  title?: ReactNode;
  titleId?: string;
  aside?: ReactNode;
  /** Room for a side panel next to the video. */
  wide?: boolean;
  /** On a phone, the title in the row instead of `title`, which may be too much for one line: a stream's name, a group's channel. */
  mobileTitle?: ReactNode;
  /** On a phone, the right end of the row instead of the bell and go live: a group's button for its drawer (ServerRoom.tsx). */
  mobileEnd?: ReactNode;
  children: ReactNode;
}

/**
 * Back to the stream list, to the left of a page's title: a caret alone, named `home` for
 * screen readers and for nobody else. The one icon without a tooltip (tooltips.mdc): the row
 * is pinned to the window's top edge, so above the caret there is no room for one, and under
 * it is the page. A crash reloads the document, because the router may be what broke. The
 * tests click `header a[href="/"]`.
 */
export function HomeLink({ reload = false, className }: { reload?: boolean; className?: string }) {
  return (
    <Link id="home" to="/" aria-label="home" reloadDocument={reload || undefined} className={buttonClassName('secondary', cn('shrink-0 gap-1 px-3 py-1.5 text-sm', className))}>
      <RiArrowLeftSLine aria-hidden size={18} />
    </Link>
  );
}

/**
 * The right end of every page's title row: the notifications bell (Notifications.tsx, the
 * inbox opens under it), then go live, absent on its own page. Search is the sidebar's
 * (Friends.tsx), and so is the settings gear, at the far end of your line in it (UserPanel.tsx).
 */
function TopActions() {
  const { pathname } = useLocation();
  const onLivePage = pathname.replace(/\/$/, '') === '/live';
  return (
    <div className="ml-auto flex shrink-0 items-center gap-2">
      <NotificationsBell />
      {!onLivePage && (
        <Link id="go-live" to="/live" className={buttonClassName('primary', 'px-3 py-2 text-sm max-md:h-11')}>
          go live
        </Link>
      )}
    </div>
  );
}

/**
 * The part of an untitled page (home) the reader is in, for a phone's row to say: the
 * `data-title` of the last `<section>` of the page whose top has reached the row's foot, the
 * first one's before any has. Read again on a scroll, a resize, and a part coming or going
 * (following, once who you follow is known). null while off, or with no parts.
 */
function useCurrentPart(on: boolean, main: RefObject<HTMLElement | null>, row: RefObject<HTMLElement | null>): string | null {
  const [part, setPart] = useState<string | null>(null);
  useEffect(() => {
    const page = main.current;
    if (!on || !page) return;
    let frame = 0;
    const read = () => {
      frame = 0;
      const foot = row.current?.getBoundingClientRect().bottom ?? 0;
      let at: string | null = null;
      for (const section of page.querySelectorAll<HTMLElement>(':scope > section[data-title]')) {
        if (at !== null && section.getBoundingClientRect().top > foot + 1) break;
        at = section.dataset.title ?? null;
      }
      setPart(at);
    };
    const soon = () => {
      if (!frame) frame = window.requestAnimationFrame(read);
    };
    read();
    window.addEventListener('scroll', soon, { passive: true });
    window.addEventListener('resize', soon);
    const parts = new MutationObserver(soon);
    parts.observe(page, { childList: true });
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('scroll', soon);
      window.removeEventListener('resize', soon);
      parts.disconnect();
    };
  }, [on, main, row]);
  return on ? part : null;
}

/**
 * The page's title row and its width. One row: back and the title on the left, the bell and
 * go live on the right. Sticky: the row stays at the top of the window while the page scrolls
 * under it (the page's own colour, so what scrolls under is hidden). The row is 4rem, and more
 * when the title and the actions do not fit on one line (a phone, a tablet with a long title,
 * a laptop at a larger text size): its height is measured into `--title-row` on <html>, which
 * globals.css makes the page's `scroll-padding-top`, so scrolled-to things land under the row
 * and not behind it, and which the room page sizes itself by (ServerRoom.tsx). Without a title
 * (home) the row is the bell and go live alone, exactly 4rem (the variable is not set; 4rem is
 * its fallback), and the page starts at the row's top rather than under it: home's part
 * headings are sticky and 4rem tall too (HomePage.tsx), so the one for the part you are in
 * stands at the row's left end, and the next part's pushes it out. Who you are is not here:
 * the sidebar is mounted once by the router's Shell, beside this column.
 *
 * A phone's row is its own (below 768px, mobile.ts): the menu (the sidebar's drawer) at the left,
 * then where you are on one line, cut with an ellipsis when it is long: `mobileTitle` or the
 * title, or on home the part you have scrolled to (`useCurrentPart`), whose headings then scroll
 * with the page under the row. Then the bell and go live, or `mobileEnd`. Always measured into
 * `--title-row`, home's too: the page starts under it.
 */
export function PageFrame({ title, titleId, aside, wide = false, mobileTitle, mobileEnd, children }: PageFrameProps) {
  const titled = Boolean(title || aside);
  const mobile = useIsMobile();
  const mainRef = useRef<HTMLElement | null>(null);
  const headerRef = useRef<HTMLElement | null>(null);
  const part = useCurrentPart(mobile && !titled, mainRef, headerRef);

  // the row's height, read rather than assumed: once before the first paint (a layout effect,
  // so a page's own landing scroll already sees it), then on every change of its size (the
  // title wrapping or not as the window or the text size changes). gone with the row
  useLayoutEffect(() => {
    const header = headerRef.current;
    if (!(titled || mobile) || !header) return;
    const root = document.documentElement;
    const measure = () => root.style.setProperty('--title-row', `${header.getBoundingClientRect().height}px`);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    return () => {
      observer.disconnect();
      root.style.removeProperty('--title-row');
    };
  }, [titled, mobile]);

  const width = wide ? 'max-w-[1360px]' : 'max-w-[960px]';

  if (mobile) {
    const named = mobileTitle ?? title;
    const headed = mobileTitle !== undefined || title !== undefined;
    return (
      <main ref={mainRef} className={cn('mx-auto px-5 pb-10', width)}>
        {/* the buttons are 44px; the notch or the status bar is over them */}
        <header
          ref={headerRef}
          className={cn(
            'sticky top-0 z-30 flex min-h-[calc(4rem+env(safe-area-inset-top))] items-center gap-2 border-b border-primaryStroke bg-background pb-2.5 pt-[calc(0.625rem+env(safe-area-inset-top))]',
            titled && 'mb-6'
          )}
        >
          <DrawerOpener />
          {title && <HomeLink className="h-11 w-11 justify-center px-0" />}
          {headed ? (
            <h1 id={titleId} className="min-w-0 flex-1 truncate text-xl font-semibold leading-tight">
              {named}
            </h1>
          ) : (
            // home: the part's own heading is the page's, under the row. this says it again while that one is scrolled away
            <p aria-hidden className="min-w-0 flex-1 truncate text-xl font-semibold leading-tight">
              {part}
            </p>
          )}
          {aside && <div className="shrink-0">{aside}</div>}
          {mobileEnd ?? <TopActions />}
        </header>
        {children}
      </main>
    );
  }

  return (
    <main ref={mainRef} className={cn('mx-auto px-5 pb-10', width)}>
      <header
        ref={headerRef}
        className={cn(
          'sticky top-0 z-30 flex items-center gap-4 bg-background py-3',
          titled ? 'mb-6 min-h-16 flex-wrap border-b border-primaryStroke' : 'h-16 -mb-16'
        )}
      >
        {title && (
          <div className="flex min-w-0 items-center gap-4">
            <HomeLink />
            <h1 id={titleId} className="min-w-0 border-l-4 border-primaryBlue pl-3 text-[1.75rem] font-semibold leading-tight [overflow-wrap:anywhere]">
              {title}
            </h1>
          </div>
        )}
        {aside && <div className="max-w-full shrink-0">{aside}</div>}
        <TopActions />
      </header>
      {children}
    </main>
  );
}
