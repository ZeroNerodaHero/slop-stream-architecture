import type { Atom } from 'jotai';
import { type RefObject, useEffect, useRef, useState } from 'react';

import { type MicLevel, openMicLevel } from '@/infra/mic-level';
import { store } from '@/infra/store';
import { CHIP, ControlTip } from '@/shared-components/VideoControls';
import { cn } from '@/utils/cn';

type MicState = 'on' | 'muted' | 'none';

const WORDS: Record<MicState, string> = { on: 'mic level', muted: 'mic muted', none: 'no mic' };

const BAR_H = 20;
const BAR_BOTTOM = 22;

interface MicMeterProps {
  id: string;
  streamAtom: Atom<MediaStream | null>;
  read?: (now: number) => number;
  className?: string;
}

function stateOf(track: MediaStreamTrack | undefined): MicState {
  if (!track || track.readyState === 'ended') return 'none';
  return track.muted || !track.enabled ? 'muted' : 'on';
}

function MicIcon({ state, fillRef }: { state: MicState; fillRef: RefObject<SVGRectElement | null> }) {
  const off = state !== 'on';
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="miter">
      <rect x={4} y={2} width={6} height={11} fill={off ? 'none' : 'currentColor'} />
      <path d="M2 10v4h10v-4" />
      <path d="M7 14v5M4 19h6" />
      {off && <path d="M1 20L13 2" />}
      <rect x={15} y={2} width={7} height={BAR_H} fill="currentColor" stroke="none" opacity={0.25} />
      <rect ref={fillRef} x={15} y={BAR_BOTTOM} width={7} height={0} fill="currentColor" stroke="none" />
    </svg>
  );
}

export function MicMeter({ id, streamAtom, read, className = 'left-3 top-3' }: MicMeterProps) {
  const root = useRef<HTMLDivElement>(null);
  const fill = useRef<SVGRectElement>(null);
  const [state, setState] = useState<MicState>('none');

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const win = el.ownerDocument.defaultView ?? window;
    let track: MediaStreamTrack | undefined;
    let reader: MicLevel | null = null;
    let frame = 0;
    let shownPct = -1;

    const draw = (level: number) => {
      const h = Math.round(level * BAR_H * 10) / 10;
      fill.current?.setAttribute('y', String(BAR_BOTTOM - h));
      fill.current?.setAttribute('height', String(h));
      const pct = Math.round(level * 100);
      if (pct === shownPct) return;
      shownPct = pct;
      el.setAttribute('aria-valuenow', String(pct));
    };
    const paint = (now: number) => {
      frame = 0;
      if (!reader) return;
      draw(reader.read(now));
      frame = win.requestAnimationFrame(paint);
    };
    const onTrack = () => setState(stateOf(track));
    const unbind = () => {
      if (track) {
        track.removeEventListener('mute', onTrack);
        track.removeEventListener('unmute', onTrack);
        track.removeEventListener('ended', onTrack);
      }
      reader?.close();
      reader = null;
      track = undefined;
    };
    const bind = () => {
      const next = store.get(streamAtom)?.getAudioTracks()[0];
      if (next === track) return;
      unbind();
      track = next;
      if (track) {
        track.addEventListener('mute', onTrack);
        track.addEventListener('unmute', onTrack);
        track.addEventListener('ended', onTrack);
        reader = read ? { read, resume: () => undefined, close: () => undefined } : openMicLevel(track);
      }
      setState(stateOf(track));
      draw(0);
      if (reader && !frame) frame = win.requestAnimationFrame(paint);
    };

    draw(0);
    bind();
    const unsub = store.sub(streamAtom, bind);
    return () => {
      unsub();
      if (frame) win.cancelAnimationFrame(frame);
      unbind();
    };
  }, []);

  return (
    <div
      ref={root}
      id={id}
      role="meter"
      aria-label="mic level"
      aria-valuemin={0}
      aria-valuemax={100}
      data-mic={state}
      className={cn(CHIP, 'group/control absolute z-20 w-8 justify-center', state !== 'on' && 'text-white/60', className)}
    >
      <MicIcon state={state} fillRef={fill} />
      <ControlTip at="below-left">{WORDS[state]}</ControlTip>
    </div>
  );
}
