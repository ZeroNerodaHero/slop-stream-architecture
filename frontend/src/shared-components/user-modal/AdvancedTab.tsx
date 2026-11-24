import { RiArrowRightUpLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';

import { openInspector, openQuality, openTimings } from '@/infra/atoms/inspector-atoms';
import { inspectorEnabledAtom, setInspectorEnabled } from '@/infra/atoms/settings-atoms';
import { Button } from '@/shared-components/Button';
import { Tooltip } from '@/shared-components/Tooltip';
import { Block, CHECKBOX, Info } from '@/shared-components/user-modal/parts';

const ROWS = [
  {
    id: 'inspector',
    word: 'log messages',
    tip: 'every socket message, sent and heard. the box turns on all three, kept while on. never leaves this browser',
    open: openInspector
  },
  { id: 'timings', word: 'timings', tip: 'chat, say, watch and every api call, the last 100 of each. never leaves this browser', open: openTimings },
  { id: 'quality', word: 'quality', tip: 'stream quality over the watched time. never leaves this browser', open: openQuality }
] as const;

export function AdvancedTab() {
  const inspectorOn = useAtomValue(inspectorEnabledAtom);
  return (
    <div className="divide-y divide-primaryStroke">
      <Block title="debug">
        {ROWS.map((row) => (
          <div key={row.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 py-1.5">
            <span className="flex items-center gap-2 text-sm font-semibold text-textPrimary">
              {row.id === 'inspector' ? <label htmlFor="inspector">{row.word}</label> : <span>{row.word}</span>}
              <Info tip={row.tip} />
            </span>
            <span className="flex items-center gap-1.5">
              {row.id === 'inspector' && (
                <input id="inspector" type="checkbox" checked={inspectorOn} onChange={(e) => setInspectorEnabled(e.target.checked)} className={CHECKBOX} />
              )}
              <Tooltip content={`open ${row.word}`}>
                <Button id={`${row.id}-open-settings`} size="sm" aria-label={`open ${row.word}`} disabled={!inspectorOn} onClick={row.open} className="h-7 w-7 p-0">
                  <RiArrowRightUpLine aria-hidden size={16} />
                </Button>
              </Tooltip>
            </span>
          </div>
        ))}
      </Block>
    </div>
  );
}
