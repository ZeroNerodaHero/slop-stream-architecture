import { useAtomValue } from 'jotai';

import { livePanelsAtom, type Place } from '@/infra/live-dock';
import { DockPanel } from '@/shared-components/live/Dock';
import { SourceSettings } from '@/shared-components/live/SourceSettings';

export function SourceModule({ place, onModel }: { place: Place; onModel: () => void }) {
  const hidden = useAtomValue(livePanelsAtom).hidden.includes('source');
  if (hidden) return null;
  return (
    <DockPanel tab="source" place={place}>
      <SourceSettings place={place} onModel={onModel} />
    </DockPanel>
  );
}
