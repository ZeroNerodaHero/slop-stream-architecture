import { RiMusic2Line, RiPlayFill, RiStopFill, RiVidiconLine, RiVolumeUpLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { useEffect, useRef, useState } from 'react';

import {
  cameraDeviceAtom,
  faceCamerasAtom,
  fitSourceTo,
  hasCameraAtom,
  hasMicAtom,
  isPublishingAtom,
  modelAtom,
  refreshFaceCameras,
  selectedSourceAtom,
  setCamera,
  setSourceFit,
  sourcesAtom
} from '@/infra/atoms/publish-atoms';
import {
  playSound,
  renameSound,
  renameSource,
  setSoundHear,
  setSoundLoop,
  setSoundVolume,
  soundPlayingAtom,
  soundsAtom,
  soundStatusAtom,
  sourceNamesAtom,
  sourceNameOf,
  stopSound
} from '@/infra/atoms/source-atoms';
import { livePanelsAtom, type Place } from '@/infra/live-dock';
import type { Source } from '@/infra/scene';
import { INPUT_WORDS, inputKindOf, SOURCE_NAME_MAX, type SoundSource, sectionsOf } from '@/infra/source-settings';
import { Button } from '@/shared-components/Button';
import { AvatarLookSettings } from '@/shared-components/live/AvatarLookSettings';
import { INPUT } from '@/shared-components/input';
import { DevicePick } from '@/shared-components/live/DevicePick';
import { ModelControls } from '@/shared-components/live/ModelControls';
import { Rigging } from '@/shared-components/live/Rigging';
import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

const PRESSED = 'border-primaryBlue text-primaryBlue';
const SECTION_HEAD = 'px-3 pt-2.5 text-xs font-semibold uppercase tracking-wider text-textSecondary';

export function useSourceFacts(source: Source) {
  const hasMic = useAtomValue(hasMicAtom);
  const model = useAtomValue(modelAtom);
  const worn = source.kind === 'camera' && model !== null;
  const fill = source.fit ? source.fit === 'cover' : source.kind === 'camera';
  const canRemove = source.kind !== 'camera' || hasMic;
  const removeWords =
    source.kind === 'screen'
      ? 'stop sharing'
      : source.kind === 'image'
        ? 'remove (the upload stays in your pictures)'
        : source.kind === 'avatar'
          ? 'remove (the + brings it back)'
          : !hasMic
            ? `no mic: the ${worn ? 'model' : 'camera'} is all there is`
            : worn
              ? 'take the model off: mic only, your avatar stands in'
              : 'turn the camera off: mic only, your avatar stands in';
  const removeLabel = source.kind === 'screen' ? 'stop sharing' : worn ? 'take the model off' : source.kind === 'camera' ? 'turn the camera off' : 'remove';
  return { worn, fill, canRemove, removeWords, removeLabel };
}

interface NameEditProps {
  id: string;
  name: string;
  onSave: (name: string) => void;
  onCancel: () => void;
  label?: string;
  className?: string;
}

export function NameEdit({ id, name, onSave, onCancel, label = 'source name', className }: NameEditProps) {
  const ref = useRef<HTMLInputElement | null>(null);
  const [draft, setDraft] = useState(name);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    if (save) onSave(draft);
    else onCancel();
  };
  return (
    <>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <input
        ref={ref}
        id={id}
        value={draft}
        maxLength={SOURCE_NAME_MAX}
        placeholder="name"
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => finish(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            finish(true);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            finish(false);
          }
        }}
        className={cn(INPUT, 'h-7 min-w-0 flex-1 px-2 py-0 text-sm max-md:h-9 max-md:text-[length:max(1rem,16px)]', className)}
      />
    </>
  );
}

