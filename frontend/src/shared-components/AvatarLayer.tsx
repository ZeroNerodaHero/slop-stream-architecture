import type { Atom } from 'jotai';
import { useEffect, useRef } from 'react';

import { api } from '@/infra/api';
import { type MicLevel, openMicLevel } from '@/infra/mic-level';
import { store } from '@/infra/store';
import { colorOf } from '@/shared-components/GeneratedAvatar';

export interface AvatarVoice {
  name: string;
  version: number | null;
  streamAtom: Atom<MediaStream | null>;
  read?: (now: number) => number;
}

const FILL = 0.84;
const QUIET = 0.2;
const LOUD = 0.7;
const GROW = 0.1;
const LIFT = 3;
const SPEAKING = 0.1;

interface AvatarLayerProps {
  id: string;
  wide: boolean;
  voice: AvatarVoice;
}

export function AvatarLayer({ id, wide, voice }: AvatarLayerProps) {
  const pic = useRef<HTMLDivElement | null>(null);
  const { name, version, streamAtom, read } = voice;

  useEffect(() => {
    const el = pic.current;
    if (!el) return;
    const win = el.ownerDocument.defaultView ?? window;
    const still = win.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let track: MediaStreamTrack | undefined;
    let reader: MicLevel | null = null;
    let frame = 0;
    let shown = -1;

    const move = (level: number) => {
      const v = Math.min(1, Math.max(0, (level - QUIET) / (LOUD - QUIET)));
      const pct = Math.round(v * 100);
      if (pct === shown) return;
      shown = pct;
      if (!still) el.style.transform = `translateY(${-LIFT * v}%) scale(${1 + GROW * v})`;
      el.dataset.voice = String(pct);
      if (v > SPEAKING) el.dataset.speaking = '';
      else delete el.dataset.speaking;
    };
    const paint = (now: number) => {
      frame = 0;
      if (!reader) return;
      move(reader.read(now));
      frame = win.requestAnimationFrame(paint);
    };
    const resume = () => reader?.resume();
    const unbind = () => {
      reader?.close();
      reader = null;
      track = undefined;
    };
    const bind = () => {
      const next = store.get(streamAtom)?.getAudioTracks()[0];
      if (next === track) return;
      unbind();
      track = next;
      if (track) reader = read ? { read, resume: () => undefined, close: () => undefined } : openMicLevel(track);
      move(0);
      if (reader && !frame) frame = win.requestAnimationFrame(paint);
    };

    move(0);
    bind();
    const unsub = store.sub(streamAtom, bind);
    win.addEventListener('pointerdown', resume, true);
    win.addEventListener('keydown', resume, true);
    return () => {
      unsub();
      win.removeEventListener('pointerdown', resume, true);
      win.removeEventListener('keydown', resume, true);
      if (frame) win.cancelAnimationFrame(frame);
      unbind();
    };
  }, []);

  const key = name.trim().toLowerCase();
  return (
    <div className="flex h-full w-full items-center justify-center">
      <div
        ref={pic}
        id={id}
        aria-hidden
        data-voice="0"
        style={wide ? { height: `${FILL * 100}%` } : { width: `${FILL * 100}%` }}
        className="aspect-square overflow-hidden rounded-avatar border-2 border-primaryStroke bg-backgroundTertiary transition-[transform,border-color] duration-75 data-[speaking]:border-primaryBlue motion-reduce:transition-none"
      >
        {version !== null ? (
          <img src={api.avatarUrl(name, version)} alt="" draggable={false} className="block h-full w-full object-cover" />
        ) : (
          <svg viewBox="0 0 100 100" className="block h-full w-full" style={key ? { backgroundColor: colorOf(key) } : undefined}>
            <text x="50" y="50" textAnchor="middle" dominantBaseline="central" fontSize="56" fontWeight="600" fill={key ? 'white' : 'currentColor'}>
              {key ? [...key][0]!.toUpperCase() : '?'}
            </text>
          </svg>
        )}
      </div>
    </div>
  );
}
