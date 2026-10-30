import type { Atom } from 'jotai';
import { useEffect, useRef } from 'react';

import { api } from '@/infra/api';
import { type MicLevel, openMicLevel } from '@/infra/mic-level';
import { store } from '@/infra/store';
import { colorOf } from '@/shared-components/GeneratedAvatar';

/** Whose picture an avatar layer shows, and the sound that moves it. */
export interface AvatarVoice {
  /** The stream's name: the picture is the one saved under it, else the letter the name makes. */
  name: string;
  /** The picture's upload time (the `?v=` of its url), or null for none. */
  version: number | null;
  /** The stream whose first audio track moves the picture: the mic on the go live page, the sound arriving on a watcher's. */
  streamAtom: Atom<MediaStream | null>;
  /** A reader to move from instead of opening the track (the mixer's mic row, while it is up: the mic is never opened twice). Mount-only, like the stream. */
  read?: (now: number) => number;
}

/** The picture takes this much of the box's shorter side; the rest is room to grow into without being cut. */
const FILL = 0.84;
/** mic-level's bar at which the voice begins (room noise stays under it) and at which it is all the way up: -40 and -15 dBFS. */
const QUIET = 0.2;
const LOUD = 0.7;
/** All the way up, the picture is this much bigger and this much of its own height higher: a nod, not a jump. */
const GROW = 0.1;
const LIFT = 3;
/** Past this much voice the border is blue: the ring that says who is talking. */
const SPEAKING = 0.1;

interface AvatarLayerProps {
  id: string;
  /** The box is wider than it is tall on the frame: the picture's side is the box's height then, else its width. */
  wide: boolean;
  voice: AvatarVoice;
}

/**
 * The streamer's avatar as a layer of the frame (docs/screen.md): their profile picture, or
 * the letter their name makes, a square centred in the box, moving with the voice the way a
 * png avatar does. Both sides draw it from the name alone; what moves it is the sound each
 * side has (the mic here, the opus arriving there), so nothing about it travels but its box,
 * no picture is encoded, and it moves while the streamer is in another tab. Many readings a
 * second, so the motion is written straight onto the element from a frame loop (`mic-level.ts`
 * reads, this moves) and never through react: `transform` for the nod, `data-speaking` for the
 * ring, `data-voice` 0..100 for the tests. Someone who asked for less motion gets the ring alone.
 */
export function AvatarLayer({ id, wide, voice }: AvatarLayerProps) {
  const pic = useRef<HTMLDivElement | null>(null);
  const { name, version, streamAtom, read } = voice;

  // Mount only: follow the stream atom, measure its audio track, move. Bound with `store.sub`,
  // the way `MicMeter` and `VideoFrame` bind a stream.
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
    // a context made with no click behind it (a watcher's page, freshly loaded) runs from the first click or key anywhere
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
        className="aspect-square overflow-hidden border-2 border-primaryStroke bg-backgroundTertiary transition-[transform,border-color] duration-75 data-[speaking]:border-primaryBlue motion-reduce:transition-none"
      >
        {version !== null ? (
          <img src={api.avatarUrl(name, version)} alt="" draggable={false} className="block h-full w-full object-cover" />
        ) : (
          // the letter tile GeneratedAvatar makes, as an svg so the letter is the size of the box at any size
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
