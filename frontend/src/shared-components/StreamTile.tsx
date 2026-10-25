import type { Atom } from 'jotai';
import { type ReactNode, useRef } from 'react';

import { CHIP } from '@/shared-components/VideoControls';
import { VideoFrame } from '@/shared-components/VideoFrame';
import { cn } from '@/utils/cn';

interface StreamTileProps {
  /** On the button when the tile can be picked, else on the box; the picture is `<id>-video`. */
  id: string;
  /** The picture, muted: sound comes out of the big video only. */
  streamAtom: Atom<MediaStream | null>;
  label: string;
  /** Clicking the picture does this (the watch page: show it big). Without it the tile is only a picture. */
  onPick?: () => void;
  /** Sits top right over the picture (the live page's stop). */
  corner?: ReactNode;
  className?: string;
}

/**
 * A small picture of one slot: a shared screen beside the camera, or the camera beside a
 * shared screen. 16:9 at 160px with its name in the corner, like the cards' chip. The watch
 * page's tiles are buttons that make their slot the big one; the live page's carry a stop.
 */
export function StreamTile({ id, streamAtom, label, onPick, corner, className }: StreamTileProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const picture = <VideoFrame id={`${id}-video`} streamAtom={streamAtom} videoRef={videoRef} muted className="border-0" />;
  return (
    <div
      id={onPick ? undefined : id}
      className={cn(
        'relative w-40 shrink-0 border border-primaryStroke bg-black transition-colors duration-150',
        onPick && 'hover:border-primaryBlue [&:has(:focus-visible)]:border-primaryBlue',
        className
      )}
    >
      {onPick ? (
        <button id={id} type="button" aria-label={`show ${label} big`} onClick={onPick} className="block w-full outline-none">
          {picture}
        </button>
      ) : (
        picture
      )}
      <span className={cn(CHIP, 'pointer-events-none absolute bottom-1 left-1 h-6 px-2 text-xs')}>{label}</span>
      {corner && <div className="absolute right-1 top-1">{corner}</div>}
    </div>
  );
}
