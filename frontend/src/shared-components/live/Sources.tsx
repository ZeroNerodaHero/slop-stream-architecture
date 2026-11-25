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
import { useEffect, useRef, useState } from 'react';

import { api } from '@/infra/api';
import { myAvatarVersionAtom } from '@/infra/atoms/profile-atoms';
import {
  addAvatar,
  addImage,
  cameraAtom,
  cameraOn,
  canShareScreenAtom,
  canStartAtom,
  deleteImage,
  fitSourceTo,
  goLive,
  hasAvatarAtom,
  hasCameraAtom,
  hasMicAtom,
  isPublishingAtom,
  libraryAtom,
  livePanelsAtom,
  modelAtom,
  modelLoadingAtom,
  moveSourceTo,
  placeImage,
  liveViewersAtom,
  publishMessageAtom,
  publishPhaseAtom,
  publishToneAtom,
  removeSource,
  screenShareSupported,
  screenStreamAtom,
  selectedSourceAtom,
  selectSource,
  setLivePanel,
  setSourceFit,
  shareScreen,
  sourceStatusAtom,
  sourcesAtom,
  startMic,
  stopLive,
  streamNameAtom,
  toggleSource
} from '@/infra/atoms/publish-atoms';
import { openUserModal } from '@/infra/atoms/user-modal-atoms';
import { isValidName } from '@/infra/names';
import { SCREEN_SLOTS } from '@/infra/relay';
import type { Source } from '@/infra/scene';
import { Button } from '@/shared-components/Button';
import { Face } from '@/shared-components/Face';
import { Collapsible, ICON_BUTTON } from '@/shared-components/live/Collapsible';
import { ModelControls } from '@/shared-components/live/ModelControls';
import { ModelDialog } from '@/shared-components/live/ModelDialog';
import { DragHandle, type DragHandleProps, useReorder } from '@/shared-components/Reorderable';
import { Tooltip } from '@/shared-components/Tooltip';
import { VideoFrame } from '@/shared-components/VideoFrame';
import { cn } from '@/utils/cn';
import { ViewerCount } from '@/shared-components/ViewerCount';

const ROW = 'group/row flex h-10 w-full min-w-0 items-center gap-2 border-l-2 pl-0.5 pr-1 text-left text-sm leading-tight transition-colors duration-150';
const ROW_ON = 'border-primaryBlue bg-backgroundTertiary text-textPrimary';
const ROW_OFF = 'border-transparent text-textSecondary hover:bg-backgroundTertiary/60 hover:text-textPrimary';
const MENU_ITEM =
  'flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-textSecondary transition-colors duration-150 hover:bg-backgroundTertiary hover:text-textPrimary focus-visible:bg-backgroundTertiary focus-visible:text-textPrimary focus-visible:outline-none disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-textSecondary';

function Thumb({ id, streamAtom }: { id: string; streamAtom: Atom<MediaStream | null> }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  return <VideoFrame id={id} streamAtom={streamAtom} videoRef={ref} muted className="h-7 w-12 shrink-0 border-primaryStroke object-cover" />;
}

