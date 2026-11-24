import { useAtomValue } from 'jotai';

import { openInspector, openProfiler } from '@/infra/atoms/inspector-atoms';
import { inspectorEnabledAtom, setInspectorEnabled } from '@/infra/atoms/settings-atoms';
import { Button } from '@/shared-components/Button';
import { Block, CHECKBOX, Info } from '@/shared-components/user-modal/parts';

export function AdvancedTab() {
  const inspectorOn = useAtomValue(inspectorEnabledAtom);
  return (
    <div className="divide-y divide-primaryStroke">
      <Block title="debug">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 py-1.5">
          <span className="flex items-center gap-2 text-sm font-semibold text-textPrimary">
            <label htmlFor="inspector">log messages</label>
            <Info tip="socket log, chat and stream timings, stream quality. never leaves this browser" />
          </span>
          <span className="flex items-center gap-1.5">
            <input id="inspector" type="checkbox" checked={inspectorOn} onChange={(e) => setInspectorEnabled(e.target.checked)} className={CHECKBOX} />
            <Button id="inspector-open-settings" size="sm" disabled={!inspectorOn} onClick={openInspector}>
              open
            </Button>
            <Button id="profiler-open-settings" size="sm" disabled={!inspectorOn} onClick={openProfiler}>
              profiler
            </Button>
          </span>
        </div>
      </Block>
    </div>
  );
}
