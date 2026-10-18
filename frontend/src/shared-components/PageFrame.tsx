import type { ReactNode } from 'react';

interface PageFrameProps {
  title: ReactNode;
  titleId?: string;
  aside?: ReactNode;
  children: ReactNode;
}

export function PageFrame({ title, titleId, aside, children }: PageFrameProps) {
  return (
    <main className="mx-auto max-w-[960px] px-5 pb-16 pt-6">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <h1 id={titleId} className="min-w-0 text-[28px] font-semibold [overflow-wrap:anywhere]">
          {title}
        </h1>
        {aside}
      </header>
      {children}
    </main>
  );
}
