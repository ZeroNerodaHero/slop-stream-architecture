import type { Atom } from 'jotai';
import { type RefObject, useEffect } from 'react';

import { store } from '@/infra/store';
import { cn } from '@/utils/cn';

interface VideoFrameProps {
  id: string;
  /** The MediaStream to show. Bound imperatively: a stream is not render data. */
  streamAtom: Atom<MediaStream | null>;
  videoRef: RefObject<HTMLVideoElement | null>;
  muted?: boolean;
  /** 0..1. A property of the element only (no attribute), so it is set by hand as it changes. Left alone when absent. */
  volume?: number;
  onPlaying?: () => void;
  onAutoplayBlocked?: () => void;
  className?: string;
}

/**
 * A <video> that follows a MediaStream atom. The binding uses `store.sub` from a mount-only
 * effect, the way imperative DOM updates are wired at the data source, instead of an effect
 * that reacts to the stream value.
 */
export function VideoFrame({ id, streamAtom, videoRef, muted = true, volume, onPlaying, onAutoplayBlocked, className }: VideoFrameProps) {
  useEffect(() => {
    if (volume !== undefined && videoRef.current) videoRef.current.volume = volume;
  }, [volume]);

  useEffect(() => {
    const apply = () => {
      const el = videoRef.current;
      if (!el) return;
      const stream = store.get(streamAtom);
      if (el.srcObject === stream) return;
      el.srcObject = stream;
      if (stream) {
        el.play().catch((err: unknown) => {
          if (err instanceof DOMException && err.name === 'NotAllowedError') onAutoplayBlocked?.();
        });
      }
    };
    apply();
    return store.sub(streamAtom, apply);
  }, []);

  return (
    <video
      id={id}
      ref={videoRef}
      autoPlay
      playsInline
      muted={muted}
      onPlaying={onPlaying}
      className={cn('block aspect-video w-full border border-primaryStroke bg-black', className)}
    />
  );
}
