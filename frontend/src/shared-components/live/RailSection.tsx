import type { ReactNode } from 'react';

import { RAIL_WORDS, type RailSection as Section } from '@/infra/live-dock';
import { cn } from '@/utils/cn';

interface RailSectionProps {
  section: Section;
  id: string;
  title?: ReactNode;
  aside?: ReactNode;
  top?: ReactNode;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}

export function RailSection({ section, id, title, aside, top, className, bodyClassName, children }: RailSectionProps) {
  return (
    <section
      id={id}
      data-rail-section={section}
      aria-labelledby={title ? `${id}-title` : undefined}
      aria-label={title ? undefined : RAIL_WORDS[section]}
      className={cn('flex flex-col', className)}
    >
      {title && (
        <h2 className="flex min-h-6 flex-wrap items-center justify-between gap-x-2 gap-y-1.5 text-xs font-semibold uppercase tracking-wider text-textTertiary">
          <span id={`${id}-title`} className="min-w-0 truncate">
            {title}
          </span>
          {aside && <span className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-1.5">{aside}</span>}
        </h2>
      )}
      {top}
      <div id={`${id}-body`} className={bodyClassName}>
        {children}
      </div>
    </section>
  );
}
