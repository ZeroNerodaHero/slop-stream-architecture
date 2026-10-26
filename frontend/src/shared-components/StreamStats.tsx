import { useEffect, useRef, useState } from 'react';

import type { AudioLine, QualityWord, StreamStats, VideoLine } from '@/infra/stream-stats';
import { CHIP_BUTTON, ControlTip, revealClassName } from '@/shared-components/VideoControls';
import { cn } from '@/utils/cn';

interface Playback {
  muted: boolean;
  /** 0..1, the level the dial returns to. */
  level: number;
}

interface StreamStatsButtonProps {
  id: string;
  role: 'watch' | 'publish';
  stats: StreamStats | null;
  /** Where in the picture's top left corner it sits: the offset the player's other chips use. */
  className?: string;
  /** Watcher only: how loud this browser is playing it. */
  playback?: Playback;
}

function unhealthy(word: QualityWord): boolean {
  return word === 'breaking' || word === 'upload limited' || word === 'cpu limited';
}

/** The trouble is the pipe: the picture arriving in holes, or the upload not getting through. */
function broken(word: QualityWord): boolean {
  return word === 'breaking' || word === 'upload limited';
}

/** How many of the four bars are lit: all on a clear picture, two on a rough one, none while it breaks or before the first sample. */
function barsOf(stats: StreamStats | null): number {
  if (!stats) return 0;
  if (stats.word === 'rough') return 2;
  return unhealthy(stats.word) ? 0 : 4;
}

/** The bars' heights, left to right, in a 24px box standing on y=21. */
const BARS = [6, 10, 14, 18];

/**
 * Reception bars, the way a phone shows its signal: four bars rising to the right, the lit
 * ones solid and the rest faint. `broken` strikes them through. Flat rectangles: the theme
 * has no arcs.
 */
function SignalIcon({ bars, broken }: { bars: number; broken: boolean }) {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor">
      {BARS.map((h, i) => (
        <rect key={h} x={3 + i * 5} y={21 - h} width={3} height={h} opacity={i < bars ? 1 : 0.3} />
      ))}
      {broken && <path d="M2 22L22 2" fill="none" stroke="currentColor" strokeWidth={2} />}
    </svg>
  );
}

/** A chip with its legs: the streamer's own machine is what holds the picture back, not any pipe. */
function CpuIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="miter">
      <path d="M6 6h12v12H6z" />
      <path d="M10 10h4v4h-4z" fill="currentColor" stroke="none" />
      <path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" />
    </svg>
  );
}

function wordColor(word: QualityWord): string {
  if (word === 'clear' || word === 'sending') return 'text-increase';
  if (unhealthy(word)) return 'text-decrease';
  return 'text-white';
}

function bits(bps: number): string {
  if (bps >= 1_000_000) {
    const mbps = bps / 1_000_000;
    return `${mbps >= 10 ? Math.round(mbps) : mbps.toFixed(1)} Mbps`;
  }
  return `${Math.max(0, Math.round(bps / 1000))} kbps`;
}

function pct(n: number): string {
  if (n < 0.05) return '0%';
  if (n < 10) return `${n.toFixed(1)}%`;
  return `${Math.round(n)}%`;
}

function perSec(n: number): string {
  if (n < 0.05) return '0/s';
  if (n < 10) return `${n.toFixed(1)}/s`;
  return `${Math.round(n)}/s`;
}

function limitWord(reason: VideoLine['reason']): string | null {
  if (reason === 'bandwidth') return 'upload';
  if (reason === 'cpu') return 'cpu';
  return null;
}

function hoverLine(role: 'watch' | 'publish', stats: StreamStats | null): string {
  if (!stats) return 'measuring';
  const v = stats.video;
  const rate = role === 'publish' && stats.capBps ? `${bits(v.bitrate)} / ${bits(stats.capBps)}` : bits(v.bitrate);
  const mic = stats.audio?.muted ? ' · mic muted' : stats.audio?.silent ? ' · mic silent' : '';
  return `${stats.word} · ${v.width}×${v.height} · ${Math.round(v.fps)} fps · ${rate}${mic}`;
}

function Row({ label, value }: { label: string; value: string | null }) {
  if (value === null) return null;
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-white/60">{label}</dt>
      <dd className="font-semibold">{value}</dd>
    </div>
  );
}

function Meter({ level }: { level: number }) {
  const filled = Math.min(100, Math.max(0, level * 100));
  return (
    <span className="inline-block h-1 w-16 bg-white/30 align-middle">
      <span className="block h-full bg-white" style={{ width: `${filled}%` }} />
    </span>
  );
}

function Picture({ role, video, capBps }: { role: 'watch' | 'publish'; video: VideoLine; capBps: number | null }) {
  const limited = limitWord(video.reason);
  const rate = role === 'publish' && capBps ? `${bits(video.bitrate)} / ${bits(capBps)}` : bits(video.bitrate);
  return (
    <div className="grid gap-1">
      {video.label && <p className="text-white/60">{video.label}</p>}
      <p className="font-semibold">
        {video.width}×{video.height} · {Math.round(video.fps)} fps
      </p>
      <dl className="grid gap-1">
        <Row label={role === 'watch' ? 'bitrate in' : 'bitrate out'} value={rate} />
        <Row label={role === 'watch' ? 'loss' : 'loss at the box'} value={video.lossPct === null ? null : pct(video.lossPct)} />
        <Row label="jitter" value={video.jitterMs === null ? null : `${Math.round(video.jitterMs)} ms`} />
        <Row label="dropped" value={video.droppedPerSec === null ? null : perSec(video.droppedPerSec)} />
        <Row label="retransmit asks" value={video.nackPerSec === null ? null : perSec(video.nackPerSec)} />
        <Row label="keyframe asks" value={video.pliPerSec === null ? null : perSec(video.pliPerSec)} />
        <Row label="keyframes" value={role === 'publish' && video.keyframesPerSec !== null ? perSec(video.keyframesPerSec) : null} />
        <Row label="limited by" value={limited} />
      </dl>
    </div>
  );
}

