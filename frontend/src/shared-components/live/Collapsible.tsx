import { RiArrowDownSLine, RiArrowRightSLine } from '@remixicon/react';
import type { ReactNode } from 'react';

import { panelClassName } from '@/shared-components/Panel';
import { cn } from '@/utils/cn';

const HEAD =
  'flex h-8 min-w-0 flex-1 items-center gap-1.5 px-2 text-xs font-semibold uppercase tracking-wider text-textTertiary transition-colors duration-150 hover:text-textPrimary focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-primaryBlue';

interface CollapsibleProps {
  id: string;
  title: string;
  open: boolean;
  onToggle: () => void;
  aside?: ReactNode;
  footer?: ReactNode;
  className?: string;
  children: ReactNode;
}

export function Collapsible({ id, title, open, onToggle, aside, footer, className, children }: CollapsibleProps) {
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
  'flex h-7 w-7 shrink-0 items-center justify-center border border-transparent text-textTertiary transition-colors duration-150 hover:border-primaryBlue hover:text-primaryBlue focus-visible:border-primaryBlue focus-visible:outline-none disabled:cursor-default disabled:opacity-40 disabled:hover:border-transparent disabled:hover:text-textTertiary';
