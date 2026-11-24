import { RiArrowRightUpLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';

import { openInspector, openQuality, openTimings } from '@/infra/atoms/inspector-atoms';
import { messagesEnabledAtom, qualityEnabledAtom, setMessagesEnabled, setQualityEnabled, setTimingsEnabled, timingsEnabledAtom } from '@/infra/atoms/settings-atoms';
import { Button } from '@/shared-components/Button';
import { Tooltip } from '@/shared-components/Tooltip';
import { Block, CHECKBOX, Info } from '@/shared-components/user-modal/parts';

const ROWS = [
  {
    id: 'inspector',
    switchId: 'inspector',
    word: 'log messages',
    tip: 'every socket message, sent and heard. the box keeps them in the background, the arrow opens the window. never leaves this browser',
    enabled: messagesEnabledAtom,
    set: setMessagesEnabled,
    open: openInspector
  },
  {
    id: 'timings',
    switchId: 'timings-switch',
    word: 'timings',
    tip: 'chat, say, watch and every api call, the last 100 of each. the box keeps them in the background, the arrow opens the window. never leaves this browser',
    enabled: timingsEnabledAtom,
    set: setTimingsEnabled,
    open: openTimings
  },
  {
    id: 'quality',
    switchId: 'quality-switch',
    word: 'quality',
    tip: 'stream quality over the watched time. the box keeps it in the background, the arrow opens the window. never leaves this browser',
    enabled: qualityEnabledAtom,
    set: setQualityEnabled,
    open: openQuality
  }
] as const;

function DebugRow({ row }: { row: (typeof ROWS)[number] }) {
  const on = useAtomValue(row.enabled);
  const open = () => {
    row.set(true);
    row.open();
  };
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 py-1.5">
      <span className="flex items-center gap-2 text-sm font-semibold text-textPrimary">
        <label htmlFor={row.switchId}>{row.word}</label>
        <Info tip={row.tip} />
      </span>
      <span className="flex items-center gap-1.5">
        <input id={row.switchId} type="checkbox" checked={on} onChange={(e) => row.set(e.target.checked)} className={CHECKBOX} />
        <Tooltip content={`open ${row.word}`}>
          <Button id={`${row.id}-open-settings`} size="sm" aria-label={`open ${row.word}`} onClick={open} className="h-7 w-7 p-0">
            <RiArrowRightUpLine aria-hidden size={16} />
          </Button>
        </Tooltip>
      </span>
    </div>
  );
}

export function AdvancedTab() {
  return (
    <div className="divide-y divide-primaryStroke">
      <Block title="debug">
        {ROWS.map((row) => (
          <DebugRow key={row.id} row={row} />
        ))}
      </Block>
    </div>
  );
}
