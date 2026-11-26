import { RiPauseFill, RiPlayFill } from '@remixicon/react';
import { useEffect, useRef, useState } from 'react';

import { audioSrc, type ChatAudio, clockOf } from '@/infra/chat-audio';
import { type MediaGone, whyGone } from '@/infra/chat-video';
import { MediaGoneNote } from '@/shared-components/ChatVideoPlayer';
import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

let playing: HTMLAudioElement | null = null;

export const AUDIO_BUTTON =
  'flex h-7 w-7 shrink-0 items-center justify-center rounded-control border border-primaryStroke bg-background text-textPrimary transition-colors duration-100 hover:border-primaryBlue hover:bg-backgroundTertiary focus-visible:border-primaryBlue focus-visible:outline-none max-md:h-11 max-md:w-11';

export function AudioPlayer({
  src,
  durationMs,
  id,
  label = 'voice message',
  className,
  onFailed
}: {
  src: string;
  durationMs: number;
  id?: string;
  label?: string;
  className?: string;
  onFailed?: () => void;
}) {
  const el = useRef<HTMLAudioElement | null>(null);
  const [on, setOn] = useState(false);
  const [at, setAt] = useState(0);
  const [learned, setLearned] = useState<number | null>(null);
  const total = learned ?? durationMs;

  useEffect(
    () => () => {
      if (playing === el.current) playing = null;
    },
    []
  );

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
    audio.currentTime = ms / 1000;
    setAt(ms);
  }

  function learn() {
    const seconds = el.current?.duration;
    if (seconds !== undefined && Number.isFinite(seconds) && seconds > 0) setLearned(Math.round(seconds * 1000));
  }

  const end = Math.max(total, at, 1);
  return (
    <span
      data-chat-audio={id}
      data-playing={on || undefined}
      className={cn('mt-1 flex w-64 max-w-full items-center gap-2 rounded-control border border-primaryStroke bg-backgroundSecondary px-1.5 py-1', className)}
    >
      <Tooltip content={on ? 'pause' : 'play'} hideOnPress>
        <button type="button" aria-label={on ? `pause ${label}` : `play ${label}`} aria-pressed={on} onClick={toggle} className={AUDIO_BUTTON}>
          {on ? <RiPauseFill aria-hidden size={16} /> : <RiPlayFill aria-hidden size={16} />}
        </button>
      </Tooltip>
      <input
        type="range"
        min={0}
        max={end}
        step={100}
        value={Math.min(at, end)}
        aria-label={`seek ${label}`}
        aria-valuetext={`${clockOf(at)} of ${clockOf(total)}`}
        onChange={(e) => seek(e.target.valueAsNumber)}
        className="h-1 min-w-0 flex-1 accent-primaryBlue max-md:h-11"
      />
      <span className="shrink-0 text-xs tabular-nums text-textTertiary">
        {clockOf(at)} / {clockOf(total)}
      </span>
      <audio
        ref={el}
        src={src}
        preload="metadata"
        onPlay={() => setOn(true)}
        onPause={() => setOn(false)}
        onEnded={() => {
          setOn(false);
          setAt(0);
          if (el.current) el.current.currentTime = 0;
        }}
        onTimeUpdate={() => setAt(Math.round((el.current?.currentTime ?? 0) * 1000))}
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
      src={src}
      durationMs={audio.duration_ms}
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
