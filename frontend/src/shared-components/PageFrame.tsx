import { RiArrowLeftSLine, RiSettings3Line } from '@remixicon/react';
import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';

import { openUserModal } from '@/infra/atoms/user-modal-atoms';
import { buttonClassName } from '@/shared-components/Button';
import { cn } from '@/utils/cn';

interface PageFrameProps {
  /** Without one (and without `aside`) the row is just go live and settings: home is the cards. */
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
    <Link id="home" to="/" reloadDocument={reload || undefined} className={buttonClassName('secondary', 'shrink-0 gap-1 px-3 py-1.5 text-sm', true)}>
      <RiArrowLeftSLine aria-hidden size={18} />
    </Link>
  );
}

/**
 * Go live and the settings icon, at the right end of every page's title row. Go live is absent on
 * its own page. The icon opens the user modal on settings. Search is the sidebar's (Friends.tsx).
 * Both are flat: they sit in a bar over the page, and a shadow there read as one more box.
 */
function TopActions() {
  const { pathname } = useLocation();
  const onLivePage = pathname.replace(/\/$/, '') === '/live';
  return (
    <div className="ml-auto flex shrink-0 items-center gap-2">
      {!onLivePage && (
        <Link id="go-live" to="/live" className={buttonClassName('primary', 'px-3 py-2 text-sm', true)}>
          go live
        </Link>
      )}
      <button
        id="settings"
        type="button"
        aria-label="settings"
        title="settings"
        onClick={() => openUserModal('settings')}
        className={buttonClassName('secondary', 'px-2 py-2', true)}
      >
        <RiSettings3Line aria-hidden size={18} />
      </button>
    </div>
  );
}

/**
 * The page's title row and its width. One row: back and the title on the left, go live and the
 * settings icon on the right. Sticky: the row stays at the top of the window while the page
 * scrolls under it (the page's own colour, so what scrolls under is hidden), and globals.css keeps
 * scrolled-to things from landing under its first 4rem. Who you are is not here: the sidebar is
 * mounted once by the router's Shell, beside this column.
 */
export function PageFrame({ title, titleId, aside, wide = false, children }: PageFrameProps) {
  const titled = Boolean(title || aside);
  return (
    <main className={cn('mx-auto px-5 pb-10', wide ? 'max-w-[1360px]' : 'max-w-[960px]')}>
      <header className={cn('sticky top-0 z-30 flex min-h-16 flex-wrap items-center gap-4 bg-background py-3', titled && 'mb-6 border-b border-primaryStroke')}>
        {title && (
          <div className="flex min-w-0 items-center gap-4">
            <HomeLink />
            <h1 id={titleId} className="min-w-0 border-l-4 border-primaryBlue pl-3 text-[28px] font-semibold leading-tight [overflow-wrap:anywhere]">
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
