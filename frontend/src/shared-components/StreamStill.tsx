import { useEffect, useRef, useState } from 'react';

import { api } from '@/infra/api';
import { cn } from '@/utils/cn';

const EVERY_MS = 5000;

interface StreamStillProps {
  name: string;
  className?: string;
}

export function StreamStill({ name, className }: StreamStillProps) {
  const [frame, setFrame] = useState<{ name: string; url: string } | null>(null);
  const box = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    let gone = false;
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
      {src && <img src={src} alt="" draggable={false} data-still={name} className="absolute inset-0 h-full w-full object-cover" />}
    </span>
  );
}
