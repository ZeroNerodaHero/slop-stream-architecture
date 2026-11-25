import {
  RiAddLine,
  RiAspectRatioLine,
  RiCloseLine,
  RiComputerLine,
  RiEyeLine,
  RiEyeOffLine,
  RiFocus3Line,
  RiImageLine,
  RiUserSmileLine,
  RiUserVoiceLine,
  RiVidiconLine
} from '@remixicon/react';
import { type Atom, useAtomValue } from 'jotai';
import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { api } from '@/infra/api';
import { myAvatarVersionAtom } from '@/infra/atoms/profile-atoms';
import {
  addAvatar,
  addImage,
  cameraAtom,
  cameraDeviceAtom,
  cameraOn,
  canShareScreenAtom,
  deleteImage,
  faceCamerasAtom,
  fitSourceTo,
  hasAvatarAtom,
  hasCameraAtom,
  hasMicAtom,
  libraryAtom,
  modelAtom,
  modelLoadingAtom,
  moveSourceTo,
  placeImage,
  publishPhaseAtom,
  refreshFaceCameras,
  removeSource,
  screenShareSupported,
  screenStreamAtom,
  selectedSourceAtom,
  selectSource,
  setCamera,
  setSourceFit,
  shareScreen,
  sourceStatusAtom,
  sourcesAtom,
  startMic,
  streamNameAtom,
  toggleSource
} from '@/infra/atoms/publish-atoms';
import type { Place } from '@/infra/live-dock';
import { SCREEN_SLOTS } from '@/infra/relay';
import type { Source } from '@/infra/scene';
import { Button, buttonClassName } from '@/shared-components/Button';
import { Face } from '@/shared-components/Face';
import { ICON_BUTTON } from '@/shared-components/live/Collapsible';
import { DevicePick } from '@/shared-components/live/DevicePick';
import { DockPanel } from '@/shared-components/live/Dock';
import { DragHandle, type DragHandleProps, useReorder } from '@/shared-components/Reorderable';
import { Tooltip } from '@/shared-components/Tooltip';
import { VideoFrame } from '@/shared-components/VideoFrame';
import { cn } from '@/utils/cn';

const ROW = 'group/row relative flex h-11 w-full min-w-0 items-center gap-2 border-l-2 pl-0.5 pr-1 text-left text-sm leading-tight transition-colors duration-150';
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
            className="fixed z-[60] w-56 overflow-hidden rounded-panel border border-primaryStroke bg-backgroundSecondary py-1 text-textPrimary"
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
    </div>
  );
}

const ICONS = { camera: RiVidiconLine, screen: RiComputerLine, image: RiImageLine, avatar: RiUserVoiceLine } as const;
const KINDS = { camera: 'camera', screen: 'screen', image: 'picture', avatar: 'avatar' } as const;

function useSourceFacts(source: Source) {
  const hasMic = useAtomValue(hasMicAtom);
  const model = useAtomValue(modelAtom);
  const worn = source.kind === 'camera' ? model : null;
  const label = worn ? worn.name : source.label;
  const kind = worn ? 'model' : KINDS[source.kind];
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
  return { worn, label, kind, fill, canRemove, removeWords, removeLabel };
}

interface RowProps {
  source: Source;
  hasCamera: boolean;
  handle: DragHandleProps;
  item: { 'data-reorder-item': string };
}

