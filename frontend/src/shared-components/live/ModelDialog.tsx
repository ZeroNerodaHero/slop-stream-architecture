import { RiCloseLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { type MouseEvent, type PointerEvent, type ReactNode, useEffect, useLayoutEffect, useRef } from 'react';

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
import type { KeptModel } from '@/infra/model-store';
import { ICON_BUTTON } from '@/shared-components/live/Collapsible';
import { LoadBar, loadFraction, loadWords, loadWordsShort } from '@/shared-components/live/ModelLoading';
import { KeptPicture, LetterTile } from '@/shared-components/live/ModelPicture';
import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

const SECTION_TITLE = 'text-xs font-semibold uppercase tracking-wider text-textTertiary';
const mb = (bytes: number) => `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} mb`;

interface CardProps {
  id: string;
  name: string;
  /** The line under the name: who made it, the licence it names, how big it is. */
  detail: string;
  picture: ReactNode;
  /** It is the one on the stream now. */
  on: boolean;
  /** It is the one on its way on, and how far along it is. `null`: it is not. */
  load: ModelLoad | null;
  disabled: boolean;
  onPick: () => void;
}

/**
 * One model: its picture, its name, a line about it. The whole card is the pick. While it is
 * the one loading, its picture is under a veil with how far along it is (a percentage when
 * there are bytes to count, a bar either way) and its line says what is happening in a word
 * or two (the picker's last line has the sentence); the other cards wait, dimmed.
 */
function Card({ id, name, detail, picture, on, load, disabled, onPick }: CardProps) {
  const fraction = load ? loadFraction(load) : null;
  return (
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
            <span className="flex flex-1 items-center justify-center text-xl font-semibold text-white">{fraction === null ? '' : `${Math.round(fraction * 100)}%`}</span>
            <LoadBar loaded={load.loaded} total={load.total} label={`loading ${name}`} onPicture />
          </span>
        )}
      </span>
      <span className="block min-w-0 px-2 py-1.5">
        <span className={cn('block truncate text-sm font-semibold', on || load ? 'text-primaryBlue' : 'text-textPrimary')}>{name}</span>
        <span className="block truncate text-xs text-textTertiary">{(load ? loadWordsShort(load) : detail) || '\u00a0'}</span>
      </span>
    </button>
  );
}

/** A demo model's line: who made it, its licence, and its size to download, or that there is nothing to download. */
const demoDetail = (model: DemoModel, kept: boolean) => [model.author, model.licence, kept ? 'downloaded' : mb(model.bytes)].filter(Boolean).join(' · ');
const keptDetail = (model: KeptModel) => [model.author, mb(model.bytes)].filter(Boolean).join(' · ');

/**
 * The model picker (docs/vtuber.md): the site's demo models, out of the bucket with one fetch
 * (a name, who made it, its licence and a thumbnail each), the streamer's own models that this
 * browser keeps, and a file of their own. A pick loads the model and puts it where the camera's
 * picture goes; its card shows how far along it is, and the dialog closes once it is on. A demo
 * model comes down once: this browser keeps it, its card says `downloaded`, and after that it
 * opens with nothing to wait for. Their own file is read here and kept here: it is not put up
 * anywhere.
 */
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
  // mount only: the two shelves, asked for once per opening
  useEffect(() => {
    void loadModelLibrary();
  }, []);

  /** A pick that worked closes the dialog; one that did not says why and leaves it open. */
  const pick = (picked: Promise<boolean>) => void picked.then((ok) => ok && onClose());
  const onPointerDown = (e: PointerEvent<HTMLDialogElement>) => {
    pressedBackdrop.current = e.target === e.currentTarget;
  };
  const onClick = (e: MouseEvent<HTMLDialogElement>) => {
    if (pressedBackdrop.current && e.target === e.currentTarget) onClose();
  };

  return (
    <dialog
      ref={dialogRef}
      id="model-dialog"
      aria-labelledby="model-dialog-title"
      onPointerDown={onPointerDown}
      onClick={onClick}
      onClose={onClose}
      className="m-auto max-h-[calc(100dvh-2rem)] w-[min(640px,calc(100vw-3rem))] overflow-y-auto border border-primaryStroke bg-backgroundSecondary p-6 text-base text-textPrimary backdrop:bg-black/60"
    >
      <div className="relative flex flex-col gap-5">
        <div className="pr-10">
          <h2 id="model-dialog-title" className="border-l-4 border-primaryBlue pl-3 text-xl font-semibold leading-tight">
            pick a model
          </h2>
          <p className="mt-2 text-sm text-textSecondary">it wears your face: your camera reads it here, in this browser, and only the model is sent.</p>
        </div>
        <Tooltip content="close" at="left">
          <button id="model-dialog-close" type="button" aria-label="close" onClick={onClose} className={cn(ICON_BUTTON, 'absolute right-0 top-0')}>
            <RiCloseLine aria-hidden size={18} />
          </button>
        </Tooltip>

        <section aria-labelledby="model-demos-title">
          <h3 id="model-demos-title" className={SECTION_TITLE}>
            demo models
          </h3>
          {demos.length > 0 && <p className="mt-1 text-sm text-textTertiary">the site's own. one is downloaded the first time it is worn, then kept in this browser.</p>}
          {demos.length === 0 ? (
            <p id="model-demos-none" className="mt-2 text-sm text-textTertiary">
              none on this server yet. a file of your own works the same.
            </p>
          ) : (
            <ul id="model-demos" className="m-0 mt-2 grid list-none grid-cols-2 gap-3 p-0 sm:grid-cols-4">
              {demos.map((model) => (
                // `data-kept`: this browser has the file (the test reads it; the card's line says it)
                <li key={model.id} data-kept={keptDemos.get(model.id) === model.v} className="min-w-0">
                  <Card
                    id={`model-demo-${model.id}`}
                    name={model.name}
                    detail={demoDetail(model, keptDemos.get(model.id) === model.v)}
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
          </h3>
          <p className="mt-1 text-sm text-textTertiary">a .vrm from your computer. it is kept in this browser for next time and goes nowhere else.</p>
          {kept.length > 0 && (
            <ul id="model-kept" className="m-0 mt-2 grid list-none grid-cols-2 gap-3 p-0 sm:grid-cols-4">
              {kept.map((model) => (
                <li key={model.id} className="group/kept relative min-w-0">
                  <Card
                    id={`model-kept-${model.id}`}
                    name={model.name}
                    detail={keptDetail(model)}
                    picture={model.thumb ? <KeptPicture picture={model.thumb} /> : <LetterTile name={model.name} />}
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
            </ul>
          )}
          <input
            ref={fileRef}
            id="model-file"
            type="file"
            accept=".vrm,model/gltf-binary"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) pick(pickModelFile(file));
            }}
          />
          <button
            id="model-file-pick"
            type="button"
            disabled={loading}
            className="mt-3 text-sm font-semibold text-primaryBlue disabled:opacity-40"
            onClick={() => fileRef.current?.click()}
          >
            pick a .vrm file
          </button>
        </section>

        {/* what the pick is doing, or why it did not come. not read out as it changes: the megabytes would be a sentence a second */}
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
