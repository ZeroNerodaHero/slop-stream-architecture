import {
  RiAddLine,
  RiArrowDownLine,
  RiArrowUpLine,
  RiAspectRatioLine,
  RiCloseLine,
  RiComputerLine,
  RiEyeLine,
  RiEyeOffLine,
  RiFocus3Line,
  RiImageLine,
  RiVidiconLine
} from '@remixicon/react';
import { type Atom, useAtomValue } from 'jotai';
import { useEffect, useRef, useState } from 'react';

import { api } from '@/infra/api';
import {
  addImage,
  cameraAtom,
  canShareScreenAtom,
  deleteImage,
  fitSourceTo,
  imageStatusAtom,
  libraryAtom,
  livePanelsAtom,
  placeImage,
  removeSource,
  reorderSource,
  screenShareSupported,
  screenStreamAtom,
  selectedSourceAtom,
  selectSource,
  setLivePanel,
  setSourceFit,
  shareScreen,
  sourcesAtom,
  streamNameAtom,
  toggleSource
} from '@/infra/atoms/publish-atoms';
import type { Source } from '@/infra/scene';
import { Collapsible, ICON_BUTTON } from '@/shared-components/live/Collapsible';
import { Tooltip } from '@/shared-components/Tooltip';
import { VideoFrame } from '@/shared-components/VideoFrame';
import { cn } from '@/utils/cn';

/** A row: the selected one wears the rail's mark, a blue edge on a lifted ground. */
const ROW = 'group/row flex h-10 w-full min-w-0 items-center gap-2 border-l-2 pl-1.5 pr-1 text-left text-sm leading-tight transition-colors duration-150';
const ROW_ON = 'border-primaryBlue bg-backgroundTertiary text-textPrimary';
const ROW_OFF = 'border-transparent text-textSecondary hover:bg-backgroundTertiary/60 hover:text-textPrimary';
const MENU_ITEM =
  'flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-textSecondary transition-colors duration-150 hover:bg-backgroundTertiary hover:text-textPrimary focus-visible:bg-backgroundTertiary focus-visible:text-textPrimary focus-visible:outline-none disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-textSecondary';

/** A row's little picture of its source: the slot's stream, muted. */
function Thumb({ id, streamAtom }: { id: string; streamAtom: Atom<MediaStream | null> }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  return <VideoFrame id={id} streamAtom={streamAtom} videoRef={ref} muted className="h-7 w-12 shrink-0 border-primaryStroke object-cover" />;
}

/**
 * The `+`: a menu with what can be added, before start or live. A screen or window (three at
 * most), a picture, and the pictures this name put up before, offered again under the upload.
 * Escape and a press outside close it.
 */
