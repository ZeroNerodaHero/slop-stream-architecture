import { RiAddLine, RiCheckLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';

import {
  DOCK_WORDS,
  type Grid,
  isSlot,
  LAYOUT_IDS,
  LAYOUT_MARKS,
  LAYOUT_WORDS,
  type LayoutId,
  liveEditingAtom,
  liveLayoutAtom,
  livePanelsAtom,
  liveSlotsAtom,
  MODULE_IDS,
  openRailAt,
  pickLayout,
  resetGrid,
  showInGrid,
  type Slots,
  startEditing,
  stopEditing,
  TILE_IDS
} from '@/infra/live-dock';
import { Button } from '@/shared-components/Button';
import { FOLD_BUTTON } from '@/shared-components/live/Dock';
import { RailSection } from '@/shared-components/live/RailSection';
import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

type Block = readonly [number, number, number, number, boolean];

const OBS_BLOCKS: readonly Block[] = [
  [0, 0, 5, 12, true],
  [6, 0, 12, 12, false]
];

function gridBlocks(grid: Grid): Block[] {
  return TILE_IDS.map((id) => {
    const c = grid[id];
    return [c.x * 1.5, c.y, c.w * 1.5, c.h, id !== 'preview'] as const;
  });
}

function LayoutGlyph({ id, slots }: { id: LayoutId; slots: Slots }) {
  const grid = isSlot(id) ? slots[id] : null;
  if (isSlot(id) && !grid)
    return (
      <span aria-hidden className="flex h-3 w-[18px] shrink-0 items-center justify-center">
        <RiAddLine size={14} />
      </span>
    );
  const blocks = grid ? gridBlocks(grid) : OBS_BLOCKS;
  return (
    <svg aria-hidden width="18" height="12" viewBox="0 0 18 12" className="shrink-0">
      {blocks.map(([x, y, w, h, solid], i) => (
        <rect
          key={i}
          x={x + 0.5}
          y={y + 0.5}
          width={w - 1}
          height={h - 1}
          rx="1"
          fill={solid ? 'currentColor' : 'none'}
          stroke="currentColor"
          strokeWidth="1"
          opacity={solid ? 0.9 : 0.7}
        />
      ))}
    </svg>
  );
}

function tipFor(id: LayoutId, slots: Slots): string {
  if (!isSlot(id)) return LAYOUT_WORDS[id];
  return slots[id] ? `${LAYOUT_WORDS[id]}, yours` : `${LAYOUT_WORDS[id]}, empty: click to set it up`;
}

export function LayoutModule({ strip = false }: { strip?: boolean }) {
  const layout = useAtomValue(liveLayoutAtom);
  const editing = useAtomValue(liveEditingAtom);
  const slots = useAtomValue(liveSlotsAtom);
  const panels = useAtomValue(livePanelsAtom);
  const closed = MODULE_IDS.filter((id) => panels.hidden.includes(id));
  const custom = isSlot(layout);
  if (strip && editing)
    return (
      <div className="flex flex-col items-center border-t border-primaryStroke py-2">
        <Tooltip content="stop editing">
          <button id="live-layout-done" type="button" aria-label="stop editing" onClick={stopEditing} className={cn(FOLD_BUTTON, 'border-primaryBlue text-primaryBlue')}>
            <RiCheckLine aria-hidden size={16} />
          </button>
        </Tooltip>
      </div>
    );
  if (strip)
    return (
      <div className="flex flex-col items-center border-t border-primaryStroke py-2">
        <Tooltip content="layout">
          <button id="live-layout-mini" type="button" aria-label="open the layouts" onClick={() => openRailAt('layout')} className={FOLD_BUTTON}>
            <LayoutGlyph id={layout} slots={slots} />
          </button>
        </Tooltip>
      </div>
    );
  return (
    <RailSection
      section="layout"
      id="live-layouts"
      title="layout"
      className="border-t border-primaryStroke px-3 py-2.5"
      bodyClassName="pt-2"
      aside={
        <>
          <Tooltip content={editing ? 'you are editing' : custom ? 'edit this layout on a grid' : 'obs left is built in: pick a custom slot to edit'}>
            <Button
              id="live-layout-edit"
              size="sm"
              variant="outline"
              disabled={editing || !custom}
              onClick={startEditing}
              className="h-6 px-2 py-0 text-xs normal-case tracking-normal max-md:min-h-0"
            >
              edit
            </Button>
          </Tooltip>
          {editing && (
            <>
              <Tooltip content="back to the stream with everything along the top">
                <Button id="live-edit-reset" size="sm" disabled={!custom} onClick={resetGrid} className="h-6 px-2 py-0 text-xs normal-case tracking-normal max-md:min-h-0">
                  reset
                </Button>
              </Tooltip>
              <Tooltip content="stop editing">
                <Button id="live-edit-done" size="sm" variant="primary" onClick={stopEditing} className="h-6 px-2 py-0 text-xs normal-case tracking-normal max-md:min-h-0">
                  done
                </Button>
              </Tooltip>
            </>
          )}
        </>
      }
    >
      <div role="group" aria-label="layout" className="grid grid-cols-5 gap-1.5">
        {LAYOUT_IDS.map((id) => {
          const on = id === layout;
          return (
            <Tooltip key={id} content={on ? null : tipFor(id, slots)}>
              <button
                id={`live-layout-${id}`}
                type="button"
                aria-label={tipFor(id, slots)}
                aria-pressed={on}
                onClick={() => pickLayout(id)}
                className={cn(
                  'flex h-10 min-w-0 flex-col items-center justify-center gap-1 rounded-card border text-[11px] font-semibold leading-none transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primaryBlue',
                  on ? 'border-primaryBlue bg-primaryBlue/10 text-primaryBlue' : 'border-primaryStroke text-textSecondary hover:border-secondaryStroke hover:text-textPrimary'
                )}
              >
                <LayoutGlyph id={id} slots={slots} />
                {LAYOUT_MARKS[id]}
              </button>
            </Tooltip>
          );
        })}
      </div>
      {editing && closed.length > 0 && (
        <div id="live-edit-closed" role="group" aria-label="closed panels" className="mt-2 flex flex-wrap items-center gap-1.5">
          {closed.map((id) => (
            <Button key={id} id={`live-edit-add-${id}`} size="sm" className="h-7 shrink-0 gap-1 px-2.5 py-0 text-xs" onClick={() => showInGrid(id)}>
              <RiAddLine aria-hidden size={14} />
              {DOCK_WORDS[id]}
            </Button>
          ))}
        </div>
      )}
    </RailSection>
  );
}
