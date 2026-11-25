import { RiArrowDownSLine, RiArrowRightSLine, RiArrowUpSLine, RiCloseLine, RiDraggable, RiRefreshLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react';

import { DOCK_WORDS, liveEditingAtom, liveLockedAtom, livePanelsAtom, type ModuleId, type Place, setHidden, setLivePanel } from '@/infra/live-dock';
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

export const FOLD = 'grid motion-safe:transition-[grid-template-rows] motion-safe:duration-150 motion-safe:ease-out motion-reduce:transition-none';
export const FOLD_OPEN = 'grid-rows-[1fr]';
export const FOLD_SHUT = 'grid-rows-[0fr]';

export const HEAD = 'flex h-9 shrink-0 items-center gap-1.5 border-b border-primaryStroke pl-3 pr-1 text-xs font-semibold uppercase tracking-wider text-textSecondary';

export const FOLD_BUTTON =
  'flex h-7 w-7 shrink-0 items-center justify-center rounded-control border border-primaryStroke bg-backgroundSecondary text-textSecondary transition-colors duration-150 hover:border-primaryBlue hover:text-primaryBlue focus-visible:border-primaryBlue focus-visible:text-primaryBlue focus-visible:outline-none';

const QUIET_BUTTON =
  'flex h-7 w-7 shrink-0 items-center justify-center rounded-control border border-transparent text-textTertiary transition-colors duration-150 hover:border-primaryBlue hover:text-primaryBlue focus-visible:border-primaryBlue focus-visible:text-primaryBlue focus-visible:outline-none';

interface FoldButtonProps {
  id: string;
  open: boolean;
  controls: string;
  what: string;
  sideways?: boolean;
  onToggle: () => void;
}

export function FoldButton({ id, open, controls, what, sideways = false, onToggle }: FoldButtonProps) {
  const words = open ? `fold the ${what}` : `open the ${what}`;
  const Icon = sideways ? RiArrowRightSLine : open ? RiArrowUpSLine : RiArrowDownSLine;
  return (
    <Tooltip content={words}>
      <button id={id} type="button" aria-label={words} aria-expanded={open} aria-controls={controls} onClick={onToggle} className={QUIET_BUTTON}>
        <Icon aria-hidden size={16} />
      </button>
    </Tooltip>
  );
}

interface DockPanelProps {
  tab: ModuleId;
  place: Place;
  count?: ReactNode;
  aside?: ReactNode;
  strip?: ReactNode;
  open?: boolean;
  onToggle?: (open: boolean) => void;
  children: ReactNode;
}

const SECTION: Record<Exclude<Place, 'phone'>, (open: boolean) => string> = {
  column: () => 'shrink-0',
  row: (open) => (open ? 'h-full min-h-0' : 'self-start'),
  under: (open) => (open ? 'min-h-0 flex-1' : 'shrink-0'),
  side: () => 'h-full min-h-0',
  tile: () => 'h-full min-h-0'
};

export function DockPanel({ tab, place, count, aside, strip, open: shown, onToggle, children }: DockPanelProps) {
  const id = DOCK_IDS[tab];
  const panels = useAtomValue(livePanelsAtom);
  const editing = useAtomValue(liveEditingAtom) && place === 'tile';
  const locked = useAtomValue(liveLockedAtom);
  const open = shown ?? panels[tab];
  const toggle = () => (onToggle ? onToggle(!open) : setLivePanel(tab, !open));
  const word = DOCK_WORDS[tab];
  if (place === 'phone')
    return (
      <div id={id} data-tab={tab} data-place={place} className={cn('min-w-0', tab === 'chat' && 'flex h-full min-h-0 flex-col')}>
        {children}
      </div>
    );
  const fill = place !== 'column';
  const folded = place === 'side' && !open;
  return (
    <section
      id={id}
      data-tab={tab}
      data-place={place}
      data-open={open}
      aria-labelledby={`${id}-title`}
      className={panelClassName(
        cn('flex min-w-0 flex-col overflow-hidden', SECTION[place](open), editing && 'border-dashed border-primaryBlue/70 bubble:border-primaryBlue/70')
      )}
    >
      {folded ? (
        <>
          <span id={`${id}-title`} className="sr-only">
            {word}
          </span>
          {strip}
        </>
      ) : (
        <h2 className={cn(HEAD, !open && 'border-transparent')}>
          {editing && (
            <Tooltip content="drag to move. arrows move it, shift and arrows size it">
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
          {!locked && (
            <FoldButton id={`${id}-toggle`} open={open} controls={`${id}-body`} what={word} sideways={place === 'side'} onToggle={toggle} />
          )}
        </h2>
      )}
      <div
        id={`${id}-body`}
        inert={!open ? true : undefined}
        hidden={folded}
        className={cn(FOLD, open ? FOLD_OPEN : FOLD_SHUT, fill && open && 'min-h-0 flex-1')}
      >
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
