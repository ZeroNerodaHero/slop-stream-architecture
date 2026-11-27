import { RiPauseFill, RiPlayFill } from '@remixicon/react';
import { type KeyboardEvent, type PointerEvent, useEffect, useRef, useState } from 'react';

import { audioSrc, barsOf, type ChatAudio, clockOf, markPlayed, PEAK_COUNT, wasPlayed } from '@/infra/chat-audio';
import { type MediaGone, whyGone } from '@/infra/chat-video';
import { MediaGoneNote } from '@/shared-components/ChatVideoPlayer';
import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

let playing: HTMLAudioElement | null = null;

export const AUDIO_BUTTON =
  'flex h-7 w-7 shrink-0 items-center justify-center rounded-control border border-primaryStroke bg-background text-textPrimary transition-colors duration-100 hover:border-primaryBlue hover:bg-backgroundTertiary focus-visible:border-primaryBlue focus-visible:outline-none max-md:h-11 max-md:w-11';

const STRIP_BUTTON =
  'relative flex shrink-0 items-center justify-center rounded-control border border-primaryStroke bg-background text-textPrimary transition-colors duration-100 hover:border-primaryBlue hover:bg-backgroundTertiary focus-visible:border-primaryBlue focus-visible:outline-none';

const STEP_MS = 1000;
const PAGE_MS = 5000;

export type StripSize = 'sent' | 'bar';

const SIZES: Record<StripSize, { strip: string; button: string; icon: number; tall: number }> = {
  sent: { strip: 'h-9 w-64 pl-1 pr-2 max-md:h-11', button: 'h-[22px] w-[22px] max-md:h-8 max-md:w-8', icon: 13, tall: 18 },
  bar: { strip: 'h-7 pl-1 pr-2 max-md:h-11', button: 'h-5 w-5 max-md:h-8 max-md:w-8', icon: 12, tall: 16 }
};

export function WaveBars({ bars, lit, tall, className }: { bars: readonly number[]; lit: number; tall: number; className?: string }) {
  return (
    <span aria-hidden className={cn('relative flex min-w-0 flex-1 items-center justify-between gap-px overflow-hidden', className)} style={{ height: tall }}>
      {bars.map((v, i) => (
        <span
          key={i}
          className={cn('block w-0.5 shrink-0', i < lit ? 'bg-textPrimary' : 'bg-textTertiary')}
          style={{ height: Math.round(3 + Math.min(1, Math.max(0, v)) * (tall - 3)) }}
        />
      ))}
    </span>
  );
}

export function StripFill({ part, tone = 'blue' }: { part: number; tone?: 'blue' | 'red' }) {
  if (part <= 0) return null;
  const pct = `${Math.min(1, part) * 100}%`;
  return (
    <>
      <span aria-hidden className={cn('pointer-events-none absolute inset-y-0 left-0', tone === 'red' ? 'bg-decrease/20' : 'bg-primaryBlue/20')} style={{ width: pct }} />
      <span aria-hidden className={cn('pointer-events-none absolute inset-y-0 w-0.5', tone === 'red' ? 'bg-decrease' : 'bg-primaryBlue')} style={{ left: `calc(${pct} - 2px)` }} />
    </>
  );
}