function AddMenu({ onModel }: { onModel: () => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const canShare = useAtomValue(canShareScreenAtom);
  const hasCamera = useAtomValue(hasCameraAtom);
  const hasAvatar = useAtomValue(hasAvatarAtom);
  const library = useAtomValue(libraryAtom);
  const name = useAtomValue(streamNameAtom);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', onPointer);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={root} className="relative mr-1">
      <Tooltip content={open ? null : 'add a source'}>
        <button
          id="add-source"
          type="button"
          aria-label="add a source"
          aria-expanded={open}
          aria-haspopup="menu"
          aria-controls="add-source-menu"
          onClick={() => setOpen((v) => !v)}
          className={cn(ICON_BUTTON, open && 'border-primaryBlue text-primaryBlue')}
        >
          <RiAddLine aria-hidden size={18} />
        </button>
      </Tooltip>
      {open && (
        <div
          id="add-source-menu"
          role="menu"
          aria-label="add a source"
          className="absolute right-0 top-full z-20 mt-1 w-56 overflow-hidden rounded-panel border border-primaryStroke bg-backgroundSecondary py-1"
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
            title="a 3d model in the camera's place, moved by your face"
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
            title={hasAvatar ? 'already a source' : 'your picture, moving with your voice'}
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
              title={canShare ? undefined : '3 screens at most'}
              className={MENU_ITEM}
              onClick={() => {
                setOpen(false);
                void shareScreen();
              }}
            >
              <RiComputerLine aria-hidden size={16} /> screen or window
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
                      className="block h-10 w-14 border border-primaryStroke bg-black transition-colors duration-150 hover:border-primaryBlue focus-visible:border-primaryBlue focus-visible:outline-none"
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
                        className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center border border-primaryStroke bg-backgroundSecondary text-textSecondary opacity-0 transition-opacity duration-150 hover:border-decrease hover:text-decrease focus-visible:opacity-100 focus-visible:outline-none group-hover/pic:opacity-100"
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
        </div>
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
  const hasMic = useAtomValue(hasMicAtom);
  const model = useAtomValue(modelAtom);
  const worn = source.kind === 'camera' ? model : null;
  const label = worn ? worn.name : source.label;
  const Icon = worn ? RiUserSmileLine : ICONS[source.kind];
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
  return (
    <li {...item} className={cn(ROW, selected ? ROW_ON : ROW_OFF)}>
      <DragHandle id={`source-drag-${source.id}`} {...handle} />
      <button
        id={`source-${source.id}`}
        type="button"
        aria-pressed={selected}
        onClick={() => selectSource(source.id)}
        className="flex h-full min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-none"
      >
        {source.kind === 'image' ? (
          <img src={api.assetUrl(name, source.asset ?? 0)} alt="" draggable={false} className="h-7 w-12 shrink-0 border border-primaryStroke bg-black object-contain" />
        ) : source.kind === 'avatar' ? (
          <span className="flex h-7 w-12 shrink-0 items-center justify-center border border-primaryStroke bg-black">
            <Face name={name} version={avatar} className="h-6 w-6 text-xs" />
          </span>
        ) : (
          <Thumb id={`source-${source.id}-video`} streamAtom={streamAtom} />
        )}
        <Icon aria-hidden size={16} className="shrink-0" />
        <span id={worn ? 'source-model-name' : undefined} className="min-w-0 flex-1 truncate">
          {label}
        </span>
      </button>
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
      <span className="flex shrink-0 items-center opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover/row:opacity-100">
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
            aria-label={source.kind === 'screen' ? 'stop sharing' : worn ? 'take the model off' : source.kind === 'camera' ? 'turn the camera off' : 'remove'}
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

export function StartStop({ className = 'flex flex-col gap-2 p-2', status = false }: { className?: string; status?: boolean }) {
  const publishing = useAtomValue(isPublishingAtom);
  const message = useAtomValue(publishMessageAtom);
  const tone = useAtomValue(publishToneAtom);
  const viewers = useAtomValue(liveViewersAtom);
  const canStart = useAtomValue(canStartAtom);
  const canShare = useAtomValue(canShareScreenAtom);
  const named = isValidName(useAtomValue(streamNameAtom));
  return (
    <div className={className}>
      {publishing ? (
        <Button id="stop" variant="danger" className="w-full" onClick={() => stopLive()}>
          stop
        </Button>
      ) : (
        <Button id="start" variant="primary" className="w-full" disabled={!canStart} onClick={() => void goLive()}>
          start
        </Button>
      )}
      {!publishing && !named && (
        <button
          id="pick-name"
          type="button"
          className="text-xs text-textTertiary underline-offset-2 hover:text-textPrimary hover:underline"
          onClick={() => openUserModal('profile')}
        >
          pick a name first
        </button>
      )}
      {publishing && screenShareSupported && (
        <button
          id="share-screen"
          type="button"
          disabled={!canShare}
          title={canShare ? undefined : `${SCREEN_SLOTS} screens at most`}
          className="text-sm font-semibold text-primaryBlue disabled:opacity-40"
          onClick={() => void shareScreen()}
        >
          share screen
        </button>
      )}
      {status && message && (
        <p
          id="status"
          aria-live="polite"
          className={cn('pt-2 text-center text-sm', tone === 'live' ? 'text-increase' : tone === 'bad' ? 'text-decrease' : 'text-textSecondary')}
        >
          {tone === 'live' && <span aria-hidden className="mr-1.5 inline-block h-2 w-2 bg-increase align-middle" />}
          {message}
          {tone === 'live' && viewers !== null && (
            <span className="text-textSecondary">
              {' · '}
              <ViewerCount id="viewers" count={viewers} />
            </span>
          )}
        </p>
      )}
    </div>
  );
}

export function Sources({ startStop = true }: { startStop?: boolean }) {
  const sources = useAtomValue(sourcesAtom);
  const open = useAtomValue(livePanelsAtom).sources;
  const status = useAtomValue(sourceStatusAtom);
  const phase = useAtomValue(publishPhaseAtom);
  const modelLoading = useAtomValue(modelLoadingAtom);
  const [picking, setPicking] = useState(false);
  const cameraRefused = phase === 'camera-blocked' || phase === 'no-camera';
  const micRefused = phase === 'mic-blocked' || phase === 'no-mic';
  return (
    <aside
      id="sources"
      aria-label="sources"
      className={cn('shrink-0 transition-[width] duration-150 motion-reduce:transition-none', open ? 'w-full lg:w-60' : 'w-full lg:w-auto')}
    >
      <Collapsible
        id="sources-panel"
        title="sources"
        open={open}
        onToggle={() => setLivePanel('sources', !open)}
        aside={<AddMenu onModel={() => setPicking(true)} />}
        footer={startStop ? <StartStop status /> : undefined}
      >
        {sources.length === 0 ? (
          <div className="px-3 py-3 text-sm text-textTertiary">
            <p>
              {modelLoading ? 'your model shows up here once it is on' : micRefused ? 'the mic shows up here once it is on' : 'the camera shows up here once it is on'}
            </p>
            {cameraRefused && (
              <button id="mic-only" type="button" className="mt-2 text-sm font-semibold text-primaryBlue" onClick={() => void startMic()}>
                go mic only: your avatar, moving with your voice
              </button>
            )}
            {micRefused && (
              <button id="use-camera" type="button" className="mt-2 text-sm font-semibold text-primaryBlue" onClick={() => void cameraOn()}>
                use the camera instead
              </button>
            )}
          </div>
        ) : (
          <SourceList sources={sources} />
        )}
        <ModelControls onChange={() => setPicking(true)} />
        {status && (
          <p id="source-status" className="px-3 pb-2 text-xs text-textSecondary" aria-live="polite">
            {status}
          </p>
        )}
      </Collapsible>
      {picking && <ModelDialog onClose={() => setPicking(false)} />}
    </aside>
  );
}
