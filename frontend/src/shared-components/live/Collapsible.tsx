import { RiArrowDownSLine, RiArrowLeftSLine, RiArrowRightSLine } from '@remixicon/react';
import type { ReactNode } from 'react';

import { panelClassName } from '@/shared-components/Panel';
import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

const HEAD =
  'flex h-8 min-w-0 flex-1 items-center gap-1.5 px-2 text-xs font-semibold uppercase tracking-wider text-textTertiary transition-colors duration-150 hover:text-textPrimary focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-primaryBlue';

const SIDE_BUTTON =
  'flex h-7 w-7 shrink-0 items-center justify-center rounded-control border border-transparent text-textTertiary transition-colors duration-150 hover:border-primaryBlue hover:text-primaryBlue focus-visible:border-primaryBlue focus-visible:text-primaryBlue focus-visible:outline-none';

interface CollapsibleProps {
  id: string;
  title: string;
  what?: string;
  open: boolean;
  onToggle: () => void;
  aside?: ReactNode;
  footer?: ReactNode;
  className?: string;
  sideways?: boolean;
  strip?: ReactNode;
  children: ReactNode;
}

export function Collapsible({ id, title, what = title, open, onToggle, aside, footer, className, sideways = false, strip, children }: CollapsibleProps) {
  if (sideways) {
    const words = open ? `fold the ${what}` : `open the ${what}`;
    const toggle = (
      <Tooltip content={words} at={open ? undefined : 'left'}>
        <button id={`${id}-toggle`} type="button" aria-label={words} aria-expanded={open} aria-controls={`${id}-body`} onClick={onToggle} className={SIDE_BUTTON}>
          {open ? <RiArrowRightSLine aria-hidden size={16} /> : <RiArrowLeftSLine aria-hidden size={16} />}
        </button>
      </Tooltip>
    );
    return (
      <section id={id} data-open={open} aria-label={title} className={cn(panelClassName('flex min-h-0 flex-col overflow-hidden'), open ? className : 'w-10 shrink-0 items-center')}>
        {open ? (
          <h2 className="flex h-9 shrink-0 items-center gap-1.5 pl-3 pr-1 text-xs font-semibold uppercase tracking-wider text-textTertiary">
            <span className="min-w-0 flex-1 truncate">{title}</span>
            {aside}
            {toggle}
          </h2>
        ) : (
          <div className="flex h-9 shrink-0 items-center justify-center">{toggle}</div>
        )}
        <div id={`${id}-body`} className={cn('flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden overscroll-contain', !open && 'w-full items-center')}>
          {open ? children : strip}
        </div>
        {open && footer}
      </section>
    );
  }
  return (
    <section id={id} className={cn(panelClassName('flex min-h-0 flex-col'), className)}>
      <h2 className={cn('flex items-center', open && 'border-b border-primaryStroke')}>
        <button id={`${id}-toggle`} type="button" aria-expanded={open} aria-controls={`${id}-body`} onClick={onToggle} className={HEAD}>
          {open ? <RiArrowDownSLine aria-hidden size={18} /> : <RiArrowRightSLine aria-hidden size={18} />}
          <span className="truncate">{title}</span>
        </button>
        {aside}
      </h2>
      {open && (
        <div id={`${id}-body`} className="flex min-h-0 flex-col">
          {children}
        </div>
      )}
      {footer && <div className="border-t border-primaryStroke">{footer}</div>}
    </section>
  );
}

export const ICON_BUTTON =
  'flex h-7 w-7 shrink-0 items-center justify-center rounded-control border border-transparent text-textTertiary transition-colors duration-150 hover:border-primaryBlue hover:text-primaryBlue focus-visible:border-primaryBlue focus-visible:outline-none disabled:cursor-default disabled:opacity-40 disabled:hover:border-transparent disabled:hover:text-textTertiary';
