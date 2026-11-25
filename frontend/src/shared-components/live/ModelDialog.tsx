import { RiAddLine, RiBox3Line, RiCloseLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { type MouseEvent, type PointerEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { api, type DemoModel } from '@/infra/api';
import {
  demoModelsAtom,
  forgetKeptModel,
  keptDemosAtom,
  keptModelsAtom,
  loadModelLibrary,
  modelAtom,
  type ModelLoad,
  modelLoadAtom,
  modelStatusAtom,
  pickDemoModel,
  pickKeptModel,
  pickModelFile
} from '@/infra/atoms/publish-atoms';
import { type KeptModel, MAX_KEPT } from '@/infra/model-store';
import { ICON_BUTTON } from '@/shared-components/live/Collapsible';
import { LoadBar, loadFraction, loadWords, loadWordsShort } from '@/shared-components/live/ModelLoading';
import { KeptPicture, LetterTile } from '@/shared-components/live/ModelPicture';
import { ExternalLink } from '@/shared-components/ExternalLink';
import { SHEET_CLOSE, SHEET_DIALOG, SheetGrab, useSheetBack } from '@/shared-components/MobileSheet';
import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

const SECTION_TITLE = 'text-xs font-semibold uppercase tracking-wider text-textTertiary';
const SECTION_COUNT = 'ml-2 text-xs font-semibold tracking-normal text-textSecondary';
const GRID = 'm-0 mt-2 grid list-none grid-cols-2 gap-3 p-0 sm:grid-cols-4';
const mb = (bytes: number) => `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} mb`;

const PLACES: readonly { id: string; name: string; href: string; file: string; about: string; icon: string }[] = [
  {
    id: 'vroid-hub',
    name: 'vroid hub',
    href: 'https://hub.vroid.com/en',
    file: '.vrm',
    about: 'characters made in vroid studio. each says who may wear it',
    icon: '/model-sites/vroid-hub.png'
  },
  { id: 'booth', name: 'booth', href: 'https://booth.pm/en', file: '.vrm', about: 'a market of avatars, many of them free', icon: '/model-sites/booth.png' },
  {
    id: 'open-source-avatars',
    name: 'open source avatars',
    href: 'https://www.opensourceavatars.com/',
    file: '.vrm',
    about: 'over 300, most of them free for any use',
    icon: '/model-sites/osa.png'
  },
  {
    id: 'sketchfab',
    name: 'sketchfab',
    href: 'https://sketchfab.com/',
    file: '.glb',
    about: 'characters under creative commons licences. download one as glb',
    icon: '/model-sites/sketchfab.png'
  },
  {
    id: 'mixamo',
    name: 'mixamo',
    href: 'https://www.mixamo.com/',
    file: '.fbx',
    about: 'free characters with a skeleton. most have no face to move, so only the head turns',
    icon: '/model-sites/mixamo.png'
  },
  {
    id: 'vroid-studio',
    name: 'vroid studio',
    href: 'https://vroid.com/en/studio',
    file: '.vrm',
    about: 'free, to make one of your own',
    icon: '/model-sites/vroid-studio.png'
  }
];

interface CardProps {
  id: string;
  name: string;
  author: string;
  meta: string;
  picture: ReactNode;
  on: boolean;
  load: ModelLoad | null;
  disabled: boolean;
  onPick: () => void;
}

function useTruncated(text: string) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setCut(el.scrollWidth > el.clientWidth);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text]);
  return [ref, cut] as const;
}

function Card({ id, name, author, meta, picture, on, load, disabled, onPick }: CardProps) {
  const [authorRef, authorCut] = useTruncated(author);
  const fraction = load ? loadFraction(load) : null;
  return (
    <Tooltip content={authorCut ? author : null} className="max-w-xs whitespace-normal">
      <button
        id={id}
        type="button"
        aria-pressed={on}
        aria-busy={load !== null}
        disabled={disabled}
        onClick={onPick}
        className={cn(
          'flex w-full min-w-0 flex-col border bg-background text-left transition-colors duration-150 hover:border-primaryBlue focus-visible:border-primaryBlue focus-visible:outline-none disabled:cursor-default',
          on || load ? 'border-primaryBlue disabled:hover:border-primaryBlue' : 'border-primaryStroke disabled:hover:border-primaryStroke',
          !load && 'disabled:opacity-40'
        )}
      >
        <span className="relative block aspect-square w-full overflow-hidden bg-black">
          {picture}
          {load && (
            <span id="model-card-loading" data-step={load.step} className="absolute inset-0 flex flex-col bg-black/60">
              <span className="flex flex-1 items-center justify-center text-xl font-semibold text-white">
                {fraction === null ? '' : `${Math.round(fraction * 100)}%`}
              </span>
              <LoadBar loaded={load.loaded} total={load.total} label={`loading ${name}`} onPicture />
            </span>
          )}
        </span>
        <span className="block min-w-0 px-2 py-1.5">
          <span className={cn('block truncate text-sm font-semibold', on || load ? 'text-primaryBlue' : 'text-textPrimary')}>{name}</span>
          <span ref={authorRef} className="block truncate text-xs text-textSecondary">
            {author || '\u00a0'}
          </span>
          <span className="block text-xs text-textTertiary tabular-nums">{(load ? loadWordsShort(load) : meta) || '\u00a0'}</span>
        </span>
      </button>
    </Tooltip>
  );
}

