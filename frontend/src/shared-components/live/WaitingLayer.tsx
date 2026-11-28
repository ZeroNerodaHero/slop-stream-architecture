import { RiCameraLine, RiComputerLine } from '@remixicon/react';

import { wakeSource } from '@/infra/atoms/publish-atoms';
import type { Source } from '@/infra/scene';
import { Button } from '@/shared-components/Button';

export function WaitingLayer({ source }: { source: Source }) {
  const camera = source.kind === 'camera';
  const Icon = camera ? RiCameraLine : RiComputerLine;
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
        <Icon aria-hidden size={14} />
        {camera ? 'camera' : 'share'}
      </Button>
    </div>
  );
}
