import { RiArrowLeftSLine } from '@remixicon/react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { buttonClassName } from '@/shared-components/Button';
import { cn } from '@/utils/cn';

interface PageFrameProps {
  /** Without one (and without `aside`) there is no title row at all: home is just the cards. */
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

/** The page's title row and its width. Who you are is not here: the sidebar is mounted once by the router's Shell, beside this column. */
export function PageFrame({ title, titleId, aside, wide = false, children }: PageFrameProps) {
  return (
    <main className={cn('mx-auto px-5 pb-10 pt-16', wide ? 'max-w-[1360px]' : 'max-w-[960px]')}>
      {(title || aside) && (
        <header className="mb-6 flex flex-wrap items-center justify-between gap-4 border-b border-primaryStroke pb-4">
          <div className="flex min-w-0 items-center gap-4">
            {title && <HomeLink />}
            {title && (
              <h1 id={titleId} className="min-w-0 border-l-4 border-primaryBlue pl-3 text-[28px] font-semibold leading-tight [overflow-wrap:anywhere]">
                {title}
              </h1>
            )}
          </div>
          {aside && <div className="ml-auto max-w-full shrink-0">{aside}</div>}
        </header>
      )}
      {children}
    </main>
  );
}