const demoDetail = (model: DemoModel, kept: boolean) => ({
  author: model.author,
  meta: [model.licence, kept ? 'downloaded' : mb(model.bytes)].filter(Boolean).join(' · ')
});
const keptDetail = (model: KeptModel) => ({ author: model.author, meta: mb(model.bytes) });

function NoPicture({ format }: { format: string }) {
  return (
    <i className="relative flex h-full w-full items-center justify-center bg-backgroundTertiary not-italic text-textTertiary">
      <RiBox3Line aria-hidden size={36} />
      <small className="absolute left-1.5 top-1.5 border border-primaryStroke bg-backgroundSecondary px-1.5 py-0.5 text-xs font-semibold text-textSecondary">
        {format}
      </small>
    </i>
  );
}

function AddTile({ disabled, full, onPick }: { disabled: boolean; full: boolean; onPick: () => void }) {
  return (
    <Tooltip content={full ? 'forgets the oldest' : null}>
      <button
        id="model-file-pick"
        type="button"
        disabled={disabled}
        onClick={onPick}
        className="relative flex w-full min-w-0 flex-col border border-dashed border-secondaryStroke text-left transition-colors duration-150 hover:border-primaryBlue focus-visible:border-primaryBlue focus-visible:outline-none disabled:cursor-default disabled:opacity-40 disabled:hover:border-secondaryStroke"
      >
        <span aria-hidden className="block aspect-square w-full" />
        <span aria-hidden className="invisible block px-2 py-1.5">
          <span className="block text-sm">{'\u00a0'}</span>
          <span className="block text-xs">{'\u00a0'}</span>
        </span>
        <span className="absolute inset-0 flex flex-col items-center justify-center gap-1.5">
          <span aria-hidden className="flex h-7 w-7 items-center justify-center border border-primaryStroke text-primaryBlue">
            <RiAddLine size={16} />
          </span>
          <span className="text-sm font-semibold text-textSecondary">add model</span>
          <span className="text-xs text-textTertiary">.vrm · .glb · .fbx</span>
        </span>
      </button>
    </Tooltip>
  );
}

