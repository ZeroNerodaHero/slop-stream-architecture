import { RiMusic2Line, RiPencilLine, RiPlayFill, RiStopFill, RiVidiconLine, RiVolumeUpLine } from '@remixicon/react';
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
  screenStreamAtom,
  selectedSourceAtom,
  setCamera,
  setScreenCap,
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
import { capOf, SCREEN_CAP_WORDS, SCREEN_CAPS, type ScreenCap } from '@/infra/screen-cap';
import { INPUT_WORDS, inputKindOf, SOURCE_NAME_MAX, type SoundSource, sectionsOf } from '@/infra/source-settings';
import { Button } from '@/shared-components/Button';
import { AvatarLookSettings } from '@/shared-components/live/AvatarLookSettings';
import { FOLD_BUTTON } from '@/shared-components/live/Dock';
import { INPUT } from '@/shared-components/input';
import { DevicePick } from '@/shared-components/live/DevicePick';
import { ModelControls } from '@/shared-components/live/ModelControls';
import { Rigging } from '@/shared-components/live/Rigging';
import { Segmented } from '@/shared-components/Segmented';
import { TextSettings } from '@/shared-components/live/TextSettings';
import { ChatOverlaySettings } from '@/shared-components/live/ChatOverlaySettings';
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
        ? 'remove (the upload stays saved)'
        : source.kind === 'avatar'
          ? 'remove (the + brings it back)'
          : source.kind === 'text' || source.kind === 'chat'
            ? 'remove'
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

export interface SourceHead {
  id: string;
  name: string;
  kind: string;
  rename: (name: string) => void;
}

type Picked = { sound: SoundSource; source?: undefined } | { source: Source; sound?: undefined } | null;

function usePicked(place: Place): Picked {
  const sources = useAtomValue(sourcesAtom);
  const sounds = useAtomValue(soundsAtom);
  const selectedId = useAtomValue(selectedSourceAtom);
  const panels = useAtomValue(livePanelsAtom);
  const sound = sounds.find((s) => s.id === selectedId);
  if (sound) return { sound };
  const listGone = place !== 'phone' && panels.hidden.includes('sources');
  const source = sources.find((s) => s.id === selectedId) ?? (listGone ? sources.find((s) => s.kind === 'camera' || s.kind === 'avatar') : undefined);
  return source ? { source } : null;
}

export function useSourceHead(place: Place): SourceHead | null {
  const picked = usePicked(place);
  const model = useAtomValue(modelAtom);
  const names = useAtomValue(sourceNamesAtom);
  if (!picked) return null;
  if (picked.sound) {
    const sound = picked.sound;
    return { id: sound.id, name: sound.name, kind: INPUT_WORDS.sound, rename: (next) => renameSound(sound.id, next) };
  }
  const source = picked.source;
  const label = sourceNameOf(source, model, names);
  const input = inputKindOf(source.kind, source.kind === 'camera' && model !== null);
  return { id: source.id, name: label.name, kind: INPUT_WORDS[input], rename: (next) => renameSource(label, next) };
}

export function SourceTitle({ head, editing, onDone }: { head: SourceHead; editing: boolean; onDone: () => void }) {
  return (
    <>
      {editing ? (
        <NameEdit
          id={`source-detail-name-${head.id}`}
          name={head.name}
          onSave={(next) => {
            head.rename(next);
            onDone();
          }}
          onCancel={onDone}
          className="font-normal normal-case tracking-normal"
        />
      ) : (
        <span id="source-detail-name" className="min-w-0 truncate">
          {head.name}
        </span>
      )}
      {head.kind !== head.name && (
        <span id="source-detail-kind" className="shrink-0 font-normal normal-case tracking-normal text-textTertiary">
          {head.kind}
        </span>
      )}
    </>
  );
}

export function RenameButton({ onClick }: { onClick: () => void }) {
  return (
    <Tooltip content="rename">
      <button id="source-detail-rename" type="button" aria-label="rename" onClick={onClick} className={cn(FOLD_BUTTON, 'h-6 w-6')}>
        <RiPencilLine aria-hidden size={14} />
      </button>
    </Tooltip>
  );
}

function InlineHead({ head }: { head: SourceHead }) {
  const [editing, setEditing] = useState(false);
  return (
    <div id="source-detail-head" className="flex min-h-7 min-w-0 items-center gap-2 text-xs font-semibold uppercase tracking-wider text-textSecondary">
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <SourceTitle head={head} editing={editing} onDone={() => setEditing(false)} />
      </span>
      {!editing && <RenameButton onClick={() => setEditing(true)} />}
    </div>
  );
}

