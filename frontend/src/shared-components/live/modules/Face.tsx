import { useAtomValue } from 'jotai';

import { modelAtom } from '@/infra/atoms/publish-atoms';
import type { Place } from '@/infra/live-dock';
import { Button } from '@/shared-components/Button';
import { DockPanel } from '@/shared-components/live/Dock';
import { ModelControls } from '@/shared-components/live/ModelControls';

export function FaceBody({ onModel }: { onModel: () => void }) {
  const model = useAtomValue(modelAtom);
  if (model) return <ModelControls onChange={onModel} />;
  return (
    <div id="face-none" className="flex flex-col items-start gap-2 px-3 py-2.5 text-sm text-textTertiary">
      <p>no model on: the camera goes out as it is.</p>
      <Button id="face-pick-model" size="sm" variant="outline" onClick={onModel}>
        pick a model
      </Button>
    </div>
  );
}

export function FaceModule({ place, onModel }: { place: Place; onModel: () => void }) {
  return (
    <DockPanel tab="face" place={place}>
      <FaceBody onModel={onModel} />
    </DockPanel>
  );
}
