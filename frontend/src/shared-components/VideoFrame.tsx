import type { Atom } from 'jotai';
import { type RefObject, useEffect } from 'react';

import { store } from '@/infra/store';
import { cn } from '@/utils/cn';

interface VideoFrameProps {
  id: string;
  streamAtom: Atom<MediaStream | null>;
  videoRef: RefObject<HTMLVideoElement | null>;
  muted?: boolean;
  volume?: number;
  onPlaying?: () => void;
  onAutoplayBlocked?: () => void;
  className?: string;
}

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
