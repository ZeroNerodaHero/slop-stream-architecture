import {
  RiAddLine,
  RiCloseLine,
  RiComputerLine,
  RiEyeLine,
  RiEyeOffLine,
  RiImageLine,
  RiMusic2Line,
  RiUserSmileLine,
  RiUserVoiceLine,
  RiVidiconLine
} from '@remixicon/react';
import { type Atom, useAtomValue } from 'jotai';
import { type CSSProperties, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { api } from '@/infra/api';
import { myAvatarVersionAtom } from '@/infra/atoms/profile-atoms';
import {
  addAvatar,
  addImage,
  cameraAtom,
  cameraOn,
  canShareScreenAtom,
  deleteImage,
  hasAvatarAtom,
  hasCameraAtom,
  libraryAtom,
  modelAtom,
  modelLoadingAtom,
  moveSourceTo,
  placeImage,
  publishPhaseAtom,
  removeSource,
  screenShareSupported,
  screenStreamAtom,
  selectedSourceAtom,
  selectSource,
  shareScreen,
  sourceStatusAtom,
  sourcesAtom,
  startMic,
  streamNameAtom,
  toggleSource
} from '@/infra/atoms/publish-atoms';
import {
  addSound,
  removeSound,
  renameSound,
  renameSource,
  soundPlayingAtom,
  soundsAtom,
  soundStatusAtom,
  sourceNamesAtom,
  sourceNameOf
} from '@/infra/atoms/source-atoms';
import { livePanelsAtom, type Place } from '@/infra/live-dock';
import { SCREEN_SLOTS } from '@/infra/relay';
import type { Source } from '@/infra/scene';
import { SOUND_MAX_BYTES, SOUNDS_MAX, type SoundSource } from '@/infra/source-settings';
import { Button, buttonClassName } from '@/shared-components/Button';
import { Face } from '@/shared-components/Face';
import { ICON_BUTTON } from '@/shared-components/live/Collapsible';
import { DockPanel } from '@/shared-components/live/Dock';
import { NameEdit, SourceSettings, useSourceFacts } from '@/shared-components/live/SourceSettings';
import { DragHandle, type DragHandleProps, useReorder } from '@/shared-components/Reorderable';
import { Tooltip } from '@/shared-components/Tooltip';
import { VideoFrame } from '@/shared-components/VideoFrame';
import { cn } from '@/utils/cn';

const ROW = 'relative flex h-11 w-full min-w-0 items-center gap-2 border-l-2 pl-0.5 pr-1 text-left text-sm leading-tight transition-colors duration-150';
const THUMB = 'flex h-7 w-12 shrink-0 items-center justify-center rounded-control border border-primaryStroke bg-black';
const ROW_ON = 'border-primaryBlue bg-backgroundTertiary text-textPrimary';
const ROW_OFF = 'border-transparent text-textSecondary hover:bg-backgroundTertiary/60 hover:text-textPrimary';
const MENU_ITEM =
  'flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-textSecondary transition-colors duration-150 hover:bg-backgroundTertiary hover:text-textPrimary focus-visible:bg-backgroundTertiary focus-visible:text-textPrimary focus-visible:outline-none disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-textSecondary';

function Thumb({ id, streamAtom }: { id: string; streamAtom: Atom<MediaStream | null> }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  return <VideoFrame id={id} streamAtom={streamAtom} videoRef={ref} muted className="h-7 w-12 shrink-0 rounded-control border-primaryStroke object-cover" />;
}

function AddMenu({ onModel }: { onModel: () => void }) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<CSSProperties | null>(null);
  const root = useRef<HTMLDivElement | null>(null);
  const button = useRef<HTMLButtonElement | null>(null);
  const menu = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const soundRef = useRef<HTMLInputElement | null>(null);
  const soundCount = useAtomValue(soundsAtom).length;
  const canShare = useAtomValue(canShareScreenAtom);
  const hasCamera = useAtomValue(hasCameraAtom);
  const hasAvatar = useAtomValue(hasAvatarAtom);
  const library = useAtomValue(libraryAtom);
  const name = useAtomValue(streamNameAtom);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      const at = e.target as Node;
      if (!root.current?.contains(at) && !menu.current?.contains(at)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onMove = () => setOpen(false);
    window.addEventListener('pointerdown', onPointer);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onMove);
    return () => {
      window.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onMove);
    };
  }, [open]);

  useLayoutEffect(() => {
    const at = button.current;
    const box = menu.current;
    if (!open || !at || !box) {
      setPlace(null);
      return;
    }
    const r = at.getBoundingClientRect();
    const h = box.offsetHeight;
    const w = box.offsetWidth;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
    const below = window.innerHeight - r.bottom - 4;
    setPlace(below >= h || below >= r.top ? { left, top: r.bottom + 4 } : { left, top: Math.max(8, r.top - 4 - h) });
  }, [open, library.length]);

  return (
    <div ref={root} className="px-2 py-2">
      <button
        ref={button}
        id="add-source"
        type="button"
        aria-expanded={open}
        aria-haspopup="menu"
        aria-controls="add-source-menu"
        onClick={() => setOpen((v) => !v)}
        className={buttonClassName('secondary', cn('gap-1.5', open && 'border-primaryBlue text-primaryBlue'), 'sm')}
      >
        <RiAddLine aria-hidden size={16} />
        add a source
      </button>
      {open &&
        createPortal(
          <div
            ref={menu}
            id="add-source-menu"
            role="menu"
            aria-label="add a source"
            style={place ?? { left: 0, top: 0, visibility: 'hidden' }}
            className="fixed z-[70] w-56 overflow-hidden rounded-panel border border-primaryStroke bg-backgroundSecondary py-1 text-textPrimary"
          >
            {!hasCamera && (
              <button
                id="add-camera"
                role="menuitem"
                type="button"
                className={MENU_ITEM}
                onClick={() => {
                  setOpen(false);
                  void cameraOn();
                }}
              >
                <RiVidiconLine aria-hidden size={16} /> camera
              </button>
            )}
            <button
              id="add-model"
              role="menuitem"
              type="button"
              className={MENU_ITEM}
              onClick={() => {
                setOpen(false);
                onModel();
              }}
            >
              <RiUserSmileLine aria-hidden size={16} /> model
            </button>
            <button
              id="add-avatar"
              role="menuitem"
              type="button"
              disabled={hasAvatar}
              className={MENU_ITEM}
              onClick={() => {
                setOpen(false);
                addAvatar();
              }}
            >
              <RiUserVoiceLine aria-hidden size={16} /> avatar
            </button>
            {screenShareSupported && (
              <button
                id="add-screen"
                role="menuitem"
                type="button"
                disabled={!canShare}
                className={MENU_ITEM}
                onClick={() => {
                  setOpen(false);
                  void shareScreen();
                }}
              >
                <RiComputerLine aria-hidden size={16} /> screen or window
                {!canShare && <span className="ml-auto text-xs text-textTertiary">{SCREEN_SLOTS} at most</span>}
              </button>
            )}
            <button
              id="add-image"
              role="menuitem"
              type="button"
              className={MENU_ITEM}
              onClick={() => {
                setOpen(false);
                fileRef.current?.click();
              }}
            >
              <RiImageLine aria-hidden size={16} /> image or gif
            </button>
            <button
              id="add-sound"
              role="menuitem"
              type="button"
              disabled={soundCount >= SOUNDS_MAX}
              className={MENU_ITEM}
              onClick={() => {
                setOpen(false);
                soundRef.current?.click();
              }}
            >
              <RiMusic2Line aria-hidden size={16} /> custom sound
              {soundCount >= SOUNDS_MAX && <span className="ml-auto text-xs text-textTertiary">{SOUNDS_MAX} at most</span>}
            </button>
            {library.length > 0 && (
              <div className="border-t border-primaryStroke px-3 pb-1 pt-2">
                <p className="mb-1.5 text-xs text-textTertiary">your pictures</p>
                <ul className="flex list-none flex-wrap gap-1.5 p-0">
                  {library.map((asset) => (
                    <li key={asset.id} className="group/pic relative">
                      <button
                        id={`library-${asset.id}`}
                        type="button"
                        aria-label="put this picture on the stream"
                        className="block h-10 w-14 overflow-hidden rounded-control border border-primaryStroke bg-black transition-colors duration-150 hover:border-primaryBlue focus-visible:border-primaryBlue focus-visible:outline-none"
                        onClick={() => {
                          setOpen(false);
                          void placeImage(asset.id, 'picture');
                        }}
                      >
                        <img src={api.assetUrl(name, asset.id)} alt="" draggable={false} className="h-full w-full object-contain" />
                      </button>
                      <Tooltip content="delete this picture">
                        <button
                          id={`library-delete-${asset.id}`}
                          type="button"
                          aria-label="delete this picture"
                          className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-avatar border border-primaryStroke bg-backgroundSecondary text-textSecondary opacity-0 transition-opacity duration-150 hover:border-decrease hover:text-decrease focus-visible:opacity-100 focus-visible:outline-none group-hover/pic:opacity-100"
                          onClick={() => void deleteImage(asset.id)}
                        >
                          <RiCloseLine aria-hidden size={10} />
                        </button>
                      </Tooltip>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>,
          document.body
        )}
      <input
        ref={fileRef}
        id="image-file"
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void addImage(file);
        }}
      />
      <input
        ref={soundRef}
        id="sound-file"
        type="file"
        accept="audio/*,.mp3,.wav,.ogg,.oga,.opus,.m4a,.aac,.flac,.webm"
        aria-label={`a sound file, ${SOUND_MAX_BYTES / (1024 * 1024)} MB at most`}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void addSound(file);
        }}
      />
    </div>
  );
}

