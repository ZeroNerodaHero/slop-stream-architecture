import { cn } from '@/utils/cn';

interface OfflinePictureProps {
  /** On the `<img>`, where tests and pages look for the picture (`#offline-picture`). */
  id: string;
  src: string;
  /** The box's size (`w-full` for a card, with any margin); it is 16:9 either way. */
  className?: string;
}

/**
 * The picture shown where a stream would be while the name is not streaming: their offline
 * picture (WatchPage.tsx, ProfilePopup.tsx), dimmed and lightly desaturated so it does not read
 * as a live frame, with the word over it saying so. The wrapper is `relative`, so the word's `absolute`
 * has its place inside this box.
 */
export function OfflinePicture({ id, src, className }: OfflinePictureProps) {
  return (
    <span className={cn('relative block aspect-video overflow-hidden border border-primaryStroke bg-black', className)}>
      <img id={id} src={src} alt="" draggable={false} className="absolute inset-0 h-full w-full object-cover opacity-80 [filter:grayscale(25%)]" />
      <span aria-hidden className="absolute inset-0 bg-black/10" />
      <span className="absolute inset-0 flex items-center justify-center p-3">
        <span className="border border-white/10 bg-black/70 px-3 py-1 text-sm font-semibold uppercase tracking-wide text-white backdrop-blur-sm">
          not streaming yet
        </span>
      </span>
    </span>
  );
}
