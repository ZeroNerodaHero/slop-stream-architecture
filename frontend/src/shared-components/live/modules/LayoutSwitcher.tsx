import { useAtomValue } from 'jotai';

import { LAYOUT_IDS, LAYOUT_WORDS, type LayoutId, liveEditingAtom, liveLayoutAtom, setLayout, startEditing, stopEditing } from '@/infra/live-dock';
import { Button } from '@/shared-components/Button';
import { FOLD_BUTTON } from '@/shared-components/live/Dock';
import { RailSection } from '@/shared-components/live/RailSection';
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

export function LayoutModule({ strip = false }: { strip?: boolean }) {
  const layout = useAtomValue(liveLayoutAtom);
  const editing = useAtomValue(liveEditingAtom);
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
      <div className="flex flex-col items-center border-t border-primaryStroke py-2">
        <Tooltip content={`layout ${layout}, ${LAYOUT_WORDS[layout]}. click for ${next}, ${LAYOUT_WORDS[next]}`}>
          <button id="live-layout-next" type="button" aria-label={`next layout: ${LAYOUT_WORDS[next]}`} onClick={() => pick(next)} className={FOLD_BUTTON}>
            <LayoutGlyph id={layout} />
          </button>
        </Tooltip>
      </div>
    );
  }
  return (
    <RailSection
      section="layout"
      id="live-layouts"
      title="layout"
      className="border-t border-primaryStroke px-3 py-2.5"
      bodyClassName="pt-2"
      aside={
        <Tooltip content={editing ? 'you are editing' : 'edit this layout on a grid'}>
          <Button
            id="live-layout-edit"
            size="sm"
            variant="outline"
            disabled={editing}
            onClick={() => startEditing(layout)}
            className="h-6 px-2 py-0 text-xs normal-case tracking-normal max-md:min-h-0"
          >
            edit
          </Button>
        </Tooltip>
      }
    >
      <div role="group" aria-label="layout" className="grid grid-cols-5 gap-1.5">
        {LAYOUT_IDS.map((id) => {
          const on = id === layout;
          return (
            <Tooltip key={id} content={on ? null : `${id}: ${LAYOUT_WORDS[id]}${id === 5 ? ', edit mode' : ''}`}>
              <button
                id={`live-layout-${id}`}
                type="button"
                aria-label={`layout ${id}, ${LAYOUT_WORDS[id]}`}
                aria-pressed={on}
                onClick={() => pick(id)}
                className={cn(
                  'flex h-10 min-w-0 flex-col items-center justify-center gap-1 rounded-card border text-[11px] font-semibold leading-none transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primaryBlue',
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
    </RailSection>
  );
}
