import { RiEmotionHappyLine, RiEmotionNormalLine, RiFlipHorizontalLine, RiInformationLine, RiPaintLine } from '@remixicon/react';
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
import { Button } from '@/shared-components/Button';
import { ConfirmDialog } from '@/shared-components/ConfirmDialog';
import { ICON_BUTTON } from '@/shared-components/live/Collapsible';
import { LoadBar, readerWords } from '@/shared-components/live/ModelLoading';
import { Select } from '@/shared-components/Select';
import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

const READING: Record<FaceReading, { said: string; more: string }> = {
  idle: { said: '', more: '' },
  starting: { said: '', more: 'getting ready to read your face' },
  on: { said: '', more: 'reading your face' },
  lost: { said: 'no face', more: ' in view. the model moves on its own' },
  off: { said: 'no face reader', more: ': it did not load. the model moves on its own' },
  'no-camera': { said: 'no camera', more: ' to read your face. the model moves on its own' },
  'camera-blocked': { said: 'camera blocked', more: '. the model moves on its own' }
};
type Tone = 'on' | 'wait' | 'bad';
const LIGHT: Record<Tone, string> = { on: 'bg-increase', wait: 'bg-textTertiary motion-safe:animate-pulse', bad: 'bg-decrease' };
const HIDDEN_TAB = 'in this browser the model stops moving while this tab is hidden';
const WELL = cn(ICON_BUTTON, 'relative cursor-pointer flex-col gap-0.5 has-[:focus-visible]:border-primaryBlue');
const PART: Record<RigPart, string> = { eyes: 'eyes', blink: 'blinks', mouth: 'mouth', brows: 'brows', smile: 'smile' };

function rigWords(rig: RigInfo): string {
  if (rig.kind === 'none') return `this model has no face to move: only its head ${rig.parts.includes('eyes') ? 'and eyes turn' : 'turns'}`;
  if (rig.kind === 'arkit') return 'a perfect sync model: your whole face moves it';
  const parts = ['head', ...rig.parts.map((part) => PART[part])];
  return `your face moves its ${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

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
  const { said, more } = READING[face];
  const sentence = said + more;
  const tone: Tone = face === 'on' ? 'on' : said ? 'bad' : 'wait';
  const coming = face === 'starting' ? readerLoad : null;
  const hasMoods = rig !== null && (rig.parts.includes('brows') || rig.parts.includes('smile'));
  const faceless = rig?.kind === 'none';
  return (
    <div id="model-controls" className="relative flex flex-col gap-2 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <p id="model-name" className="min-w-0 truncate text-sm font-semibold text-textPrimary">
          {model.name}
        </p>
        {!modelSurvivesHiddenTab() && (
          <Tooltip content={HIDDEN_TAB}>
            <span id="face-hidden-note" role="img" aria-label={HIDDEN_TAB} className="flex shrink-0 text-textTertiary">
              <RiInformationLine aria-hidden size={14} />
            </span>
          </Tooltip>
        )}
        <Tooltip
          content={
            sentence && (
              <>
                {sentence}
                {face === 'on' && rig && !faceless && <span className="block font-normal text-textSecondary">{rigWords(rig)}</span>}
              </>
            )
          }
        >
          <span
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
            className={cn('relative ml-auto flex shrink-0 items-center gap-1.5 text-xs', tone === 'bad' && 'text-decrease')}
            aria-live="polite"
            aria-atomic
          >
            {said}
            <span className="sr-only">{more}</span>
            <span aria-hidden className="flex h-4 w-4 items-center justify-end">
              <span id="face-light" className={cn('block h-2 w-2', LIGHT[tone])} />
            </span>
          </span>
        </Tooltip>
      </div>
      {coming && (
        <>
          <p className="text-xs text-textSecondary">{readerWords(coming.loaded, coming.total)}</p>
          <LoadBar loaded={coming.loaded} total={coming.total} label="loading the face reader" />
        </>
      )}
      {rig && (
        <p id="model-rig" data-kind={rig.kind} data-parts={rig.parts.join(' ')} className={faceless ? 'text-xs text-textTertiary' : 'sr-only'}>
          {rigWords(rig)}
        </p>
      )}
      <div className="-ml-1.5 flex items-center gap-1">
        <Tooltip content={mirror ? 'mirrored. click to unmirror' : 'not mirrored. click to mirror'}>
          <button
            id="face-mirror"
            type="button"
            aria-label="mirror"
            aria-pressed={mirror}
            onClick={() => setFaceMirror(!mirror)}
            className={cn(ICON_BUTTON, mirror && 'text-primaryBlue')}
          >
            <RiFlipHorizontalLine aria-hidden size={16} />
          </button>
        </Tooltip>
        {hasMoods && (
          <Tooltip content={expressions ? 'your brows and smile move it. click to turn them off' : 'your brows and smile are off. click to turn them on'}>
            <button
              id="face-expressions"
              type="button"
              aria-label="expressions"
              aria-pressed={expressions}
              onClick={() => setFaceExpressions(!expressions)}
              className={cn(ICON_BUTTON, expressions && 'text-primaryBlue')}
            >
              {expressions ? (
                <RiEmotionHappyLine aria-hidden size={16} className="pointer-events-none" />
              ) : (
                <RiEmotionNormalLine aria-hidden size={16} className="pointer-events-none" />
              )}
            </button>
          </Tooltip>
        )}
        <Tooltip content="the colour behind the model">
          <label className={WELL}>
            <RiPaintLine aria-hidden size={14} />
            <span aria-hidden className="block h-1.5 w-4 border border-primaryStroke" style={{ backgroundColor: background }} />
            <input
              id="model-background"
              type="color"
              aria-label="the colour behind the model"
              value={background}
              onChange={(e) => setModelBackground(e.target.value)}
              className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            />
          </label>
        </Tooltip>
      </div>
      {cameras.length > 1 && (
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-textSecondary">
          <span className="shrink-0">reads</span>
          <Select
            id="face-camera"
            label="the camera that reads your face"
            value={cameras.some((c) => c.id === camera) ? camera : ''}
            options={[{ value: '', label: "the browser's camera" }, ...cameras.map((c) => ({ value: c.id, label: c.label }))]}
            onChange={(id) => void setFaceCamera(id)}
            className="min-w-0 flex-1"
          />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <Button id="model-change" size="sm" onClick={onChange}>
          another model
        </Button>
        <Button id="face-rest" size="sm" onClick={restFace}>
          rest face
        </Button>
        <Button id="source-real-cam" size="sm" onClick={() => (publishing ? setAsking(true) : void backToCamera())}>
          use the camera
        </Button>
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
