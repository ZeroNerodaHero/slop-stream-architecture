import { RiCameraLine, RiComputerLine, RiErrorWarningLine, RiLoader4Line, RiRefreshLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { type KeyboardEvent, type RefObject, useLayoutEffect, useRef, useState } from 'react';

import { cancelScreenPick, screenAsksAtom, screenShareSupported, wakeSource } from '@/infra/atoms/publish-atoms';
import { useIsMobile } from '@/infra/mobile';
import type { Source } from '@/infra/scene';
import { Button } from '@/shared-components/Button';
import { cn } from '@/utils/cn';

const COMPACT_W = 240;
const COMPACT_H = 130;
const STRIPES = 'pointer-events-none absolute inset-0 bg-[repeating-linear-gradient(135deg,currentColor_0_1px,transparent_1px_11px)]';
const CORNER = 'pointer-events-none absolute flex items-center gap-1 text-[10px] leading-none text-textTertiary';

const percent = (n: number) => Math.round(n * 100);

function useCompact(ref: RefObject<HTMLElement | null>): boolean {
  const [compact, setCompact] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const watch = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setCompact(width < COMPACT_W || height < COMPACT_H);
    });
    watch.observe(el);
    return () => watch.disconnect();
  }, [ref]);
  return compact;
}

export function WaitingLayer({ source }: { source: Source }) {
  if (source.kind === 'screen') return <ScreenDropZone source={source} />;
  return (
    <div id={`layer-${source.id}-waiting`} className="flex h-full w-full items-center justify-center bg-backgroundSecondary">
      <Button
        id={`layer-${source.id}-wake`}
        size="sm"
        className="gap-1.5 px-2.5 py-1 text-xs max-md:min-h-0"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          wakeSource(source.id);
        }}
      >
        <RiCameraLine aria-hidden size={14} />
        camera
      </Button>
    </div>
  );
}

function ScreenDropZone({ source }: { source: Source }) {
  const slot = (source.slot ?? 1) - 1;
  const ask = useAtomValue(screenAsksAtom)[slot];
  const mobile = useIsMobile();
  const frame = useRef<HTMLDivElement | null>(null);
  const compact = useCompact(frame);
  const name = `screen ${slot + 1}`;
  const size = `${percent(source.box.w)}×${percent(source.box.h)}%`;
  const id = `layer-${source.id}`;
  const unsupported = mobile || !screenShareSupported;
  const picking = !unsupported && ask === 'picking';
  const blocked = !unsupported && ask === 'blocked';
  const state = unsupported ? 'unsupported' : picking ? 'picking' : blocked ? 'blocked' : 'idle';
  const share = () => {
    if (!picking) wakeSource(source.id);
  };
  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    e.stopPropagation();
    share();
  };
  const label = picking ? `${name}, waiting on chrome` : blocked ? `${name} wasn't shared, click to try again` : `share ${name}`;
  return (
    <div ref={frame} id={`${id}-waiting`} data-state={state} className={cn('h-full w-full bg-backgroundSecondary', compact ? 'p-1' : 'p-1.5')}>
      <div
        id={`${id}-share`}
        role={unsupported ? undefined : 'button'}
        tabIndex={unsupported ? undefined : 0}
        aria-label={unsupported ? undefined : label}
        aria-busy={picking || undefined}
        onClick={
          unsupported
            ? undefined
            : (e) => {
                e.stopPropagation();
                share();
              }
        }
        onKeyDown={unsupported ? undefined : keys}
        className={cn(
          'group relative flex h-full w-full flex-col items-center justify-center overflow-hidden rounded-panel border border-dashed text-center outline-none transition-colors duration-150',
          unsupported
            ? 'border-primaryStroke'
            : blocked
              ? 'cursor-pointer border-decrease/60 hover:border-decrease focus-visible:border-decrease'
              : picking
                ? 'border-primaryBlue'
                : 'cursor-pointer border-primaryStroke hover:border-primaryBlue focus-visible:border-primaryBlue'
        )}
      >
        <span
          aria-hidden
          className={cn(
            STRIPES,
            'transition-colors duration-150',
            unsupported
              ? 'text-primaryStroke/60'
              : blocked
                ? 'text-decrease/20'
                : picking
                  ? 'text-primaryBlue/20'
                  : 'text-primaryStroke group-hover:text-primaryBlue/25 group-focus-visible:text-primaryBlue/25'
          )}
        />
        {!compact && (
          <span id={`${id}-slot-name`} className={cn(CORNER, 'left-2 top-2')}>
            <RiComputerLine aria-hidden size={10} />
            {name}
          </span>
        )}
        {!compact && !unsupported && (
          <span id={`${id}-slot-size`} className={cn(CORNER, 'bottom-2 right-2 tabular-nums')}>
            {size}
          </span>
        )}
        <span className="relative flex flex-col items-center gap-1 px-2">
          {unsupported ? (
            <>
              <RiComputerLine aria-hidden size={compact ? 16 : 20} className="text-textTertiary" />
              <span className="text-xs text-textTertiary">screen share needs a computer</span>
            </>
          ) : picking ? (
            <>
              <RiLoader4Line aria-hidden size={compact ? 16 : 18} className="text-primaryBlue motion-safe:animate-spin" />
              {!compact && <span className="text-xs font-medium text-textPrimary">waiting on chrome</span>}
              <Button
                id={`${id}-share-cancel`}
                size="sm"
                className="mt-0.5 px-2 py-0.5 text-[11px] max-md:min-h-0"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  cancelScreenPick(slot);
                }}
              >
                cancel
              </Button>
            </>
          ) : blocked ? (
            compact ? (
              <>
                <RiRefreshLine aria-hidden size={16} className="text-decrease" />
                <span className="text-[11px] font-medium text-decrease">retry</span>
              </>
            ) : (
              <>
                <RiErrorWarningLine aria-hidden size={20} className="text-decrease" />
                <span className="text-xs font-medium text-textPrimary">{`${name} wasn't shared`}</span>
                <span className="flex items-center gap-1 text-[11px] text-decrease">
                  <RiRefreshLine aria-hidden size={12} />
                  click to try again
                </span>
              </>
            )
          ) : (
            <>
              <RiComputerLine
                aria-hidden
                size={compact ? 16 : 20}
                className="text-textSecondary transition-colors duration-150 group-hover:text-primaryBlue group-focus-visible:text-primaryBlue"
              />
              <span className="text-xs font-medium text-textPrimary transition-colors duration-150 group-hover:text-primaryBlue group-focus-visible:text-primaryBlue">
                {compact ? 'share' : 'share screen'}
              </span>
              {!compact && <span className="text-[11px] text-textTertiary">a tab, a window or the whole screen</span>}
            </>
          )}
        </span>
      </div>
    </div>
  );
}