const refreshCameras = () => void refreshFaceCameras();
const CAP_OPTIONS = SCREEN_CAPS.map((value) => ({ value, label: SCREEN_CAP_WORDS[value] }));

const SIZE_POLL_MS = 1000;

function sizeOf(track: MediaStreamTrack | undefined): string {
  const { width, height } = track?.readyState === 'live' ? track.getSettings() : {};
  return width && height ? `${width}×${height}` : '';
}

function useScreenSize(slot: number): string {
  const track = useAtomValue(screenStreamAtom(slot))?.getVideoTracks()[0];
  const [seen, setSeen] = useState(() => ({ track, size: sizeOf(track) }));
  useEffect(() => {
    if (!track) return;
    const read = () => setSeen({ track, size: sizeOf(track) });
    const timer = setInterval(read, SIZE_POLL_MS);
    return () => clearInterval(timer);
  }, [track]);
  return seen.track === track ? seen.size : sizeOf(track);
}

function ScreenResolution({ source }: { source: Source }) {
  const size = useScreenSize((source.slot ?? 0) - 1);
  return (
    <div id="source-resolution" className="flex min-w-0 flex-col gap-1.5">
      <span className="flex min-w-0 items-center gap-2 text-xs">
        <span className="flex-1 text-textSecondary">resolution</span>
        {size && (
          <Tooltip content="what the screen is captured at now">
            <span id="source-resolution-size" tabIndex={0} className="tabular-nums text-textTertiary outline-none focus-visible:text-textPrimary">
              {size}
            </span>
          </Tooltip>
        )}
      </span>
      <Segmented<ScreenCap>
        id="source-resolution-cap"
        label="screen resolution cap"
        options={CAP_OPTIONS}
        value={capOf(source.cap)}
        onChange={(cap) => setScreenCap(source.id, cap)}
        className="w-full"
      />
    </div>
  );
}

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

function VisualSettings({ source, place, head, onModel }: { source: Source; place: Place; head: SourceHead | null; onModel: () => void }) {
  const hasCamera = useAtomValue(sourcesAtom).some((s) => s.kind === 'camera');
  const { worn, fill } = useSourceFacts(source);
  const input = inputKindOf(source.kind, worn);
  const sections = sectionsOf(input);
  const fits = sections.includes('fill') || (sections.includes('fitCamera') && hasCamera);
  const top = head !== null || fits || sections.includes('device') || sections.includes('resolution');
  return (
    <div id="source-detail" data-source={source.id} data-input={input} className="flex min-w-0 flex-col">
      {top && (
        <div className="flex min-w-0 flex-col gap-2 px-3 py-2.5">
          {head && <InlineHead head={head} />}
          {fits && (
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
          {sections.includes('resolution') && <ScreenResolution source={source} />}
          {sections.includes('device') && <CameraPick />}
        </div>
      )}
      {sections.includes('text') && <TextSettings source={source} />}
      {sections.includes('chat') && <ChatOverlaySettings source={source} />}
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

function SoundSettings({ sound, head }: { sound: SoundSource; head: SourceHead | null }) {
  const playing = useAtomValue(soundPlayingAtom)[sound.id] ?? false;
  const publishing = useAtomValue(isPublishingAtom);
  const status = useAtomValue(soundStatusAtom);
  const percent = Math.round(sound.volume * 100);
  return (
    <div id="source-detail" data-source={sound.id} data-input="sound" className="flex min-w-0 flex-col gap-2 px-3 py-2.5">
      {head && <InlineHead head={head} />}
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

export function SourceSettings({ place, inline = false, onModel }: { place: Place; inline?: boolean; onModel: () => void }) {
  const picked = usePicked(place);
  const head = useSourceHead(place);
  const shown = inline || place === 'phone' ? head : null;
  if (picked?.sound) return <SoundSettings key={picked.sound.id} sound={picked.sound} head={shown} />;
  if (!picked)
    return (
      <p id="source-none" className="px-3 py-2.5 text-xs text-textTertiary">
        pick a source to set it up
      </p>
    );
  return <VisualSettings key={picked.source.id} source={picked.source} place={place} head={shown} onModel={onModel} />;
}
