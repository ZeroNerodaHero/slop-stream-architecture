import { RiArrowDownSLine, RiArrowUpSLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import type { ReactNode } from 'react';

import { liveRailFoldsAtom, RAIL_WORDS, type RailSection as Section, setRailFold } from '@/infra/live-dock';
import { FOLD_BUTTON } from '@/shared-components/live/Dock';
import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

const FOLD = 'grid motion-safe:transition-[grid-template-rows] motion-safe:duration-150 motion-safe:ease-out motion-reduce:transition-none';

export function useRailFold(section: Section): boolean {
  return useAtomValue(liveRailFoldsAtom)[section];
}

interface RailFoldProps {
  section: Section;
  id: string;
  controls: string;
  className?: string;
}

export function RailFold({ section, id, controls, className }: RailFoldProps) {
  const open = useRailFold(section);
  const words = `${open ? 'fold' : 'open'} the ${RAIL_WORDS[section]}`;
  const Icon = open ? RiArrowUpSLine : RiArrowDownSLine;
  return (
    <Tooltip content={words}>
      <button
        id={id}
        type="button"
        data-rail-fold={section}
        aria-label={words}
        aria-expanded={open}
        aria-controls={controls}
        onClick={() => setRailFold(section, !open)}
        className={cn(FOLD_BUTTON, 'h-6 w-6 normal-case tracking-normal', className)}
      >
        <Icon aria-hidden size={16} />
      </button>
    </Tooltip>
  );
}

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
  const open = useRailFold(section);
  return (
    <section
      id={id}
      data-rail-section={section}
      data-open={open}
      aria-labelledby={title ? `${id}-title` : undefined}
      aria-label={title ? undefined : RAIL_WORDS[section]}
      className={cn('flex flex-col', className)}
    >
      {title && (
        <h2 className="flex h-6 items-center justify-between gap-2 text-xs font-semibold uppercase tracking-wider text-textTertiary">
          <span id={`${id}-title`} className="min-w-0 truncate">
            {title}
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            {aside}
            <RailFold section={section} id={`${id}-toggle`} controls={`${id}-body`} />
          </span>
        </h2>
      )}
      {top}
      <div id={`${id}-body`} inert={!open ? true : undefined} className={cn(FOLD, open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]')}>
        <div className="min-h-0 overflow-hidden">
          <div className={bodyClassName}>{children}</div>
        </div>
      </div>
    </section>
  );
}