function Header({ id, name, kind, onRename }: { id: string; name: string; kind: string; onRename: (name: string) => void }) {
  const [editing, setEditing] = useState(false);
  return (
    <div className="flex min-h-7 min-w-0 items-center gap-2">
      {editing ? (
        <NameEdit
          id={`source-detail-name-${id}`}
          name={name}
          onSave={(next) => {
            onRename(next);
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <p className="flex min-w-0 flex-1 items-baseline gap-2">
          <span id="source-detail-name" className="truncate text-xs font-semibold uppercase tracking-wider text-textSecondary">
            {name}
          </span>
          {kind !== name && (
            <span id="source-detail-kind" className="shrink-0 text-xs text-textTertiary">
              {kind}
            </span>
          )}
        </p>
      )}
      {!editing && (
        <Button id="source-detail-rename" size="sm" className="shrink-0 py-0.5 text-xs" onClick={() => setEditing(true)}>
          rename
        </Button>
      )}
    </div>
  );
}

const refreshCameras = () => void refreshFaceCameras();

function CameraPick() {
  const hasCamera = useAtomValue(hasCameraAtom);
  const devices = useAtomValue(faceCamerasAtom);
  const current = useAtomValue(cameraDeviceAtom);
  return (
    <DevicePick
      id="camera-device"
      label="the camera that goes out"
      icon={RiVidiconLine}
      value={current}
      devices={devices}
      fallback="default camera"
      on={hasCamera}
      refresh={refreshCameras}
      onPick={(id) => void setCamera(id)}
    />
  );
}

function VisualSettings({ source, place, onModel }: { source: Source; place: Place; onModel: () => void }) {
  const model = useAtomValue(modelAtom);
  const names = useAtomValue(sourceNamesAtom);
  const hasCamera = useAtomValue(sourcesAtom).some((s) => s.kind === 'camera');
  const label = sourceNameOf(source, model, names);
  const { worn, fill } = useSourceFacts(source);
  const input = inputKindOf(source.kind, worn);
  const sections = sectionsOf(input);
  return (
    <div id="source-detail" data-source={source.id} data-input={input} className="flex min-w-0 flex-col">
      <div className="flex min-w-0 flex-col gap-2 px-3 py-2.5">
        <Header id={source.id} name={label.name} kind={INPUT_WORDS[input]} onRename={(next) => renameSource(label, next)} />
        {(sections.includes('fill') || (sections.includes('fitCamera') && hasCamera)) && (
          <div className="flex flex-wrap gap-1.5">
            {sections.includes('fill') && (
              <Button id="source-detail-fit" size="sm" onClick={() => setSourceFit(source.id, fill ? 'contain' : 'cover')}>
                {fill ? 'whole picture' : 'fill box'}
              </Button>
            )}
            {sections.includes('fitCamera') && hasCamera && (
              <Tooltip content="the same box as the camera, just over it (a border)">
                <Button id="source-detail-fit-camera" size="sm" onClick={() => fitSourceTo(source.id, 'cam')}>
                  fit camera
                </Button>
              </Tooltip>
            )}
          </div>
        )}
        {sections.includes('device') && <CameraPick />}
        {sections.includes('move') && <p className="text-xs text-textTertiary">drag it on the preview to move it</p>}
      </div>
      {sections.includes('look') && (
        <div id="source-look" className="border-t border-primaryStroke">
          <p className={SECTION_HEAD}>look</p>
          <AvatarLookSettings source={source} />
        </div>
      )}
      {sections.includes('model') && (
        <div id="source-model" className="border-t border-primaryStroke">
          <p className={SECTION_HEAD}>model</p>
          <ModelControls onChange={onModel} />
        </div>
      )}
      {sections.includes('rigging') && (
        <div id="source-rigging" className="border-t border-primaryStroke">
          <p className={SECTION_HEAD}>rigging</p>
          <Rigging place={place} />
        </div>
      )}
    </div>
  );
}

function SoundSettings({ sound }: { sound: SoundSource }) {
  const playing = useAtomValue(soundPlayingAtom)[sound.id] ?? false;
  const publishing = useAtomValue(isPublishingAtom);
  const status = useAtomValue(soundStatusAtom);
  const percent = Math.round(sound.volume * 100);
  return (
    <div id="source-detail" data-source={sound.id} data-input="sound" className="flex min-w-0 flex-col gap-2 px-3 py-2.5">
      <Header id={sound.id} name={sound.name} kind={INPUT_WORDS.sound} onRename={(next) => renameSound(sound.id, next)} />
      <div className="flex flex-wrap gap-1.5">
        <Button
          id="sound-play"
          size="sm"
          variant="outline"
          aria-pressed={playing}
          className="gap-1.5"
          onClick={() => (playing ? stopSound(sound.id) : void playSound(sound.id))}
        >
          {playing ? <RiStopFill aria-hidden size={14} /> : <RiPlayFill aria-hidden size={14} />}
          {playing ? 'stop' : 'play'}
        </Button>
        <Tooltip content={sound.loop ? 'plays over and over. click to play once' : 'plays once. click to loop it'}>
          <Button id="sound-loop" size="sm" aria-pressed={sound.loop} className={cn(sound.loop && PRESSED)} onClick={() => setSoundLoop(sound.id, !sound.loop)}>
            loop
          </Button>
        </Tooltip>
        <Tooltip content={sound.hear ? 'you hear it here too. click to send it to the stream only' : 'only the stream gets it. click to hear it here too'}>
          <Button id="sound-hear" size="sm" aria-pressed={sound.hear} className={cn(sound.hear && PRESSED)} onClick={() => setSoundHear(sound.id, !sound.hear)}>
            hear it
          </Button>
        </Tooltip>
      </div>
      <div className="flex min-w-0 items-center gap-2 text-sm">
        <RiVolumeUpLine aria-hidden size={16} className="shrink-0 text-textTertiary" />
        <Tooltip content={`${percent}%`}>
          <input
            id="sound-volume"
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={sound.volume}
            aria-label="volume"
            aria-valuetext={`${percent}%`}
            onChange={(e) => setSoundVolume(sound.id, e.target.valueAsNumber)}
            className="h-1 min-w-0 flex-1 accent-primaryBlue"
          />
        </Tooltip>
        <span className="w-9 shrink-0 text-right text-xs tabular-nums text-textTertiary">{percent}%</span>
      </div>
      <p id="sound-note" className="flex items-center gap-1.5 text-xs text-textTertiary">
        <RiMusic2Line aria-hidden size={12} className="shrink-0" />
        {publishing ? 'it plays into the stream, with its own fader under sound' : 'it goes into the stream once you are live'}
      </p>
      {status && (
        <p id="sound-status" className="text-xs text-decrease" aria-live="polite">
          {status}
        </p>
      )}
    </div>
  );
}

export function SourceSettings({ place, onModel }: { place: Place; onModel: () => void }) {
  const sources = useAtomValue(sourcesAtom);
  const sounds = useAtomValue(soundsAtom);
  const selectedId = useAtomValue(selectedSourceAtom);
  const panels = useAtomValue(livePanelsAtom);
  const sound = sounds.find((s) => s.id === selectedId);
  if (sound) return <SoundSettings sound={sound} />;
  const listGone = place !== 'phone' && panels.hidden.includes('sources');
  const source = sources.find((s) => s.id === selectedId) ?? (listGone ? sources.find((s) => s.kind === 'camera' || s.kind === 'avatar') : undefined);
  if (!source)
    return (
      <p id="source-none" className="px-3 py-2.5 text-xs text-textTertiary">
        pick a source to set it up
      </p>
    );
  return <VisualSettings key={source.id} source={source} place={place} onModel={onModel} />;
}
