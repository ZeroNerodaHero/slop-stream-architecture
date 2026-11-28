import { RiArrowRightUpLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';

import { openInspector, openQuality, openTimings } from '@/infra/atoms/inspector-atoms';
import {
  messagesEnabledAtom,
  perfModeAtom,
  qualityEnabledAtom,
  restreamDirectAtom,
  setMessagesEnabled,
  setPerfMode,
  setQualityEnabled,
  setRestreamDirect,
  setTimingsEnabled,
  timingsEnabledAtom
} from '@/infra/atoms/settings-atoms';
import { PERF_MODES } from '@/infra/debug-flag';
import { inTauri } from '@/infra/update-check';
import { Button } from '@/shared-components/Button';
import { Segmented } from '@/shared-components/Segmented';
import { Tooltip } from '@/shared-components/Tooltip';
import { Block, CHECKBOX, Info } from '@/shared-components/user-modal/parts';
import { HERE } from '@/infra/here';

const ROWS = [
  {
    id: 'inspector',
    switchId: 'inspector',
    word: 'log messages',
    tip: `every socket message, sent and heard. the box keeps them in the background, the arrow opens the window. never leaves ${HERE}`,
    enabled: messagesEnabledAtom,
    set: setMessagesEnabled,
    open: openInspector
  },
  {
    id: 'timings',
    switchId: 'timings-switch',
    word: 'timings',
    tip: `chat, say, watch and every api call, the last 100 of each. the box keeps them in the background, the arrow opens the window. never leaves ${HERE}`,
    enabled: timingsEnabledAtom,
    set: setTimingsEnabled,
    open: openTimings
  },
  {
    id: 'quality',
    switchId: 'quality-switch',
    word: 'quality',
    tip: `stream quality over the watched time. the box keeps it in the background, the arrow opens the window. never leaves ${HERE}`,
    enabled: qualityEnabledAtom,
    set: setQualityEnabled,
    open: openQuality
  }
] as const;

const PERF_OPTIONS = PERF_MODES.map((mode) => ({ value: mode, label: mode }));

function PerfRow() {
  const mode = useAtomValue(perfModeAtom);
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 py-1.5">
      <span className="flex items-center gap-2 text-sm font-semibold text-textPrimary">
        <span>perf overlay</span>
        <Info tip={`fps, main thread busy, memory and network, top right until you drag it somewhere else. extended adds a graph of the last minute above each. never leaves ${HERE}`} />
      </span>
      <Segmented id="perf-mode" label="perf overlay" options={PERF_OPTIONS} value={mode} onChange={setPerfMode} />
    </div>
  );
}

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

function DirectRow() {
  const on = useAtomValue(restreamDirectAtom);
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 py-1.5">
      <span className="flex items-center gap-2 text-sm font-semibold text-textPrimary">
        <label htmlFor="restream-direct">send to destinations from this app</label>
        <Info tip="on: this app sends your stream to twitch, kick, youtube and custom rtmp itself, over your own upload. off: it goes through the nodentity relay, like the website. it falls back to the relay when this mac cannot encode it (macOS needs Safari 26 or newer)" />
      </span>
      <input id="restream-direct" type="checkbox" checked={on} onChange={(e) => setRestreamDirect(e.target.checked)} className={CHECKBOX} />
    </div>
  );
}

export function AdvancedTab() {
  return (
    <div className="divide-y divide-primaryStroke">
      {inTauri() && (
        <Block id="advanced-streaming" title="streaming">
          <DirectRow />
        </Block>
      )}
      <Block title="debug">
        {ROWS.map((row) => (
          <DebugRow key={row.id} row={row} />
        ))}
        <PerfRow />
      </Block>
    </div>
  );
}
