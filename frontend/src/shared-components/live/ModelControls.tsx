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
import { ConfirmDialog } from '@/shared-components/ConfirmDialog';
import { ICON_BUTTON } from '@/shared-components/live/Collapsible';
import { LoadBar, readerWords } from '@/shared-components/live/ModelLoading';
import { Select } from '@/shared-components/Select';
import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

/**
 * What the face reader is doing, in the streamer's words. `said` stands beside the light, and
 * only trouble has any: a face being read is a green light and no words. `more` is how the
 * sentence goes on (the whole of it where nothing is said), for a pointer on the light and for
 * a screen reader.
 */
const READING: Record<FaceReading, { said: string; more: string }> = {
  idle: { said: '', more: '' },
  starting: { said: '', more: 'getting ready to read your face' },
  on: { said: '', more: 'reading your face' },
  lost: { said: 'no face', more: ' in view. the model moves on its own' },
  off: { said: 'no face reader', more: ': it did not load. the model moves on its own' },
  'no-camera': { said: 'no camera', more: ' to read your face. the model moves on its own' },
  'camera-blocked': { said: 'camera blocked', more: '. the model moves on its own' }
};
/** The light: green while a face is read, red while none is, grey and breathing while the reader is on its way. */
type Tone = 'on' | 'wait' | 'bad';
const LIGHT: Record<Tone, string> = { on: 'bg-increase', wait: 'bg-textTertiary motion-safe:animate-pulse', bad: 'bg-decrease' };
const HIDDEN_TAB = 'in this browser the model stops moving while this tab is hidden';
/**
 * The colour behind the model, drawn as the icons beside it are and not as each browser draws
 * a colour well: a bucket, and under it a bar of the colour it holds.
 */
const WELL = cn(ICON_BUTTON, 'relative cursor-pointer flex-col gap-0.5 has-[:focus-visible]:border-primaryBlue');
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
 * Under the sources while a model is in the camera's place (docs/vtuber.md). Its name, and at
 * the end of that line a light for the face reader: green while it reads a face, red with a
 * word or two beside it while it reads none (`no face`, `camera blocked`), grey and breathing
 * while it is on its way, with a bar under the name while its files still come down. The whole
 * sentence is the light's tooltip, with what of this model a face can move; a model with no
 * face says that on the page, since nothing else explains a face that stays still. On a
 * browser where a hidden tab stops the model, a mark beside the name says so.
 *
 * Then the few things to set, as icons: `mirror` (the model moves like a mirror, or like the
 * person a camera sees), `expressions` (the brows and the smile move it too; only on a model
 * that has them) and the colour behind the model. In words: `rest face` (the face as it is now
 * is the resting one), which camera reads the face when there is more than one, another model,
 * and the way back to the camera's own picture, which asks first on a stream that is up:
 * watchers would see a face from there.
 *
 * The reader's numbers ride on `#face-status` as data attributes (where the head is asked to
 * turn, the jaw, the blink, the smile, the brows, frames a second, and what kind of face the
 * model has) for the test, which reads those and never pixels. Its words are in it whatever
 * the light shows, for a screen reader and the test.
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
  const { said, more } = READING[face];
  const sentence = said + more;
  const tone: Tone = face === 'on' ? 'on' : said ? 'bad' : 'wait';
  // the reader is still coming down after the model went on: how much of it is here
  const coming = face === 'starting' ? readerLoad : null;
  const hasMoods = rig !== null && (rig.parts.includes('brows') || rig.parts.includes('smile'));
  // a model with no face to move says so on the page; any other says what moves in the light's tooltip
  const faceless = rig?.kind === 'none';
  return (
    // `relative`: the words kept for a screen reader are `sr-only` (relative-parent.mdc)
    <div id="model-controls" className="relative flex flex-col gap-2 border-t border-primaryStroke px-3 py-2.5">
      {/* the row above is too narrow for a name beside its buttons: the model's name is said here */}
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
            {/* a box wider than the light, for the pointer to find */}
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
      {/* pulled left by an icon's own inset, so the first glyph stands under the name's first letter */}
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
              {/* the glyph is another node once pressed, so the pointer is on the button, never on the glyph: safari's
                  engine tells nobody that a pointer has left a node that is gone, and the tooltip would stay behind */}
              {expressions ? (
                <RiEmotionHappyLine aria-hidden size={16} className="pointer-events-none" />
              ) : (
                <RiEmotionNormalLine aria-hidden size={16} className="pointer-events-none" />
              )}
            </button>
          </Tooltip>
        )}
        <Tooltip content="the colour behind the model">
          {/* `relative`: the browser's own well lies over the bucket, unseen, and takes the press (relative-parent.mdc) */}
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
        <button id="face-rest" type="button" className={cn(ACTION, 'ml-auto')} onClick={restFace}>
          rest face
        </button>
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
