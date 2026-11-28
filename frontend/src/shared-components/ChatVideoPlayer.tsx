import { useEffect, useState } from 'react';

import { type ChatVideo, type MediaGone, posterSrc, shownSrc, videoSrc, whyGone } from '@/infra/chat-video';
import { Button } from '@/shared-components/Button';
import { MEDIA_SIZED } from '@/infra/keyboard';
import { cn } from '@/utils/cn';

export function ChatVideoPlayer({ video, small = false }: { video: ChatVideo; small?: boolean }) {
  const [gone, setGone] = useState<MediaGone | null>(null);
  const [sensitive, setSensitive] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    const probe = new Image();
    const onError = () =>
      void whyGone(posterSrc(video.poster)).then((why) => {
        if (!live || !why) return;
        if (why === 'sensitive') setSensitive(false);
        else setGone(why);
      });
    probe.addEventListener('error', onError, { once: true });
    probe.src = posterSrc(video.poster);
    return () => {
      live = false;
      probe.removeEventListener('error', onError);
      probe.src = '';
    };
  }, [video.poster]);
  if (gone) return <MediaGoneNote why={gone} />;
  const poster = sensitive === null ? posterSrc(video.poster) : shownSrc(posterSrc(video.poster));
  if (sensitive === false) {
    return (
      <span
        data-sensitive={video.id}
        className={cn('relative mt-1 flex flex-col items-center justify-center gap-1 overflow-hidden bg-black', small ? 'h-20 w-32' : 'h-[7.5rem] w-48', 'max-w-full')}
      >
        <span className="relative bg-background/70 px-1 text-xs text-textPrimary">sensitive</span>
        <Button size="sm" className="relative" aria-label="show sensitive video" onClick={() => setSensitive(true)}>
          show
        </Button>
      </span>
    );
  }
  return (
    <video
      ref={reportSize}
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

function reportSize(el: HTMLVideoElement): () => void {
  const seen = new ResizeObserver(() => el.dispatchEvent(new Event(MEDIA_SIZED)));
  seen.observe(el);
  return () => seen.disconnect();
}

const GONE_WORDS: Record<MediaGone, string> = {
  removed: 'removed',
  'members only': 'members only',
  hidden: 'hidden: adult content is off in this group',
};

export function MediaGoneNote({ why, className }: { why: MediaGone; className?: string }) {
  return (
    <span data-media-gone={why} className={cn('mt-1 inline-flex items-center bg-backgroundTertiary px-2 py-1 text-xs italic text-textSecondary', className)}>
      {GONE_WORDS[why]}
    </span>
  );
}
