import { RiArrowLeftSLine } from '@remixicon/react';
import { type ReactNode, useLayoutEffect, useRef } from 'react';
import { Link, useLocation } from 'react-router-dom';

import { buttonClassName } from '@/shared-components/Button';
import { NotificationsBell } from '@/shared-components/Notifications';
import { cn } from '@/utils/cn';

interface PageFrameProps {
  /** Without one (and without `aside`) the row is just the bell and go live, and the page starts at its top: home, whose part headings stand in it. */
  title?: ReactNode;
  titleId?: string;
  aside?: ReactNode;
  /** Room for a side panel next to the video. */
  wide?: boolean;
  children: ReactNode;
}

/**
 * Back to the stream list, to the left of a page's title: a caret and the word.
 * A crash reloads the document, because the router may be what broke.
 * The tests click `header a[href="/"]`.
 */
export function HomeLink({ reload = false }: { reload?: boolean }) {
  return (
    <Link id="home" to="/" reloadDocument={reload || undefined} className={buttonClassName('secondary', 'shrink-0 gap-1 px-3 py-1.5 text-sm')}>
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
        <Link id="go-live" to="/live" className={buttonClassName('primary', 'px-3 py-2 text-sm')}>
          go live
        </Link>
      )}
    </div>
  );
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
 */
export function PageFrame({ title, titleId, aside, wide = false, children }: PageFrameProps) {
  const titled = Boolean(title || aside);
  const headerRef = useRef<HTMLElement | null>(null);

  // the row's height, read rather than assumed: once before the first paint (a layout effect,
  // so a page's own landing scroll already sees it), then on every change of its size (the
  // title wrapping or not as the window or the text size changes). gone with the row
  useLayoutEffect(() => {
    const header = headerRef.current;
    if (!titled || !header) return;
    const root = document.documentElement;
    const measure = () => root.style.setProperty('--title-row', `${header.getBoundingClientRect().height}px`);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    return () => {
      observer.disconnect();
      root.style.removeProperty('--title-row');
    };
  }, [titled]);

  return (
    <main className={cn('mx-auto px-5 pb-10', wide ? 'max-w-[1360px]' : 'max-w-[960px]')}>
      <header
        ref={headerRef}
        className={cn('sticky top-0 z-30 flex items-center gap-4 bg-background py-3', titled ? 'mb-6 min-h-16 flex-wrap border-b border-primaryStroke' : 'h-16 -mb-16')}
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
