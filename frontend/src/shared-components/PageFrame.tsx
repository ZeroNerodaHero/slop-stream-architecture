import type { ReactNode } from 'react';

import { UserBar } from '@/shared-components/UserBar';
import { cn } from '@/utils/cn';

interface PageFrameProps {
  title: ReactNode;
  titleId?: string;
  aside?: ReactNode;
  /** Room for a side panel next to the video. */
  wide?: boolean;
  children: ReactNode;
}

export function PageFrame({ title, titleId, aside, wide = false, children }: PageFrameProps) {
  return (
    <main className={cn('mx-auto px-5 pb-16 pt-6', wide ? 'max-w-[1360px]' : 'max-w-[960px]')}>
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <h1 id={titleId} className="min-w-0 text-[28px] font-semibold [overflow-wrap:anywhere]">
          {title}
        </h1>
        <div className="flex flex-wrap items-center gap-4">
          <UserBar />
          {aside}
        </div>
      </header>
      {children}
    </main>
  );
}
