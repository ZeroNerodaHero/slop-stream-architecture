import type { ReactNode } from 'react';

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

/** The page's title row and its width. Who you are is not here: UserPanel sits in the corner, mounted once by the router's Shell. */
export function PageFrame({ title, titleId, aside, wide = false, children }: PageFrameProps) {
  return (
    // the bottom padding is room for the corner panel, so the end of a page can scroll out from under it
    <main className={cn('mx-auto px-5 pb-28 pt-6', wide ? 'max-w-[1360px]' : 'max-w-[960px]')}>
      {(title || aside) && (
        <header className="mb-6 flex flex-wrap items-center justify-between gap-4 border-b border-primaryStroke pb-4">
          {title && (
            <h1 id={titleId} className="min-w-0 border-l-4 border-primaryBlue pl-3 text-[28px] font-semibold leading-tight [overflow-wrap:anywhere]">
              {title}
            </h1>
          )}
          {aside && <div className="flex flex-wrap items-center gap-4">{aside}</div>}
        </header>
      )}
      {children}
    </main>
  );
}
