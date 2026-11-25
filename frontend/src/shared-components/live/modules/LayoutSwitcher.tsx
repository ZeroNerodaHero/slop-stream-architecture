import { useAtomValue } from 'jotai';

import { LAYOUT_IDS, LAYOUT_WORDS, type LayoutId, liveEditingAtom, liveLayoutAtom, liveLockedAtom, setLayout, startEditing, stopEditing } from '@/infra/live-dock';
import { Button } from '@/shared-components/Button';
import { FOLD_BUTTON } from '@/shared-components/live/Dock';
import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

const BLOCKS: Record<LayoutId, readonly [number, number, number, number, boolean][]> = {
  1: [
    [0, 0, 5, 12, true],
    [6, 0, 12, 12, false]
  ],
  2: [
    [0, 0, 12, 12, false],
    [13, 0, 5, 12, true]
  ],
  3: [
    [0, 0, 18, 7, false],
    [0, 8, 18, 4, true]
  ],
  4: [
    [0, 0, 4, 12, true],
    [5, 0, 8, 12, false],
    [14, 0, 4, 12, true]
  ],
  5: [
    [0, 0, 8, 5, false],
    [10, 0, 8, 5, true],
    [0, 7, 8, 5, true],
    [10, 7, 8, 5, false]
  ]
};

function LayoutGlyph({ id }: { id: LayoutId }) {
  return (
    <svg aria-hidden width="18" height="12" viewBox="0 0 18 12" className="shrink-0">
      {BLOCKS[id].map(([x, y, w, h, solid], i) => (
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

const LOCKED = 'live safe is locked: pick another preset first';

export function LayoutModule({ strip = false }: { strip?: boolean }) {
  const layout = useAtomValue(liveLayoutAtom);
  const editing = useAtomValue(liveEditingAtom);
  const locked = useAtomValue(liveLockedAtom);
  const pick = (id: LayoutId) => {
    if (id === 5) startEditing(5);
    else {
      stopEditing();
      setLayout(id);
    }
  };
  if (strip) {
    const next: LayoutId = layout >= 4 ? 1 : ((layout + 1) as LayoutId);
    return (
      <div className="flex flex-col items-center border-b border-primaryStroke py-2">
        <Tooltip content={locked ? LOCKED : `layout ${layout}, ${LAYOUT_WORDS[layout]}. click for ${next}, ${LAYOUT_WORDS[next]}`}>
          <button id="live-layout-next" type="button" aria-label={`next layout: ${LAYOUT_WORDS[next]}`} disabled={locked} onClick={() => pick(next)} className={cn(FOLD_BUTTON, 'disabled:opacity-40')}>
            <LayoutGlyph id={layout} />
          </button>
        </Tooltip>
      </div>
    );
  }
  return (
    <section id="live-layouts" aria-labelledby="live-layouts-title" className="flex flex-col gap-2 border-b border-primaryStroke px-3 py-2.5">
      <h2 className="flex h-6 items-center justify-between text-xs font-semibold uppercase tracking-wider text-textTertiary">
        <span id="live-layouts-title">layout</span>
        <Tooltip content={locked ? LOCKED : editing ? 'you are editing' : 'edit this layout on a grid'}>
          <Button
            id="live-layout-edit"
            size="sm"
            variant="outline"
            disabled={locked || editing}
            onClick={() => startEditing(layout)}
            className="h-6 px-2 py-0 text-xs normal-case tracking-normal max-md:min-h-0"
          >
            edit
          </Button>
        </Tooltip>
      </h2>
      <div role="group" aria-label="layout" className="grid grid-cols-5 gap-1.5">
        {LAYOUT_IDS.map((id) => {
          const on = id === layout;
          return (
            <Tooltip key={id} content={on ? null : locked ? LOCKED : `${id}: ${LAYOUT_WORDS[id]}${id === 5 ? ', edit mode' : ''}`}>
              <button
                id={`live-layout-${id}`}
                type="button"
                aria-label={`layout ${id}, ${LAYOUT_WORDS[id]}`}
                aria-pressed={on}
                disabled={locked && !on}
                onClick={() => pick(id)}
                className={cn(
                  'flex h-10 min-w-0 flex-col items-center justify-center gap-1 rounded-card border text-[11px] font-semibold leading-none transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primaryBlue disabled:cursor-default disabled:opacity-40',
                  on ? 'border-primaryBlue bg-primaryBlue/10 text-primaryBlue' : 'border-primaryStroke text-textSecondary hover:border-secondaryStroke hover:text-textPrimary'
                )}
              >
                <LayoutGlyph id={id} />
                {id}
              </button>
            </Tooltip>
          );
        })}
      </div>
    </section>
  );
}
