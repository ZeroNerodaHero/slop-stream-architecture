import { useAtomValue } from 'jotai';

import { type ModelLoad, modelLoadAtom } from '@/infra/atoms/publish-atoms';
import { ModelPicture } from '@/shared-components/live/ModelPicture';
import { cn } from '@/utils/cn';

const mb = (bytes: number) => (bytes / 1_000_000).toFixed(bytes < 9_950_000 ? 1 : 0);

/** `8.2 of 15 mb`, or `8.2 mb` when the whole is not known. '' with nothing counted yet. */
function bytesWords(loaded: number, total: number): string {
  if (total > 0) return `${mb(Math.min(loaded, total))} of ${mb(total)} mb`;
  return loaded > 0 ? `${mb(loaded)} mb` : '';
}

/** The face reader on its way: its files coming down, then it starting. */
export function readerWords(loaded: number, total: number): string {
  if (total > 0 && loaded >= total) return 'starting the face reader';
  const bytes = bytesWords(loaded, total);
  return bytes ? `getting the face reader · ${bytes}` : 'getting the face reader';
}

/** How far along a model is, in the streamer's words. */
export function loadWords({ step, loaded, total }: Pick<ModelLoad, 'step' | 'loaded' | 'total'>): string {
  if (step === 'reader') return readerWords(loaded, total);
  if (step === 'model') return 'building the model';
  const bytes = bytesWords(loaded, total);
  // a file that counts no bytes is one this browser keeps: it is read, not downloaded
  return bytes ? `downloading · ${bytes}` : 'opening it';
}

/** How much of a step is done, 0 to 1. `null`: no telling (a step that counts nothing, or bytes of a whole nobody said). */
export function loadFraction({ loaded, total }: { loaded: number; total: number }): number | null {
  return total > 0 ? Math.min(1, loaded / total) : null;
}

interface LoadBarProps {
  loaded: number;
  total: number;
  /** What is loading, for a screen reader. */
  label: string;
  /** Over a picture: on glass, not on the page's own stroke. */
  onPicture?: boolean;
  className?: string;
}

/** A thin bar: filled as far as the step is done, or breathing when there is no telling how far that is. */
export function LoadBar({ loaded, total, label, onPicture = false, className }: LoadBarProps) {
  const fraction = loadFraction({ loaded, total });
  return (
    <span
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={fraction === null ? undefined : Math.round(fraction * 100)}
      className={cn('relative block h-1 w-full overflow-hidden', onPicture ? 'bg-white/25' : 'bg-primaryStroke', className)}
    >
      <span
        className={cn(
          'absolute inset-y-0 left-0 bg-primaryBlue',
          fraction === null ? 'w-full motion-safe:animate-pulse' : 'transition-[width] duration-150 motion-reduce:transition-none'
        )}
        style={fraction === null ? undefined : { width: `${fraction * 100}%` }}
      />
    </span>
  );
}

/**
 * Over the preview while a model is on its way on (docs/vtuber.md): its picture, its name, a
 * bar and what is happening. A visit that comes back to a kept model would otherwise look at
 * an empty frame for as long as the file takes; a pick has the picker's card saying the same,
 * and this behind it for when the picker is closed before the model is on. It takes no
 * presses: the layers under it are still the streamer's to move.
 */
export function ModelLoading() {
  const load = useAtomValue(modelLoadAtom);
  if (!load) return null;
  const { choice } = load;
  return (
    <div id="model-loading" data-step={load.step} className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-black/70">
      <div className="flex w-56 max-w-[80%] flex-col items-center gap-3 text-center">
        <span className="block h-24 w-24 overflow-hidden border border-white/25 bg-black">
          <ModelPicture key={`${choice.kind}-${choice.id}`} choice={choice} />
        </span>
        <p id="model-loading-name" className="max-w-full truncate text-sm font-semibold text-white">
          {choice.name}
        </p>
        <LoadBar loaded={load.loaded} total={load.total} label={`loading ${choice.name}`} onPicture />
        <p id="model-loading-words" className="text-xs text-white/75">
          {loadWords(load)}
        </p>
      </div>
    </div>
  );
}
