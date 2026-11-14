import { useAtomValue } from 'jotai';
import { useState } from 'react';

import {
  backToCamera,
  faceAtom,
  faceCameraAtom,
  faceCamerasAtom,
  faceExpressionsAtom,
  faceMirrorAtom,
  type FaceReading,
  faceStatsAtom,
  isPublishingAtom,
  modelAtom,
  modelBackgroundAtom,
  modelRigAtom,
  readerLoadAtom,
  restFace,
  setFaceCamera,
  setFaceExpressions,
  setFaceMirror,
  setModelBackground
} from '@/infra/atoms/publish-atoms';
import { modelSurvivesHiddenTab, type RigInfo, type RigPart } from '@/infra/face';
import { ConfirmDialog } from '@/shared-components/ConfirmDialog';
import { LoadBar, readerWords } from '@/shared-components/live/ModelLoading';
import { CHECKBOX } from '@/shared-components/user-modal/parts';
import { cn } from '@/utils/cn';

/** What the face reader is doing, in the streamer's words. */
const WORDS: Record<FaceReading, string> = {
  idle: '',
  starting: 'getting ready to read your face',
  on: 'reading your face',
  lost: 'no face in view',
  off: 'the face reader did not load. the model moves on its own',
  'no-camera': 'no camera to read your face. the model moves on its own',
  'camera-blocked': 'camera blocked. the model moves on its own'
};
const ACTION = 'text-xs font-semibold text-primaryBlue disabled:opacity-40';
const PART: Record<RigPart, string> = { eyes: 'eyes', blink: 'blinks', mouth: 'mouth', brows: 'brows', smile: 'smile' };

/** What of this model a face can move, in a line. A model is told apart by what its file has, not by anything the streamer does. */
function rigWords(rig: RigInfo): string {
  if (rig.kind === 'none') return `this model has no face to move: only its head ${rig.parts.includes('eyes') ? 'and eyes turn' : 'turns'}`;
  if (rig.kind === 'arkit') return 'a perfect sync model: your whole face moves it';
  const parts = ['head', ...rig.parts.map((part) => PART[part])];
  return `your face moves its ${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * Under the sources while a model is in the camera's place (docs/vtuber.md): what the face
 * reader is doing (with a bar while it is still coming down), what of this model a face can
 * move, and the few things to set. `mirror` (the model moves like a mirror, or like the person
 * a camera sees), `expressions` (the brows and the smile move it too; only on a model that has
 * them), `rest face` (the face as it is now is the resting one), the colour behind the model,
 * which camera reads the face when there is more than one, another model, and the way back to
 * the camera's own picture, which asks first on a stream that is up: watchers would see a face
 * from there.
 *
 * The reader's numbers ride on `#face-status` as data attributes (where the head is asked to
 * turn, the jaw, the blink, the smile, the brows, frames a second, and what kind of face the
 * model has) for the test, which reads those and never pixels.
 */
