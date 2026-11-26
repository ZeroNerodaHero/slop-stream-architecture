import { RiCloseLine, RiDraggable, RiRefreshLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react';

import { DOCK_WORDS, liveEditingAtom, type ModuleId, type Place, setHidden } from '@/infra/live-dock';
import { Button } from '@/shared-components/Button';
import { panelClassName } from '@/shared-components/Panel';
import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

export const DOCK_IDS: Record<ModuleId, string> = {
  sources: 'sources-panel',
  face: 'face-panel',
  rig: 'rig',
  sound: 'mixer',
  chat: 'live-chat'
};

export const HEAD = 'flex h-9 shrink-0 items-center gap-1.5 border-b border-primaryStroke pl-3 pr-1 text-xs font-semibold uppercase tracking-wider text-textSecondary';

export const FOLD_BUTTON =
  'flex h-7 w-7 shrink-0 items-center justify-center rounded-control border border-primaryStroke bg-backgroundSecondary text-textSecondary transition-colors duration-150 hover:border-primaryBlue hover:text-primaryBlue focus-visible:border-primaryBlue focus-visible:text-primaryBlue focus-visible:outline-none';

const QUIET_BUTTON =
  'flex h-7 w-7 shrink-0 items-center justify-center rounded-control border border-transparent text-textTertiary transition-colors duration-150 hover:border-primaryBlue hover:text-primaryBlue focus-visible:border-primaryBlue focus-visible:text-primaryBlue focus-visible:outline-none';

interface DockPanelProps {
  tab: ModuleId;
  place: Place;
  count?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
}

const SECTION: Record<Exclude<Place, 'phone'>, string> = {
  column: 'shrink-0',
  row: 'h-full min-h-0',
  under: 'min-h-0 flex-1',
  side: 'h-full min-h-0',
  tile: 'h-full min-h-0'
};

export function DockPanel({ tab, place, count, aside, children }: DockPanelProps) {
  const id = DOCK_IDS[tab];
  const editing = useAtomValue(liveEditingAtom) && place === 'tile';
  const word = DOCK_WORDS[tab];
  if (place === 'phone')
    return (
      <div id={id} data-tab={tab} data-place={place} className={cn('min-w-0', tab === 'chat' && 'flex h-full min-h-0 flex-col')}>
        {children}
      </div>
    );
  const fill = place !== 'column';
  return (
    <section
      id={id}
      data-tab={tab}
      data-place={place}
      aria-labelledby={`${id}-title`}
      className={panelClassName(
        cn('flex min-w-0 flex-col overflow-hidden', SECTION[place], editing && 'border-dashed border-primaryBlue/70 bubble:border-primaryBlue/70')
      )}
    >
      <h2 className={HEAD}>
        {editing && (
          <Tooltip content="drag to move. arrows move it, shift and arrows size it" hideOnPress>
            <button
              id={`${id}-grip`}
              type="button"
              data-grip={tab}
              aria-label={`move ${word}`}
              aria-roledescription="drag handle"
              className="-ml-2 flex h-7 w-5 shrink-0 cursor-grab touch-none items-center justify-center text-textTertiary hover:text-textPrimary focus-visible:text-primaryBlue focus-visible:outline-none active:cursor-grabbing"
            >
              <RiDraggable aria-hidden size={16} />
            </button>
          </Tooltip>
        )}
        <span id={`${id}-title`} className="min-w-0 truncate">
          {word}
        </span>
        {count !== undefined && <span className="shrink-0 font-normal normal-case tracking-normal text-textTertiary">{count}</span>}
        <span className="flex-1" />
        {aside}
        {editing && (
          <Tooltip content={`close the ${word}`}>
            <button id={`${id}-close`} type="button" aria-label={`close the ${word}`} onClick={() => setHidden(tab, true)} className={QUIET_BUTTON}>
              <RiCloseLine aria-hidden size={16} />
            </button>
          </Tooltip>
        )}
      </h2>
      <div id={`${id}-body`} className={cn('grid grid-rows-[1fr]', fill && 'min-h-0 flex-1')}>
        <div className="min-h-0 overflow-hidden">
          <div className={cn(fill && 'h-full overflow-y-auto overscroll-contain', tab === 'chat' && 'flex h-full flex-col overflow-hidden')}>{children}</div>
        </div>
      </div>
    </section>
  );
}

interface BoundaryProps {
  id: string;
  name: string;
  small?: boolean;
  children: ReactNode;
}

interface BoundaryState {
  error: Error | null;
  round: number;
}

export class ModuleBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null, round: 0 };

  static getDerivedStateFromError(error: Error): Partial<BoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`the ${this.props.name} panel stopped`, error, info.componentStack);
  }

  reload = () => this.setState((s) => ({ error: null, round: s.round + 1 }));

  render() {
    const { id, name, small, children } = this.props;
    if (!this.state.error) return <Fragment key={this.state.round}>{children}</Fragment>;
    if (small)
      return (
        <Tooltip content={`the ${name} stopped. reload it`}>
          <button id={`live-reload-${id}`} data-crashed={id} type="button" aria-label={`reload the ${name}`} onClick={this.reload} className={cn(FOLD_BUTTON, 'border-decrease text-decrease')}>
            <RiRefreshLine aria-hidden size={16} />
          </button>
        </Tooltip>
      );
    return (
      <section id={`live-crash-${id}`} data-crashed={id} role="alert" className={panelClassName('flex shrink-0 flex-col items-start gap-2 px-3 py-2.5 text-sm')}>
        <p className="text-textSecondary">the {name} stopped working</p>
        <Button id={`live-reload-${id}`} size="sm" variant="outline" className="gap-1.5" onClick={this.reload}>
          <RiRefreshLine aria-hidden size={16} />
          reload panel
        </Button>
      </section>
    );
  }
}