export function AudioPlayer({
  src,
  durationMs,
  peaks,
  id,
  label = 'voice message',
  size = 'sent',
  className,
  onFailed
}: {
  src: string;
  durationMs: number;
  peaks?: readonly number[];
  id?: string;
  label?: string;
  size?: StripSize;
  className?: string;
  onFailed?: () => void;
}) {
  const el = useRef<HTMLAudioElement | null>(null);
  const strip = useRef<HTMLSpanElement | null>(null);
  const dragging = useRef(false);
  const [on, setOn] = useState(false);
  const [at, setAt] = useState(0);
  const [learned, setLearned] = useState<number | null>(null);
  const [played, setPlayed] = useState(() => (id ? wasPlayed(id) : true));
  const total = learned ?? durationMs;
  const end = Math.max(total, at, 1);
  const part = Math.min(1, at / end);
  const bars = barsOf(peaks, PEAK_COUNT);
  const lit = at > 0 ? Math.round(part * bars.length) : 0;
  const look = SIZES[size];

  useEffect(
    () => () => {
      if (playing === el.current) playing = null;
    },
    []
  );

  useEffect(() => {
    if (!on) return;
    let frame = 0;
    const tick = () => {
      const audio = el.current;
      if (audio && !dragging.current) setAt(Math.round(audio.currentTime * 1000));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [on]);

  function heard() {
    if (played) return;
    setPlayed(true);
    if (id) markPlayed(id);
  }

  function toggle() {
    const audio = el.current;
    if (!audio) return;
    if (!audio.paused) {
      audio.pause();
      return;
    }
    if (playing && playing !== audio) playing.pause();
    playing = audio;
    void audio.play().catch(() => setOn(false));
  }

  function seek(ms: number) {
    const audio = el.current;
    if (!audio || !Number.isFinite(ms)) return;
    const to = Math.min(Math.max(0, ms), end);
    audio.currentTime = to / 1000;
    setAt(to);
  }

  function seekAt(clientX: number) {
    const box = strip.current?.getBoundingClientRect();
    if (!box || box.width <= 0) return;
    seek(((clientX - box.left) / box.width) * end);
  }

  function onPointerDown(e: PointerEvent<HTMLSpanElement>) {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    seekAt(e.clientX);
  }

  function onPointerMove(e: PointerEvent<HTMLSpanElement>) {
    if (dragging.current) seekAt(e.clientX);
  }

  function onPointerUp(e: PointerEvent<HTMLSpanElement>) {
    if (!dragging.current) return;
    dragging.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  }

  function onKey(e: KeyboardEvent<HTMLSpanElement>) {
    const moves: Record<string, number> = {
      ArrowRight: at + STEP_MS,
      ArrowUp: at + STEP_MS,
      ArrowLeft: at - STEP_MS,
      ArrowDown: at - STEP_MS,
      PageUp: at + PAGE_MS,
      PageDown: at - PAGE_MS,
      Home: 0,
      End: end
    };
    const to = moves[e.key];
    if (to !== undefined) {
      e.preventDefault();
      seek(to);
      return;
    }
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      toggle();
    }
  }

  function learn() {
    const seconds = el.current?.duration;
    if (seconds !== undefined && Number.isFinite(seconds) && seconds > 0) setLearned(Math.round(seconds * 1000));
  }

  const fresh = !played;
  return (
    <span
      ref={strip}
      data-chat-audio={id}
      data-playing={on || undefined}
      data-unplayed={fresh || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      className={cn(
        'relative mt-1 flex max-w-full cursor-pointer touch-pan-y select-none items-center gap-2 overflow-hidden rounded-card border border-primaryStroke bg-backgroundSecondary transition-colors duration-100 has-[[role=slider]:focus-visible]:border-primaryBlue [[data-bubble]_&]:border-0 [[data-bubble]_&]:bg-transparent [[data-bubble]_&]:pl-0',
        look.strip,
        fresh && 'border-l-2 border-l-primaryBlue [[data-bubble]_&]:border-l-2 [[data-bubble]_&]:pl-1',
        className
      )}
    >
      <StripFill part={at > 0 ? part : 0} />
      <Tooltip content={on ? 'pause' : 'play'} hideOnPress>
        <button type="button" aria-label={on ? `pause ${label}` : `play ${label}`} aria-pressed={on} onClick={toggle} className={cn(STRIP_BUTTON, look.button)}>
          {on ? <RiPauseFill aria-hidden size={look.icon} /> : <RiPlayFill aria-hidden size={look.icon} />}
        </button>
      </Tooltip>
      <span
        role="slider"
        tabIndex={0}
        aria-label={`seek ${label}`}
        aria-valuemin={0}
        aria-valuemax={end}
        aria-valuenow={Math.min(at, end)}
        aria-valuetext={`${clockOf(at)} of ${clockOf(total)}`}
        onKeyDown={onKey}
        className="relative flex h-full min-w-0 flex-1 items-center gap-2 focus-visible:outline-none"
      >
        <WaveBars bars={bars} lit={lit} tall={look.tall} />
        <span className={cn('shrink-0 text-xs tabular-nums', played && !on && at === 0 && id ? 'text-textTertiary' : 'text-textPrimary')}>
          {clockOf(on || at > 0 ? at : total)}
        </span>
      </span>
      <audio
        ref={el}
        src={src}
        preload="metadata"
        onPlay={() => {
          setOn(true);
          heard();
        }}
        onPause={() => setOn(false)}
        onEnded={() => {
          setOn(false);
          setAt(0);
          if (el.current) el.current.currentTime = 0;
        }}
        onTimeUpdate={() => {
          if (!dragging.current) setAt(Math.round((el.current?.currentTime ?? 0) * 1000));
        }}
        onLoadedMetadata={learn}
        onDurationChange={learn}
        onError={onFailed}
        className="hidden"
      />
    </span>
  );
}

export function ChatAudioPlayer({ audio, small = false }: { audio: ChatAudio; small?: boolean }) {
  const [gone, setGone] = useState<{ id: string; why: MediaGone } | null>(null);
  const src = audioSrc(audio.id);
  if (gone?.id === audio.id) return <MediaGoneNote why={gone.why} />;
  return (
    <AudioPlayer
      key={audio.id}
      src={src}
      durationMs={audio.duration_ms}
      peaks={audio.peaks}
      id={audio.id}
      className={small ? 'w-52' : undefined}
      onFailed={() =>
        void whyGone(src).then((why) => {
          if (why && why !== 'sensitive') setGone({ id: audio.id, why });
        })
      }
    />
  );
}