export function ModelControls({ onChange }: { onChange: () => void }) {
  const model = useAtomValue(modelAtom);
  const face = useAtomValue(faceAtom);
  const stats = useAtomValue(faceStatsAtom);
  const rig = useAtomValue(modelRigAtom);
  const readerLoad = useAtomValue(readerLoadAtom);
  const mirror = useAtomValue(faceMirrorAtom);
  const expressions = useAtomValue(faceExpressionsAtom);
  const background = useAtomValue(modelBackgroundAtom);
  const cameras = useAtomValue(faceCamerasAtom);
  const camera = useAtomValue(faceCameraAtom);
  const publishing = useAtomValue(isPublishingAtom);
  const [asking, setAsking] = useState(false);
  if (!model) return null;
  const quiet = face === 'on' || face === 'starting';
  // the reader is still coming down after the model went on: how much of it is here
  const coming = face === 'starting' ? readerLoad : null;
  const hasMoods = rig !== null && (rig.parts.includes('brows') || rig.parts.includes('smile'));
  return (
    <div id="model-controls" className="flex flex-col gap-2 border-t border-primaryStroke px-3 py-2.5">
      {/* the row above is too narrow for a name beside its buttons: the model's name is said here */}
      <p id="model-name" className="truncate text-sm font-semibold text-textPrimary">
        {model.name}
      </p>
      <p
        id="face-status"
        data-face={face}
        data-yaw={stats?.yaw ?? 0}
        data-pitch={stats?.pitch ?? 0}
        data-roll={stats?.roll ?? 0}
        data-mouth={stats?.mouth ?? 0}
        data-blink={stats?.blink ?? 0}
        data-smile={stats?.smile ?? 0}
        data-brows={stats?.brows ?? 0}
        data-fps={stats?.fps ?? 0}
        data-reads={stats?.reads ?? 0}
        data-rig={rig?.kind}
        className={cn('text-xs', quiet ? 'text-textSecondary' : 'text-textPrimary')}
        aria-live={coming ? 'off' : 'polite'}
      >
        {coming ? readerWords(coming.loaded, coming.total) : WORDS[face]}
      </p>
      {coming && <LoadBar loaded={coming.loaded} total={coming.total} label="loading the face reader" />}
      {rig && (
        <p id="model-rig" data-kind={rig.kind} data-parts={rig.parts.join(' ')} className="text-xs text-textTertiary">
          {rigWords(rig)}
        </p>
      )}
      {!modelSurvivesHiddenTab() && (
        <p id="face-hidden-note" className="text-xs text-textTertiary">
          in this browser the model stops moving while this tab is hidden
        </p>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <label htmlFor="face-mirror" className="relative flex items-center gap-1.5 text-xs text-textSecondary">
          <input id="face-mirror" type="checkbox" checked={mirror} onChange={(e) => setFaceMirror(e.target.checked)} className={CHECKBOX} />
          mirror
        </label>
        {hasMoods && (
          <label htmlFor="face-expressions" className="relative flex items-center gap-1.5 text-xs text-textSecondary">
            <input id="face-expressions" type="checkbox" checked={expressions} onChange={(e) => setFaceExpressions(e.target.checked)} className={CHECKBOX} />
            expressions
          </label>
        )}
        <button id="face-rest" type="button" className={ACTION} onClick={restFace}>
          rest face
        </button>
        <label htmlFor="model-background" className="relative flex items-center gap-1.5 text-xs text-textSecondary">
          behind it
          <input
            id="model-background"
            type="color"
            value={background}
            onChange={(e) => setModelBackground(e.target.value)}
            className="h-6 w-8 cursor-pointer border border-primaryStroke bg-background p-0.5"
          />
        </label>
      </div>
      {cameras.length > 1 && (
        <label htmlFor="face-camera" className="relative flex min-w-0 items-center gap-1.5 text-xs text-textSecondary">
          <span className="shrink-0">reads</span>
          <select
            id="face-camera"
            value={cameras.some((c) => c.id === camera) ? camera : ''}
            onChange={(e) => void setFaceCamera(e.target.value)}
            className="min-w-0 flex-1 border border-primaryStroke bg-background px-1.5 py-1 text-xs text-textPrimary"
          >
            <option value="">the browser's camera</option>
            {cameras.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <button id="model-change" type="button" className={ACTION} onClick={onChange}>
          another model
        </button>
        <button
          id="source-real-cam"
          type="button"
          className="text-xs font-semibold text-textTertiary"
          onClick={() => (publishing ? setAsking(true) : void backToCamera())}
        >
          use the camera
        </button>
      </div>
      {asking && (
        <ConfirmDialog
          id="real-camera-confirm"
          title="put your camera on the stream?"
          message="watchers see the model now. after this they see your camera's own picture."
          yes="yes, show my camera"
          onYes={() => {
            setAsking(false);
            void backToCamera();
          }}
          onNo={() => setAsking(false)}
        />
      )}
    </div>
  );
}