function Sound({ role, audio }: { role: 'watch' | 'publish'; audio: AudioLine | null }) {
  if (!audio && role === 'watch') return null;
  return (
    <div className="mt-2 grid gap-1 border-t border-white/10 pt-2">
      <p className="text-white/60">{role === 'publish' ? 'mic' : 'sound'}</p>
      {audio ? (
        <>
          {(audio.level !== null || audio.muted || audio.silent) && (
            <p className="flex items-center gap-2 font-semibold">
              {audio.level !== null && <Meter level={audio.level} />}
              {audio.muted ? 'muted' : audio.silent ? 'silent' : null}
            </p>
          )}
          <dl className="grid gap-1">
            <Row label={role === 'watch' ? 'bitrate in' : 'bitrate out'} value={bits(audio.bitrate)} />
            <Row label="loss" value={audio.lossPct === null ? null : pct(audio.lossPct)} />
            <Row label="concealment" value={audio.concealmentPct === null ? null : pct(audio.concealmentPct)} />
          </dl>
        </>
      ) : (
        <p className="font-semibold">no mic</p>
      )}
    </div>
  );
}

/**
 * The stream's health, in the picture's top left corner: a dark chip with signal bars in it.
 * While the picture is actually in trouble it is up on its own, red, the bars struck through
 * (a chip glyph instead when the streamer's cpu is what limits it); otherwise it comes and goes
 * with the other controls, on hover and keyboard focus, so the numbers stay a click away.
 * Hover and keyboard focus show the quality line under it; a click opens the numbers and a
 * click again, Escape, or a press outside closes them. It is not a setting: a watcher gets the
 * one picture the box has (docs/bitrates.md), so there is nothing here to choose.
 */
export function StreamStatsButton({ id, role, stats, className = 'left-3 top-3', playback }: StreamStatsButtonProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const bad = stats ? unhealthy(stats.word) : false;

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    // the window this button is in: the page's, or the popped out player's (CornerPlayer), whose presses never reach the page
    const win = root.current?.ownerDocument.defaultView ?? window;
    win.addEventListener('pointerdown', onPointer);
    win.addEventListener('keydown', onKey);
    return () => {
      win.removeEventListener('pointerdown', onPointer);
      win.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    // `data-video-stats`: the corner player does not take a press here as a drag
    <div ref={root} data-video-stats="" className={cn('absolute z-20', revealClassName(bad), className)}>
      <button
        id={id}
        type="button"
        aria-label="stream stats"
        aria-expanded={open}
        aria-controls={`${id}-panel`}
        onClick={() => setOpen((v) => !v)}
        className={cn(CHIP_BUTTON, 'group/control relative w-8 justify-center', open && 'border-primaryBlue text-primaryBlue', bad && !open && 'text-decrease')}
      >
        {stats?.word === 'cpu limited' ? <CpuIcon /> : <SignalIcon bars={barsOf(stats)} broken={stats ? broken(stats.word) : false} />}
        {!open && (
          <ControlTip at="below-left">
            {stats ? (
              <>
                <span className={wordColor(stats.word)}>{stats.word}</span>
                {hoverLine(role, stats).slice(stats.word.length)}
              </>
            ) : (
              'measuring'
            )}
          </ControlTip>
        )}
      </button>
      {open && (
        <div
          id={`${id}-panel`}
          role="region"
          aria-label="stream stats"
          className="absolute left-0 top-full z-20 mt-2 w-60 border border-white/10 bg-black/90 p-3 text-xs text-white backdrop-blur-sm"
        >
          {stats ? (
            <>
              <p className={cn('font-semibold', wordColor(stats.word))}>{stats.word}</p>
              <div className="mt-1">
                <Picture role={role} video={{ ...stats.video, reason: stats.reason ?? stats.video.reason }} capBps={stats.capBps} />
              </div>
              <dl className="mt-1 grid gap-1">
                <Row label="rtt" value={stats.rttMs === null ? null : `${Math.round(stats.rttMs)} ms`} />
                <Row label="upload room" value={role === 'publish' && stats.availableBps !== null ? bits(stats.availableBps) : null} />
                <Row label="path" value={stats.path} />
              </dl>
              {stats.others.map((video, i) => (
                <div key={`${video.label ?? 'video'}-${i}`} className="mt-2 border-t border-white/10 pt-2">
                  <Picture role={role} video={video} capBps={null} />
                </div>
              ))}
              <Sound role={role} audio={stats.audio} />
              {playback && (
                <dl className="mt-1 grid gap-1">
                  <Row label="your volume" value={playback.muted ? 'muted' : `${Math.round(playback.level * 100)}%`} />
                </dl>
              )}
            </>
          ) : (
            <p className="font-semibold">measuring</p>
          )}
        </div>
      )}
    </div>
  );
}