function Row({ source, hasCamera, handle, item }: RowProps) {
  const selected = useAtomValue(selectedSourceAtom) === source.id;
  const streamAtom = source.kind === 'camera' ? cameraAtom : screenStreamAtom((source.slot ?? 1) - 1);
  const name = useAtomValue(streamNameAtom);
  const avatar = useAtomValue(myAvatarVersionAtom);
  const { worn, label, kind, fill, canRemove, removeWords, removeLabel } = useSourceFacts(source);
  const Icon = worn ? RiUserSmileLine : ICONS[source.kind];
  return (
    <li {...item} className={cn(ROW, selected ? ROW_ON : ROW_OFF)}>
      <DragHandle id={`source-drag-${source.id}`} {...handle} />
      <button
        id={`source-${source.id}`}
        type="button"
        aria-pressed={selected}
        onClick={() => selectSource(source.id)}
        className={cn('flex h-full min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-none', !source.shown && 'opacity-60')}
      >
        {source.kind === 'image' ? (
          <img src={api.assetUrl(name, source.asset ?? 0)} alt="" draggable={false} className="h-7 w-12 shrink-0 rounded-control border border-primaryStroke bg-black object-contain" />
        ) : source.kind === 'avatar' ? (
          <span className="flex h-7 w-12 shrink-0 items-center justify-center rounded-control border border-primaryStroke bg-black">
            <Face name={name} version={avatar} className="h-6 w-6 text-xs" />
          </span>
        ) : (
          <Thumb id={`source-${source.id}-video`} streamAtom={streamAtom} />
        )}
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span id={worn ? 'source-model-name' : undefined} className="truncate font-medium">
            {label}
          </span>
          <span className="flex min-w-0 items-center gap-1 text-xs text-textTertiary">
            <Icon aria-hidden size={12} className="shrink-0" />
            <span className="truncate">{source.shown ? kind : `${kind} · off the stream`}</span>
          </span>
        </span>
      </button>
      <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center gap-0.5 bg-backgroundTertiary pl-1 pr-1 opacity-0 transition-opacity duration-150 focus-within:pointer-events-auto focus-within:opacity-100 group-hover/row:pointer-events-auto group-hover/row:opacity-100">
        <Tooltip
          content={
            source.shown ? (source.kind === 'image' ? 'on the stream. click to hide it' : 'on the stream. click to put it beside') : 'off the stream. click to put it on'
          }
        >
          <button
            id={`source-hide-${source.id}`}
            type="button"
            aria-pressed={!source.shown}
            aria-label={source.shown ? 'take it off the stream' : 'put it on the stream'}
            onClick={() => toggleSource(source.id)}
            className={ICON_BUTTON}
          >
            {source.shown ? <RiEyeLine aria-hidden size={16} /> : <RiEyeOffLine aria-hidden size={16} />}
          </button>
        </Tooltip>
        {(source.kind === 'camera' || source.kind === 'screen') && (
          <Tooltip content={fill ? 'fills its box. click to show the whole picture' : 'the whole picture. click to fill its box'}>
            <button
              id={`source-fit-${source.id}`}
              type="button"
              aria-label={fill ? 'show the whole picture' : 'fill the box'}
              onClick={() => setSourceFit(source.id, fill ? 'contain' : 'cover')}
              className={ICON_BUTTON}
            >
              <RiAspectRatioLine aria-hidden size={16} />
            </button>
          </Tooltip>
        )}
        {source.kind === 'image' && hasCamera && (
          <Tooltip content="fit to the camera: the same box, just over it (a border)">
            <button
              id={`source-fit-camera-${source.id}`}
              type="button"
              aria-label="fit to the camera"
              onClick={() => fitSourceTo(source.id, 'cam')}
              className={ICON_BUTTON}
            >
              <RiFocus3Line aria-hidden size={16} />
            </button>
          </Tooltip>
        )}
        <Tooltip content={removeWords}>
          <button
            id={`source-remove-${source.id}`}
            type="button"
            aria-label={removeLabel}
            disabled={!canRemove}
            onClick={() => removeSource(source.id)}
            className={cn(ICON_BUTTON, 'hover:border-decrease hover:text-decrease')}
          >
            <RiCloseLine aria-hidden size={16} />
          </button>
        </Tooltip>
      </span>
    </li>
  );
}

function SourceList({ sources }: { sources: Source[] }) {
  const hasCamera = sources.some((s) => s.kind === 'camera');
  const byId = new Map(sources.map((s) => [s.id, s]));
  const model = useAtomValue(modelAtom);
  const sourceLabel = (s: Source | undefined) => (s?.kind === 'camera' && model ? model.name : (s?.label ?? 'source'));
  const reorder = useReorder({
    keys: [...sources].reverse().map((s) => s.id),
    name: (id) => sourceLabel(byId.get(id)),
    onMove: (id, row) => moveSourceTo(id, sources.length - 1 - row),
    live: true,
    onPickUp: selectSource
  });

  return (
    <div className="relative">
      <ul id="source-list" {...reorder.list} className={cn('m-0 list-none divide-y divide-primaryStroke p-0', reorder.held && 'cursor-grabbing')}>
        {reorder.order.map((id) => {
          const source = byId.get(id);
          return source && <Row key={id} source={source} hasCamera={hasCamera} handle={reorder.handle(id)} item={reorder.item(id)} />;
        })}
      </ul>
      {reorder.status}
    </div>
  );
}

