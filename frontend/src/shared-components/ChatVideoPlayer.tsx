import { useEffect, useRef } from 'react';

import { type ChatVideo, posterSrc, videoSrc } from '@/infra/chat-video';
import { MEDIA_SIZED } from '@/infra/keyboard';
import { cn } from '@/utils/cn';

/**
 * The video on a line (docs/chat.md "videos"): the browser's own player, its poster the frame the
 * sender's page grabbed, no bytes asked for until a press on play (`preload="none"`), never
 * playing on its own. As tall as a picture is at most, five lines (`max-h-[7.5rem]`), or the
 * pins list's `small` row. Every chat draws it: a stream's, a group channel's, a direct message.
 */
export function ChatVideoPlayer({ video, small = false }: { video: ChatVideo; small?: boolean }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  // the poster arriving gives the player its shape, a little after the line is drawn: the list sitting at its newest line stays there (keyboard.ts `useBottomPin`)
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const seen = new ResizeObserver(() => el.dispatchEvent(new Event(MEDIA_SIZED)));
    seen.observe(el);
    return () => seen.disconnect();
  }, []);
  return (
    <video
      ref={ref}
      data-chat-video={video.id}
      src={videoSrc(video.id)}
      poster={posterSrc(video.poster)}
      controls
      preload="none"
      playsInline
      aria-label="video"
      className={cn('mt-1 block max-w-full bg-black', small ? 'max-h-20' : 'max-h-[7.5rem]')}
    />
  );
}
