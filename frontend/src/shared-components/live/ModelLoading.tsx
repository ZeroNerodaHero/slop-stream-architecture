import { useAtomValue } from 'jotai';

import { type ModelLoad, modelLoadAtom } from '@/infra/atoms/publish-atoms';
import { ModelPicture } from '@/shared-components/live/ModelPicture';
import { cn } from '@/utils/cn';

const mb = (bytes: number) => (bytes / 1_000_000).toFixed(bytes < 9_950_000 ? 1 : 0);

function bytesWords(loaded: number, total: number): string {
  if (total > 0) return `${mb(Math.min(loaded, total))} of ${mb(total)} mb`;
  return loaded > 0 ? `${mb(loaded)} mb` : '';
}

export function readerWords(loaded: number, total: number): string {
  if (total > 0 && loaded >= total) return 'starting the face reader';
  const bytes = bytesWords(loaded, total);
  return bytes ? `getting the face reader · ${bytes}` : 'getting the face reader';
}

export function loadWords({ step, loaded, total }: Pick<ModelLoad, 'step' | 'loaded' | 'total'>): string {
  if (step === 'reader') return readerWords(loaded, total);
  if (step === 'model') return 'building the model';
  const bytes = bytesWords(loaded, total);
  return bytes ? `downloading · ${bytes}` : 'opening it';
}

export function loadWordsShort({ step, loaded, total }: Pick<ModelLoad, 'step' | 'loaded' | 'total'>): string {
  if (step === 'reader') return 'face reader';
  if (step === 'model') return 'building';
  return bytesWords(loaded, total) || 'opening';
}

export function loadFraction({ loaded, total }: { loaded: number; total: number }): number | null {
  return total > 0 ? Math.min(1, loaded / total) : null;
}

interface LoadBarProps {
  loaded: number;
  total: number;
  label: string;
  onPicture?: boolean;
  className?: string;
}

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