interface RowProps {
  source: Source;
  handle: DragHandleProps;
  item: { 'data-reorder-item': string };
}

function SourceThumb({ source }: { source: Source }) {
  const streamAtom = source.kind === 'camera' ? cameraAtom : screenStreamAtom((source.slot ?? 1) - 1);
  const name = useAtomValue(streamNameAtom);
  const avatar = useAtomValue(myAvatarVersionAtom);
  if (source.kind === 'image')
    return (
      <img
        src={api.assetUrl(name, source.asset ?? 0)}
        alt=""
        draggable={false}
        className="h-7 w-12 shrink-0 rounded-control border border-primaryStroke bg-black object-contain"
      />
    );
  if (source.kind === 'avatar')
    return <Face name={name} version={avatar} className="h-7 w-12 shrink-0 rounded-control border border-primaryStroke bg-backgroundSecondary object-cover text-xs" />;
  return <Thumb id={`source-${source.id}-video`} streamAtom={streamAtom} />;
}

interface RowFrameProps {
  id: string;
  name: string;
  off?: boolean;
  thumb: ReactNode;
  start: ReactNode;
  removeLabel: string;
  removeWords: string;
  canRemove: boolean;
  onRemove: () => void;
  onRename: (name: string) => void;
  onToggle?: () => void;
  item?: { 'data-reorder-item': string };
}