const refreshCameras = () => void refreshFaceCameras();

function CameraPick() {
  const hasCamera = useAtomValue(hasCameraAtom);
  const devices = useAtomValue(faceCamerasAtom);
  const current = useAtomValue(cameraDeviceAtom);
  const model = useAtomValue(modelAtom);
  return (
    <DevicePick
      id="camera-device"
      label={model ? 'the camera that reads your face' : 'the camera that goes out'}
      icon={RiVidiconLine}
      value={current}
      devices={devices}
      fallback="default camera"
      on={hasCamera || model !== null}
      refresh={refreshCameras}
      onPick={(id) => void setCamera(id)}
    />
  );
}

function SourceDetail({ source, hasCamera }: { source: Source; hasCamera: boolean }) {
  const { label, kind, fill, canRemove, removeWords, removeLabel } = useSourceFacts(source);
  return (
    <div id="source-detail" className="flex min-w-0 flex-col gap-2 px-3 py-2.5">
      <p className="flex min-w-0 items-baseline gap-2">
        <span className="truncate text-xs font-semibold uppercase tracking-wider text-textSecondary">{label}</span>
        {kind !== label && <span className="shrink-0 text-xs text-textTertiary">{kind}</span>}
      </p>
      <div className="flex flex-wrap gap-1.5">
        <Button id="source-detail-shown" size="sm" aria-pressed={!source.shown} onClick={() => toggleSource(source.id)}>
          {source.shown ? 'hide' : 'show'}
        </Button>
        {(source.kind === 'camera' || source.kind === 'screen') && (
          <Button id="source-detail-fit" size="sm" onClick={() => setSourceFit(source.id, fill ? 'contain' : 'cover')}>
            {fill ? 'whole picture' : 'fill box'}
          </Button>
        )}
        {source.kind === 'image' && hasCamera && (
          <Button id="source-detail-fit-camera" size="sm" onClick={() => fitSourceTo(source.id, 'cam')}>
            fit camera
          </Button>
        )}
        <Tooltip content={removeWords}>
          <Button id="source-detail-remove" size="sm" variant="outline-danger" disabled={!canRemove} onClick={() => removeSource(source.id)}>
            {removeLabel}
          </Button>
        </Tooltip>
      </div>
      {source.kind === 'camera' && <CameraPick />}
      <p className="text-xs text-textTertiary">drag it on the preview to move it</p>
    </div>
  );
}

function SourcesBody({ onModel, split = false }: { onModel: () => void; split?: boolean }) {
  const sources = useAtomValue(sourcesAtom);
  const selectedId = useAtomValue(selectedSourceAtom);
  const status = useAtomValue(sourceStatusAtom);
  const phase = useAtomValue(publishPhaseAtom);
  const modelLoading = useAtomValue(modelLoadingAtom);
  const cameraRefused = phase === 'camera-blocked' || phase === 'no-camera';
  const micRefused = phase === 'mic-blocked' || phase === 'no-mic';
  const selected = sources.find((s) => s.id === selectedId) ?? null;
  const hasCamera = sources.some((s) => s.kind === 'camera');
  return (
    <div id="sources" className={cn('min-w-0', split && 'grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)]')}>
      <div className={cn('min-w-0', split && 'border-r border-primaryStroke')}>
        {sources.length === 0 ? (
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
        ) : (
          <SourceList sources={sources} />
        )}
        <AddMenu onModel={onModel} />
        {status && (
          <p id="source-status" className="px-3 pb-2 text-xs text-textSecondary" aria-live="polite">
            {status}
          </p>
        )}
      </div>
      {selected ? (
        <div className={cn(!split && 'border-t border-primaryStroke')}>
          <SourceDetail source={selected} hasCamera={hasCamera} />
        </div>
      ) : (
        split && <p className="px-3 py-2.5 text-xs text-textTertiary">pick a source to set it up</p>
      )}
    </div>
  );
}

export function SourcesModule({ place, onModel }: { place: Place; onModel: () => void }) {
  const count = useAtomValue(sourcesAtom).length;
  return (
    <DockPanel tab="sources" place={place} count={count || undefined}>
      <SourcesBody onModel={onModel} />
    </DockPanel>
  );
}
