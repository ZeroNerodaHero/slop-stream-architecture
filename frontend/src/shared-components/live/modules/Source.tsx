import { useAtomValue } from 'jotai';
import { useState } from 'react';

import { livePanelsAtom, type Place } from '@/infra/live-dock';
import { DockPanel } from '@/shared-components/live/Dock';
import { RenameButton, SourceSettings, SourceTitle, useSourceHead } from '@/shared-components/live/SourceSettings';

export function SourceModule({ place, onModel }: { place: Place; onModel: () => void }) {
  const hidden = useAtomValue(livePanelsAtom).hidden.includes('source');
  const head = useSourceHead(place);
  const [renaming, setRenaming] = useState<string | null>(null);
  if (hidden) return null;
  const editing = head !== null && renaming === head.id;
  return (
    <DockPanel
      tab="source"
      place={place}
      title={head ? <SourceTitle head={head} editing={editing} onDone={() => setRenaming(null)} /> : undefined}
      aside={head && !editing ? <RenameButton onClick={() => setRenaming(head.id)} /> : undefined}
    >
      <SourceSettings place={place} onModel={onModel} />
    </DockPanel>
  );
}