function RowFrame({ id, name, off = false, thumb, start, removeLabel, removeWords, canRemove, onRemove, onRename, onToggle, item }: RowFrameProps) {
  const selected = useAtomValue(selectedSourceAtom) === id;
  const [editing, setEditing] = useState(false);
  return (
    <li {...item} data-source={id} className={cn(ROW, selected ? ROW_ON : ROW_OFF)}>
      {start}
      {editing ? (
        <span className="flex h-full min-w-0 flex-1 items-center gap-2">
          {thumb}
          <NameEdit
            id={`source-rename-${id}`}
            name={name}
            onSave={(next) => {
              onRename(next);
              setEditing(false);
            }}
            onCancel={() => setEditing(false)}
          />
        </span>
      ) : (
        <button
          id={`source-${id}`}
          type="button"
          aria-pressed={selected}
          aria-keyshortcuts="F2"
          onClick={() => selectSource(id)}
          onDoubleClick={() => setEditing(true)}
          onKeyDown={(e) => {
            if (e.key !== 'F2') return;
            e.preventDefault();
            setEditing(true);
          }}
          className={cn('flex h-full min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-none', off && 'opacity-60')}
        >
          {thumb}
          <span data-source-name className="min-w-0 flex-1 truncate font-medium">
            {name}
          </span>
          {off && <span className="sr-only">, off the stream</span>}
        </button>
      )}
      {onToggle ? (
        <Tooltip content={off ? 'show' : 'hide'}>
          <button id={`source-eye-${id}`} type="button" aria-label={off ? 'show' : 'hide'} aria-pressed={off} onClick={onToggle} className={ICON_BUTTON}>
            {off ? <RiEyeOffLine aria-hidden size={16} /> : <RiEyeLine aria-hidden size={16} />}
          </button>
        </Tooltip>
      ) : (
        <span aria-hidden className="w-7 shrink-0" />
      )}
      <Tooltip content={removeWords}>
        <button
          id={`source-remove-${id}`}
          type="button"
          aria-label={removeLabel}
          disabled={!canRemove}
          onClick={onRemove}
          className={cn(ICON_BUTTON, 'hover:border-decrease hover:text-decrease focus-visible:border-decrease focus-visible:text-decrease')}
        >
          <RiCloseLine aria-hidden size={16} />
        </button>
      </Tooltip>
    </li>
  );
}

function Row({ source, handle, item }: RowProps) {
  const model = useAtomValue(modelAtom);
  const names = useAtomValue(sourceNamesAtom);
  const label = sourceNameOf(source, model, names);
  const { canRemove, removeWords, removeLabel } = useSourceFacts(source);
  return (
    <RowFrame
      id={source.id}
      name={label.name}
      off={!source.shown}
      thumb={<SourceThumb source={source} />}
      start={<DragHandle id={`source-drag-${source.id}`} {...handle} />}
      removeLabel={removeLabel}
      removeWords={removeWords}
      canRemove={canRemove}
      onRemove={() => removeSource(source.id)}
      onRename={(next) => renameSource(label, next)}
      onToggle={() => toggleSource(source.id)}
      item={item}
    />
  );
}

