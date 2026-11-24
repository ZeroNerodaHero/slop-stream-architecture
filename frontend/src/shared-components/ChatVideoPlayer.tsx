import { useEffect, useRef, useState } from 'react';

import { type ChatVideo, type MediaGone, posterSrc, shownSrc, videoSrc, whyGone } from '@/infra/chat-video';
import { Button } from '@/shared-components/Button';
import { MEDIA_SIZED } from '@/infra/keyboard';
import { cn } from '@/utils/cn';

/**
 * The video on a line (docs/chat.md "videos"): the browser's own player, its poster the frame the
 * sender's page grabbed, no bytes asked for until a press on play (`preload="none"`), never
 * playing on its own. As tall as a picture is at most, five lines (`max-h-[7.5rem]`), or the
 * pins list's `small` row. Every chat draws it: a stream's, a group channel's, a direct message.
 * One an admin took down (its poster goes with it) says "removed" instead; one this viewer may not
 * see says so. One whose poster moderation flagged (a direct message's or a group channel's, the
 * api's 409) is covered, its poster blurred, until `show` is pressed.
 */
export function ChatVideoPlayer({ video, small = false }: { video: ChatVideo; small?: boolean }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const [gone, setGone] = useState<MediaGone | null>(null);
  // the poster was flagged: false while covered, true once `show` was pressed
  const [sensitive, setSensitive] = useState<boolean | null>(null);
  // the poster is asked for at once, the video only on play: a poster that will not load is the word on the video too
  useEffect(() => {
    let live = true;
    const probe = new Image();
    probe.addEventListener(
      'error',
      () =>
        void whyGone(posterSrc(video.poster)).then((why) => {
          if (!live || !why) return;
          if (why === 'sensitive') setSensitive(false);
          else setGone(why);
        }),
      { once: true }
    );
    probe.src = posterSrc(video.poster);
    return () => {
      live = false;
    };
  }, [video.poster]);
  // the poster arriving gives the player its shape, a little after the line is drawn: the list sitting at its newest line stays there (keyboard.ts `useBottomPin`)
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const seen = new ResizeObserver(() => el.dispatchEvent(new Event(MEDIA_SIZED)));
    seen.observe(el);
    return () => seen.disconnect();
    // the player is drawn again once a covered one is shown
  }, [sensitive]);
  if (gone) return <MediaGoneNote why={gone} />;
  const poster = sensitive === null ? posterSrc(video.poster) : shownSrc(posterSrc(video.poster));
  if (sensitive === false) {
    return (
      <span
        data-sensitive={video.id}
        className={cn('relative mt-1 flex flex-col items-center justify-center gap-1 overflow-hidden bg-black', small ? 'h-20 w-32' : 'h-[7.5rem] w-48', 'max-w-full')}
      >
        <img src={poster} alt="" aria-hidden draggable={false} className="absolute inset-0 h-full w-full scale-110 object-cover blur-xl" />
        <span className="relative bg-background/70 px-1 text-xs text-textPrimary">sensitive</span>
        <Button size="sm" className="relative" aria-label="show sensitive video" onClick={() => setSensitive(true)}>
          show
        </Button>
      </span>
    );
  }
  return (
    <video
      ref={ref}
      data-chat-video={video.id}
      src={videoSrc(video.id)}
      poster={poster}
      controls
      preload="none"
      playsInline
      aria-label="video"
      className={cn('mt-1 block max-w-full bg-black', small ? 'max-h-20' : 'max-h-[7.5rem]')}
    />
  );
}

/** What stands where a picture or a video was: `removed`, or `members only`. */
export function MediaGoneNote({ why, className }: { why: MediaGone; className?: string }) {
  return (
    <span data-media-gone={why} className={cn('mt-1 inline-flex items-center bg-backgroundTertiary px-2 py-1 text-xs italic text-textSecondary', className)}>
      {why}
    </span>
  );
}
