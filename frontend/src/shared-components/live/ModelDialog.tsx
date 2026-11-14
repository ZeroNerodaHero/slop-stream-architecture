import { RiCloseLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { type MouseEvent, type PointerEvent, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef } from 'react';

import { api, type DemoModel } from '@/infra/api';
import {
  demoModelsAtom,
  forgetKeptModel,
  keptModelsAtom,
  loadModelLibrary,
  modelAtom,
  modelLoadingAtom,
  modelStatusAtom,
  pickDemoModel,
  pickKeptModel,
  pickModelFile
} from '@/infra/atoms/publish-atoms';
import type { KeptModel } from '@/infra/model-store';
import { colorOf } from '@/shared-components/GeneratedAvatar';
import { ICON_BUTTON } from '@/shared-components/live/Collapsible';
import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

const SECTION_TITLE = 'text-xs font-semibold uppercase tracking-wider text-textTertiary';
const mb = (bytes: number) => `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} mb`;

/** A model with no picture of its own: the letter its name starts with, on the colour its name makes. */
function LetterTile({ name }: { name: string }) {
  const key = name.trim().toLowerCase();
  return (
    <svg viewBox="0 0 100 100" aria-hidden className="block h-full w-full" style={{ backgroundColor: colorOf(key || 'model') }}>
      <text x="50" y="50" textAnchor="middle" dominantBaseline="central" fontSize="48" fontWeight="600" fill="white">
        {key ? [...key][0]!.toUpperCase() : '?'}
      </text>
    </svg>
  );
}

/** A kept model's picture: bytes out of this browser, shown through a url that lives as long as this does. */
function KeptPicture({ picture }: { picture: Blob }) {
  const url = useMemo(() => URL.createObjectURL(picture), [picture]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return <img src={url} alt="" draggable={false} className="block h-full w-full object-cover" />;
}

interface CardProps {
  id: string;
  name: string;
  /** The line under the name: who made it, the licence it names, how big it is. */
  detail: string;
  picture: ReactNode;
  /** It is the one on the stream now. */
  on: boolean;
  disabled: boolean;
  onPick: () => void;
}

/** One model: its picture, its name, a line about it. The whole card is the pick. */
function Card({ id, name, detail, picture, on, disabled, onPick }: CardProps) {
  return (
    <button
      id={id}
      type="button"
      aria-pressed={on}
      disabled={disabled}
      onClick={onPick}
      className={cn(
        'flex w-full min-w-0 flex-col border bg-background text-left transition-colors duration-150 hover:border-primaryBlue focus-visible:border-primaryBlue focus-visible:outline-none disabled:cursor-default disabled:opacity-40 disabled:hover:border-primaryStroke',
        on ? 'border-primaryBlue' : 'border-primaryStroke'
      )}
    >
      <span className="block aspect-square w-full overflow-hidden bg-black">{picture}</span>
      <span className="block min-w-0 px-2 py-1.5">
        <span className={cn('block truncate text-sm font-semibold', on ? 'text-primaryBlue' : 'text-textPrimary')}>{name}</span>
        <span className="block truncate text-xs text-textTertiary">{detail || '\u00a0'}</span>
      </span>
    </button>
  );
}

const demoDetail = (model: DemoModel) => [model.author, model.licence, mb(model.bytes)].filter(Boolean).join(' · ');
const keptDetail = (model: KeptModel) => [model.author, mb(model.bytes)].filter(Boolean).join(' · ');

/**
 * The model picker (docs/vtuber.md): the site's demo models, out of the bucket with one fetch
 * (a name, who made it, its licence and a thumbnail each), the streamer's own models that this
 * browser keeps, and a file of their own. A pick loads the model and puts it where the camera's
 * picture goes; the dialog closes once it is on. Their own file is read here and kept here: it
 * is not put up anywhere.
 */
export function ModelDialog({ onClose }: { onClose: () => void }) {
  const demos = useAtomValue(demoModelsAtom);
  const kept = useAtomValue(keptModelsAtom);
  const on = useAtomValue(modelAtom);
  const loading = useAtomValue(modelLoadingAtom);
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
          {demos.length === 0 ? (
            <p id="model-demos-none" className="mt-2 text-sm text-textTertiary">
              none on this server yet. a file of your own works the same.
            </p>
          ) : (
            <ul id="model-demos" className="m-0 mt-2 grid list-none grid-cols-2 gap-3 p-0 sm:grid-cols-4">
              {demos.map((model) => (
                <li key={model.id} className="min-w-0">
                  <Card
                    id={`model-demo-${model.id}`}
                    name={model.name}
                    detail={demoDetail(model)}
                    picture={
                      model.thumb ? (
                        <img src={api.demoModelThumbUrl(model)} alt="" draggable={false} loading="lazy" className="block h-full w-full object-cover" />
                      ) : (
                        <LetterTile name={model.name} />
                      )
                    }
                    on={on?.kind === 'demo' && on.id === model.id}
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

        <p id="model-status" className={cn('min-h-5 text-sm', status ? 'text-decrease' : 'text-textSecondary')} aria-live="polite">
          {loading ? 'getting it ready' : status}
        </p>
      </div>
    </dialog>
  );
}