function AddMenu() {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const canShare = useAtomValue(canShareScreenAtom);
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
      {open && (
        <div
          id="add-source-menu"
          role="menu"
          aria-label="add a source"
          className="absolute right-0 top-full z-20 mt-1 w-56 border border-primaryStroke bg-backgroundSecondary py-1"
        >
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
                    <button
                      id={`library-delete-${asset.id}`}
                      type="button"
                      aria-label="delete this picture"
                      className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center border border-primaryStroke bg-backgroundSecondary text-textSecondary opacity-0 transition-opacity duration-150 hover:border-decrease hover:text-decrease focus-visible:opacity-100 focus-visible:outline-none group-hover/pic:opacity-100"
                      onClick={() => void deleteImage(asset.id)}
                    >
                      <RiCloseLine aria-hidden size={10} />
                    </button>
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

function Row({ source, hasCamera }: { source: Source; hasCamera: boolean }) {
  const selected = useAtomValue(selectedSourceAtom) === source.id;
  const streamAtom = source.kind === 'camera' ? cameraAtom : screenStreamAtom((source.slot ?? 1) - 1);
  const name = useAtomValue(streamNameAtom);
  const Icon = source.kind === 'camera' ? RiVidiconLine : source.kind === 'screen' ? RiComputerLine : RiImageLine;
  const fill = source.fit ? source.fit === 'cover' : source.kind === 'camera';
  return (
    <li className={cn(ROW, selected ? ROW_ON : ROW_OFF)}>
      <button
        id={`source-${source.id}`}
        type="button"
        aria-pressed={selected}
        onClick={() => selectSource(source.id)}
        className="flex h-full min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-none"
      >
        {source.kind === 'image' ? (
          <img src={api.assetUrl(name, source.asset ?? 0)} alt="" draggable={false} className="h-7 w-12 shrink-0 border border-primaryStroke bg-black object-contain" />
        ) : (
          <Thumb id={`source-${source.id}-video`} streamAtom={streamAtom} />
        )}
        <Icon aria-hidden size={16} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">{source.label}</span>
      </button>
      {/* the eye reports state, so it is always there; the rest comes up with the pointer or the keys */}
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
        {source.kind !== 'image' && (
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
        <Tooltip content="forward">
          <button id={`source-up-${source.id}`} type="button" aria-label="bring forward" onClick={() => reorderSource(source.id, 'up')} className={ICON_BUTTON}>
            <RiArrowUpLine aria-hidden size={16} />
          </button>
        </Tooltip>
        <Tooltip content="back">
          <button id={`source-down-${source.id}`} type="button" aria-label="send back" onClick={() => reorderSource(source.id, 'down')} className={ICON_BUTTON}>
            <RiArrowDownLine aria-hidden size={16} />
          </button>
        </Tooltip>
        {source.kind !== 'camera' && (
          <Tooltip content={source.kind === 'screen' ? 'stop sharing' : 'remove (the upload stays in your pictures)'}>
            <button
              id={`source-remove-${source.id}`}
              type="button"
              aria-label={source.kind === 'screen' ? 'stop sharing' : 'remove'}
              onClick={() => removeSource(source.id)}
              className={cn(ICON_BUTTON, 'hover:border-decrease hover:text-decrease')}
            >
              <RiCloseLine aria-hidden size={16} />
            </button>
          </Tooltip>
        )}
      </span>
    </li>
  );
}

/**
 * The sources, beside the preview: the camera, the shared screens and the pictures, top of
 * the stack first (the row order is the reverse of the array, the way a layers panel reads).
 * Each row selects its layer; the eye puts it on or off the stream; the arrows move it through
 * the stack; `×` stops a share or removes a picture. The `+` adds. Folded, it is a rail.
 */
export function Sources() {
  const sources = useAtomValue(sourcesAtom);
  const open = useAtomValue(livePanelsAtom).sources;
  const status = useAtomValue(imageStatusAtom);
  const hasCamera = sources.some((s) => s.kind === 'camera');
  return (
    <aside
      id="sources"
      aria-label="sources"
      className={cn('shrink-0 transition-[width] duration-150 motion-reduce:transition-none', open ? 'w-full lg:w-60' : 'w-full lg:w-auto')}
    >
      <Collapsible id="sources-panel" title="sources" open={open} onToggle={() => setLivePanel('sources', !open)} aside={<AddMenu />}>
        {sources.length === 0 ? (
          <p className="px-3 py-3 text-sm text-textTertiary">the camera shows up here once it is on</p>
        ) : (
          <ul id="source-list" className="m-0 list-none divide-y divide-primaryStroke p-0">
            {[...sources].reverse().map((source) => (
              <Row key={source.id} source={source} hasCamera={hasCamera} />
            ))}
          </ul>
        )}
        <p className="px-3 py-2 text-xs text-textTertiary">drag a layer to move it, pull a corner to resize. arrow keys nudge, shift frees the shape</p>
        {status && (
          <p id="image-status" className="px-3 pb-2 text-xs text-textSecondary" aria-live="polite">
            {status}
          </p>
        )}
      </Collapsible>
    </aside>
  );
}
