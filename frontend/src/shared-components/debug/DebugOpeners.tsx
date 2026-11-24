import { RiBarChart2Line, RiTerminalBoxLine } from '@remixicon/react';

import { openInspector, openProfiler } from '@/infra/atoms/inspector-atoms';
import { Tooltip } from '@/shared-components/Tooltip';

export function DebugOpeners({ className, size }: { className: string; size: number }) {
  return (
    <>
      <Tooltip content="messages: the frames this browser gets">
        <button id="inspector-open" type="button" aria-label="messages" onClick={openInspector} className={className}>
          <RiTerminalBoxLine aria-hidden size={size} />
        </button>
      </Tooltip>
      <Tooltip content="profiler: timings and stream quality">
        <button id="profiler-open" type="button" aria-label="profiler" onClick={openProfiler} className={className}>
          <RiBarChart2Line aria-hidden size={size} />
        </button>
      </Tooltip>
    </>
  );
}
