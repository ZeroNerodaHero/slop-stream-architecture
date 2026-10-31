import { useEffect, useRef, useState } from 'react';

import { api } from '@/infra/api';
import { cn } from '@/utils/cn';

/** How often a new frame is asked for: video writes one every `THUMB_EVERY_SECS` (5) and serves it for 3 (video/src/thumbs.rs). */
const EVERY_MS = 5000;

interface StreamStillProps {
  name: string;
  /** The box's size (`h-10` for a row, `w-full` for a card); it is 16:9 either way. */
  className?: string;
}

/**
 * A frame of `name`'s stream, a few seconds old: `GET /thumb/<name>.jpg`, the picture video's
 * ffmpeg writes beside every live stream (docs/spec.md). Asked again every 5s while on screen,
 * each new frame fetched off screen first and swapped in once it has arrived, so the picture
 * never blinks to nothing between two. Not there (a stream younger than ~6s has no frame yet)
 * or gone stale (video says 404 rather than serve a frozen frame as live): the box alone,
 * black, until the next ask. A still whose own document is hidden asks nothing: the tab's, or
 * the popped-out player's window's (PersonCard.tsx mounts the card in the row's document), each
 * on its own. For a name that is streaming: the one showing it decides that (the sidebar's row
 * and the person card, on `presence`).
 */
export function StreamStill({ name, className }: StreamStillProps) {
  // the frame with the name it is of, so a row that changes names shows nothing until the new name's frame is in
  const [frame, setFrame] = useState<{ name: string; url: string } | null>(null);
  // the box, for the document it is in: the module's `document` is the main page's, and the popout is another
  const box = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    let gone = false;
    // the latest ask: an earlier one landing after it (a slow frame) must not put an older picture over a newer
    let latest: HTMLImageElement | null = null;
    const ask = () => {
      if ((box.current?.ownerDocument ?? document).hidden) return;
      const url = api.thumbUrl(name, Math.floor(Date.now() / EVERY_MS));
      const img = new Image();
      latest = img;
      img.onload = () => {
        if (!gone && latest === img) setFrame({ name, url });
      };
      img.onerror = () => {
        if (!gone && latest === img) setFrame(null);
      };
      img.src = url;
    };
    ask();
    const timer = window.setInterval(ask, EVERY_MS);
    return () => {
      gone = true;
      window.clearInterval(timer);
    };
  }, [name]);

  const src = frame?.name === name ? frame.url : null;
  return (
    <span ref={box} className={cn('relative block aspect-video shrink-0 overflow-hidden border border-primaryStroke bg-black', className)}>
      {/* the word beside it says streaming; the picture is the look of it */}
      {src && <img src={src} alt="" draggable={false} data-still={name} className="absolute inset-0 h-full w-full object-cover" />}
    </span>
  );
}
