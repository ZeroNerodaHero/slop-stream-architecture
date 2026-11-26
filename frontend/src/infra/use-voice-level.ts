import type { Atom } from 'jotai';
import { type RefObject, useEffect } from 'react';

import { type MicLevel, openMicLevel } from '@/infra/mic-level';
import { store } from '@/infra/store';

export interface VoiceSource {
  streamAtom: Atom<MediaStream | null>;
  read?: (now: number) => number;
}

export type VoiceDraw = (level: number, now: number, instant: boolean) => void;

export function useVoiceLevel<T extends HTMLElement>(ref: RefObject<T | null>, source: VoiceSource, draw: (el: T, win: Window) => VoiceDraw): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const win = el.ownerDocument.defaultView ?? window;
    const { streamAtom, read } = source;
    const move = draw(el, win);
    let track: MediaStreamTrack | undefined;
    let reader: MicLevel | null = null;
    let frame = 0;

    const paint = (now: number) => {
      frame = 0;
      if (!reader) return;
      move(reader.read(now), now, false);
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
      move(0, win.performance.now(), true);
      if (reader && !frame) frame = win.requestAnimationFrame(paint);
    };

    move(0, win.performance.now(), true);
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
}