export function ModelDialog({ onClose }: { onClose: () => void }) {
  const demos = useAtomValue(demoModelsAtom);
  const kept = useAtomValue(keptModelsAtom);
  const keptDemos = useAtomValue(keptDemosAtom);
  const on = useAtomValue(modelAtom);
  const load = useAtomValue(modelLoadAtom);
  const loading = load !== null;
  const status = useAtomValue(modelStatusAtom);
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const pressedBackdrop = useRef(false);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);
  useEffect(() => {
    void loadModelLibrary();
  }, []);

  const pick = (picked: Promise<boolean>) => void picked.then((ok) => ok && onClose());
  const onPointerDown = (e: PointerEvent<HTMLDialogElement>) => {
    pressedBackdrop.current = e.target === e.currentTarget;
  };
  const onClick = (e: MouseEvent<HTMLDialogElement>) => {
    if (pressedBackdrop.current && e.target === e.currentTarget) onClose();
  };
  useSheetBack(onClose);

  return (
    <dialog
      ref={dialogRef}
      id="model-dialog"
      data-sheet=""
      aria-labelledby="model-dialog-title"
      onPointerDown={onPointerDown}
      onClick={onClick}
      onClose={onClose}
      className={cn(
        'm-auto max-h-[calc(100dvh-2rem)] w-[min(720px,calc(100vw-3rem))] overflow-y-auto md:rounded-panel border border-primaryStroke bg-backgroundSecondary p-6 text-base text-textPrimary backdrop:bg-black/60',
        SHEET_DIALOG
      )}
    >
      <SheetGrab onDismiss={onClose} />
      <div className="relative flex flex-col gap-5">
        <div className="pr-10">
          <h2 id="model-dialog-title" className="border-l-4 border-primaryBlue pl-3 text-xl font-semibold leading-tight">
            pick a model
          </h2>
          <p className="mt-2 text-sm text-textSecondary">it wears your face. only the model is sent.</p>
        </div>
        <Tooltip content="close" at="left">
          <button id="model-dialog-close" type="button" aria-label="close" onClick={onClose} className={cn(ICON_BUTTON, 'absolute right-0 top-0', SHEET_CLOSE)}>
            <RiCloseLine aria-hidden size={18} />
          </button>
        </Tooltip>

        <section aria-labelledby="model-demos-title">
          <h3 id="model-demos-title" className={SECTION_TITLE}>
            demo models
            <span className={SECTION_COUNT}>{demos.length}</span>
          </h3>
          {demos.length === 0 ? (
            <p id="model-demos-none" className="mt-2 text-sm text-textTertiary">
              none on this server yet. a file of your own works the same.
            </p>
          ) : (
            <ul id="model-demos" className={GRID}>
              {demos.map((model) => (
                <li key={model.id} data-kept={keptDemos.get(model.id) === model.v} className="min-w-0">
                  <Card
                    id={`model-demo-${model.id}`}
                    name={model.name}
                    {...demoDetail(model, keptDemos.get(model.id) === model.v)}
                    picture={
                      model.thumb ? (
                        <img src={api.demoModelThumbUrl(model)} alt="" draggable={false} loading="lazy" className="block h-full w-full object-cover" />
                      ) : (
                        <LetterTile name={model.name} />
                      )
                    }
                    on={on?.kind === 'demo' && on.id === model.id}
                    load={load?.choice.kind === 'demo' && load.choice.id === model.id ? load : null}
                    disabled={loading}
                    onPick={() => pick(pickDemoModel(model))}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="model-kept-title">
          <h3 id="model-kept-title" className={SECTION_TITLE}>
            yours
            <span className={SECTION_COUNT}>
              {kept.length}
              <span className="text-textTertiary">/{MAX_KEPT}</span>
            </span>
          </h3>
          <ul id="model-kept" className={GRID}>
            {kept.map((model) => (
              <li key={model.id} className="group/kept relative min-w-0">
                <Card
                  id={`model-kept-${model.id}`}
                  name={model.name}
                  {...keptDetail(model)}
                  picture={model.thumb ? <KeptPicture picture={model.thumb} /> : <NoPicture format={model.format} />}
                  on={on?.kind === 'kept' && on.id === model.id}
                  load={load?.choice.kind === 'kept' && load.choice.id === model.id ? load : null}
                  disabled={loading}
                  onPick={() => pick(pickKeptModel(model))}
                />
                <Tooltip content="forget this model">
                  <button
                    id={`model-forget-${model.id}`}
                    type="button"
                    aria-label={`forget ${model.name}`}
                    disabled={loading}
                    onClick={() => void forgetKeptModel(model.id)}
                    className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center border border-primaryStroke bg-backgroundSecondary text-textSecondary opacity-0 transition-opacity duration-150 hover:border-decrease hover:text-decrease focus-visible:opacity-100 focus-visible:outline-none group-hover/kept:opacity-100 disabled:opacity-0"
                  >
                    <RiCloseLine aria-hidden size={12} />
                  </button>
                </Tooltip>
              </li>
            ))}
            <li className="min-w-0">
              <AddTile disabled={loading} full={kept.length >= MAX_KEPT} onPick={() => fileRef.current?.click()} />
            </li>
          </ul>
          {kept.length === 0 && <p className="mt-2 text-sm text-textTertiary">a .vrm, .glb or .fbx from your computer.</p>}
          <input
            ref={fileRef}
            id="model-file"
            type="file"
            accept=".vrm,.glb,.fbx,model/gltf-binary"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) pick(pickModelFile(file).then((picked) => picked.on && picked.saved));
            }}
          />
        </section>

        <section aria-labelledby="model-places-title">
          <div className="flex items-baseline justify-between gap-3">
            <h3 id="model-places-title" className={SECTION_TITLE}>
              where to find one
            </h3>
            <p className="text-xs text-textTertiary">opens in a new tab</p>
          </div>
          <ul id="model-places" className="m-0 mt-2 grid list-none grid-cols-3 gap-2 p-0 md:grid-cols-6">
            {PLACES.map((place) => (
              <li key={place.id} className="min-w-0">
                <Tooltip content={`${place.name} · ${place.file} · ${place.about}`} className="max-w-xs whitespace-normal">
                  <ExternalLink
                    id={`model-place-${place.id}`}
                    href={place.href}
                    aria-label={place.name}
                    className={cn(
                      'flex h-12 items-center justify-center border border-primaryStroke bg-background transition-colors duration-150 hover:border-primaryBlue focus-visible:border-primaryBlue focus-visible:outline-none',
                      place.id === 'vroid-studio' && 'border-dashed'
                    )}
                  >
                    <img src={place.icon} alt="" draggable={false} className="block h-7 w-7" />
                  </ExternalLink>
                </Tooltip>
              </li>
            ))}
          </ul>
        </section>

        <p
          id="model-status"
          data-step={load?.step}
          className={cn('min-h-5 text-sm', !load && status ? 'text-decrease' : 'text-textSecondary')}
          aria-live={load ? 'off' : 'polite'}
        >
          {load ? `${load.choice.name}: ${loadWords(load)}` : status}
        </p>
      </div>
    </dialog>
  );
}
