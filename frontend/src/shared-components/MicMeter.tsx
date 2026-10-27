import type { Atom } from 'jotai';
import { type RefObject, useEffect, useRef, useState } from 'react';

import { type MicLevel, openMicLevel } from '@/infra/mic-level';
import { store } from '@/infra/store';
import { CHIP, ControlTip } from '@/shared-components/VideoControls';
import { cn } from '@/utils/cn';

/** What the mic is giving: sound, nothing for now (the browser or the os has it muted), or there is no mic at all. */
type MicState = 'on' | 'muted' | 'none';

const WORDS: Record<MicState, string> = { on: 'mic level', muted: 'mic muted', none: 'no mic' };

/** The bar in the 24-unit box: this tall, standing on this line. */
const BAR_H = 20;
const BAR_BOTTOM = 22;

interface MicMeterProps {
  id: string;
  /** The stream whose first audio track is measured: the camera's. Its mute and end are the chip's words either way. */
  streamAtom: Atom<MediaStream | null>;
  /** A reader to paint from instead of opening the track (the mixer's mic row, while it is up: the mic is never opened twice). Mount-only, like the stream. */
  read?: (now: number) => number;
  /** Where in the picture's top left corner it sits: the offset the player's other chips use. */
  className?: string;
}

function stateOf(track: MediaStreamTrack | undefined): MicState {
  if (!track || track.readyState === 'ended') return 'none';
  return track.muted || !track.enabled ? 'muted' : 'on';
}

/**
 * An angular mic (a capsule in its cradle, on a stand; the theme has no arcs) and, beside it,
 * the bar: a faint track the solid part grows up from the bottom of, as loud as the mic is
 * right now. With nothing coming the capsule is hollow and struck through.
 */
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

/**
 * The mic's level, in the picture's top left corner while the stream is up: a dark chip with
 * a bar in it that rises with every word and falls more slowly, so the streamer can see the
 * mic is picking them up, and how loud. Many readings a second, so the bar is drawn by hand
 * from a frame loop (`mic-level.ts` reads, this paints) and never through react; only the
 * state words (hollow and struck through, `mic muted` or `no mic` on hover) are state. Not a
 * control: there is nothing here to press.
 */
export function MicMeter({ id, streamAtom, read, className = 'left-3 top-3' }: MicMeterProps) {
  const root = useRef<HTMLDivElement>(null);
  const fill = useRef<SVGRectElement>(null);
  const [state, setState] = useState<MicState>('none');

  // Mount only: follow the stream atom, measure its audio track, paint. The binding uses
  // `store.sub`, the way `VideoFrame` binds a stream to its <video>.
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    // the window the chip is in: the page's, or the popped out player's, whose frames keep coming while the page's tab is hidden
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
        reader = read ? { read, close: () => undefined } : openMicLevel(track);
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