function SoundRow({ sound }: { sound: SoundSource }) {
  const playing = useAtomValue(soundPlayingAtom)[sound.id] ?? false;
  return (
    <RowFrame
      id={sound.id}
      name={sound.name}
      thumb={
        <span className={cn(THUMB, playing ? 'text-primaryBlue' : 'text-textTertiary')}>
          <RiMusic2Line aria-hidden size={14} />
        </span>
      }
      start={<span aria-hidden className="w-[22px] shrink-0" />}
      removeLabel="remove this sound"
      removeWords="remove this sound"
      canRemove
      onRemove={() => void removeSound(sound.id)}
      onRename={(next) => renameSound(sound.id, next)}
    />
  );
}

function SourceList({ sources, sounds }: { sources: Source[]; sounds: SoundSource[] }) {
  const byId = new Map(sources.map((s) => [s.id, s]));
  const model = useAtomValue(modelAtom);
  const names = useAtomValue(sourceNamesAtom);
  const sourceLabel = (s: Source | undefined) => (s ? sourceNameOf(s, model, names).name : 'source');
  const reorder = useReorder({
    keys: [...sources].reverse().map((s) => s.id),
    name: (id) => sourceLabel(byId.get(id)),
    onMove: (id, row) => moveSourceTo(id, sources.length - 1 - row),
    live: true,
    onPickUp: selectSource
  });

  return (
    <div className="relative">
      {sources.length > 0 && (
        <ul id="source-list" {...reorder.list} className={cn('m-0 list-none divide-y divide-primaryStroke p-0', reorder.held && 'cursor-grabbing')}>
          {reorder.order.map((id) => {
            const source = byId.get(id);
            return source && <Row key={id} source={source} handle={reorder.handle(id)} item={reorder.item(id)} />;
          })}
        </ul>
      )}
      {sounds.length > 0 && (
        <ul id="sound-list" aria-label="sounds" className={cn('m-0 list-none divide-y divide-primaryStroke p-0', sources.length > 0 && 'border-t border-primaryStroke')}>
          {sounds.map((sound) => (
            <SoundRow key={sound.id} sound={sound} />
          ))}
        </ul>
      )}
      {reorder.status}
    </div>
  );
}

function SourcesBody({ onModel, place, inline }: { onModel: () => void; place: Place; inline: boolean }) {
  const sources = useAtomValue(sourcesAtom);
  const sounds = useAtomValue(soundsAtom);
  const status = useAtomValue(sourceStatusAtom);
  const soundStatus = useAtomValue(soundStatusAtom);
  const phase = useAtomValue(publishPhaseAtom);
  const modelLoading = useAtomValue(modelLoadingAtom);
  const cameraRefused = phase === 'camera-blocked' || phase === 'no-camera';
  const micRefused = phase === 'mic-blocked' || phase === 'no-mic';
  return (
    <div id="sources" className="min-w-0">
      {sources.length === 0 && (
        <div className="px-3 py-3 text-sm text-textTertiary">
          <p>
            {modelLoading ? 'your model shows up here once it is on' : micRefused ? 'the mic shows up here once it is on' : 'the camera shows up here once it is on'}
          </p>
          {cameraRefused && (
            <Button id="mic-only" size="sm" variant="outline" className="mt-2" onClick={() => void startMic()}>
              go mic only: your avatar, moving with your voice
            </Button>
          )}
          {micRefused && (
            <Button id="use-camera" size="sm" variant="outline" className="mt-2" onClick={() => void cameraOn()}>
              use the camera instead
            </Button>
          )}
        </div>
      )}
      {(sources.length > 0 || sounds.length > 0) && <SourceList sources={sources} sounds={sounds} />}
      <AddMenu onModel={onModel} />
      {(status || soundStatus) && (
        <p id="source-status" className="px-3 pb-2 text-xs text-textSecondary" aria-live="polite">
          {status || soundStatus}
        </p>
      )}
      {inline && (
        <div id="source-inline" className="border-t border-primaryStroke">
          <SourceSettings place={place} onModel={onModel} />
        </div>
      )}
    </div>
  );
}

export function SourcesModule({ place, onModel }: { place: Place; onModel: () => void }) {
  const count = useAtomValue(sourcesAtom).length + useAtomValue(soundsAtom).length;
  const panels = useAtomValue(livePanelsAtom);
  const inline = place === 'phone' || panels.hidden.includes('source');
  return (
    <DockPanel tab="sources" place={place} count={count || undefined}>
      <SourcesBody onModel={onModel} place={place} inline={inline} />
    </DockPanel>
  );
}
