import { useAtomValue } from 'jotai';
import { type ButtonHTMLAttributes, type RefObject, useRef } from 'react';

import { dialAtom, muteVideo, mutedAtom, setVolume, settleDial, unmuteVideo } from '@/infra/atoms/watch-atoms';
import { cn } from '@/utils/cn';

/**
 * The controls that sit on a playing video: the watch page's and the corner player's. Dark
 * glass chips, 32px tall, the same as the cards' live chip. An icon-only control carries its
 * name for screen readers and shows it next to itself on hover and keyboard focus. Everything
 * here is white on black whatever the theme: it sits on the picture, not on the page.
 */

/** A control over the video. */
export const CHIP = 'flex h-8 items-center border border-white/10 bg-black/70 text-sm font-semibold text-white backdrop-blur-sm transition-colors duration-150';
/** A chip that is itself the button: blue stroke and blue glyph on hover, like every button on the site, over solid black. */
export const CHIP_BUTTON = cn(CHIP, 'hover:border-primaryBlue hover:bg-black/90 hover:text-primaryBlue');
/** The name of an icon-only control, shown while the pointer or keyboard focus is on it (`group/control relative` is the control). */
const TIP =
  'pointer-events-none absolute whitespace-nowrap border border-white/10 bg-black/90 px-2 py-1 text-xs font-semibold text-white opacity-0 transition-opacity duration-150 group-hover/control:opacity-100 group-focus-visible/control:opacity-100';
const TIP_AT = {
  'above-left': 'bottom-full left-0 mb-2',
  'above-right': 'bottom-full right-0 mb-2',
  'below-right': 'right-0 top-full mt-2'
} as const;

/**
 * The reveal of a controls bar. Hidden: faded and 4px low, and it waits 300ms before going (a
 * pointer that strays off the video for a moment does not make the controls blink); it comes
 * up at once on hover of the `group` around the video, while a control in it has keyboard
 * focus (not the focus a mouse click leaves behind, or it would stick), and on a screen with
 * no hover at all. `shown`: always up, no transition games.
 */
export function revealClassName(shown: boolean): string {
  return cn(
    'transition-[opacity,transform] duration-200',
    !shown &&
      'translate-y-1 opacity-0 delay-300 group-hover:translate-y-0 group-hover:opacity-100 group-hover:delay-0 [&:has(:focus-visible)]:translate-y-0 [&:has(:focus-visible)]:opacity-100 [&:has(:focus-visible)]:delay-0 [@media(hover:none)]:translate-y-0 [@media(hover:none)]:opacity-100'
  );
}

interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'> {
  /** What it does: the accessible name, and the label shown on hover. */
  label: string;
  /** Where the label hangs, so it stays over the video. */
  tipAt?: keyof typeof TIP_AT;
  /** A toggle that is on: it keeps the blue the hover gives. */
  active?: boolean;
}

/** A 32px square chip with a glyph in it. */
export function IconButton({ label, tipAt = 'above-right', active = false, className, children, ...props }: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active || undefined}
      className={cn(
        CHIP_BUTTON,
        'group/control relative w-8 justify-center disabled:cursor-default disabled:opacity-50 disabled:hover:border-white/10 disabled:hover:bg-black/70 disabled:hover:text-white',
        active && 'border-primaryBlue text-primaryBlue',
        className
      )}
      {...props}
    >
      {children}
      <span role="tooltip" className={cn(TIP, TIP_AT[tipAt])}>
        {label}
      </span>
    </button>
  );
}

/** The usual picture in picture glyph: a screen with a small picture in its bottom right corner. Square, like the rest. */
export function PipIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2}>
      <path d="M3 5h18v14H3z" />
      <path d="M11 11h8v6h-8z" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** A speech box with its tail at the bottom left. */
export function ChatIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="miter">
      <path d="M3 4h18v12H9l-5 4v-4H3z" />
    </svg>
  );
}

/**
 * A speaker. Crossed out while muted; otherwise its sound waves say how loud, the way youtube's
 * do: two above two thirds, one above a third, none for a whisper. Angular waves, no arcs in this theme.
 */
function SpeakerIcon({ muted, level }: { muted: boolean; level: number }) {
  const waves = muted ? 0 : level > 2 / 3 ? 2 : level > 1 / 3 ? 1 : 0;
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="miter">
      <path d="M3 9h4l5-4v14l-5-4H3z" fill="currentColor" />
      {muted && <path d="M16 9l6 6M22 9l-6 6" />}
      {waves >= 1 && <path d="M16 9l2 3-2 3" />}
      {waves >= 2 && <path d="M19 6l3 6-3 6" />}
    </svg>
  );
}

/**
 * The dial. A flat 4px track with a square thumb (the theme has no round shapes); the part up
 * to the thumb is filled through an inline gradient, since no browser draws that on its own.
 */
const DIAL = cn(
  'h-1 cursor-pointer appearance-none bg-white/30',
  '[&::-webkit-slider-thumb]:-mt-1 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:bg-white',
  '[&::-moz-range-thumb]:h-3 [&::-moz-range-thumb]:w-3 [&::-moz-range-thumb]:rounded-none [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-white',
  '[&:focus-visible::-webkit-slider-thumb]:bg-primaryBlue [&:focus-visible::-moz-range-thumb]:bg-primaryBlue'
);

interface SoundControlProps {
  /** The <video> the sound comes out of. */
  videoRef: RefObject<HTMLVideoElement | null>;
  /** The ids the tests key on: the speaker button and the dial. */
  buttonId: string;
  dialId: string;
  /** The dial's width (`w-24` on the page, less in the corner). */
  dialClassName?: string;
}

/**
 * The speaker (mute, unmute) and the volume dial, one control. No box of its own, the way a
 * player's sound control usually sits straight on the picture: a shadow under the glyph and the
 * dial keeps them readable over a bright frame. Mute drops the dial to 0 and crosses the speaker,
 * unmute brings the level back; the dial dragged to 0 is a mute, dragged up from 0 an unmute. A
 * drag that ends on 0 went through every level on the way down, so the level when the dial was
 * taken hold of is kept for the way back (`settleDial`).
 */
export function SoundControl({ videoRef, buttonId, dialId, dialClassName = 'w-24' }: SoundControlProps) {
  const muted = useAtomValue(mutedAtom);
  const dial = useAtomValue(dialAtom);
  /** Where the dial was when it was taken hold of (pointer or key), for `settleDial` when it is let go. */
  const grabbed = useRef(dial);

  return (
    <div className="flex h-8 items-center gap-2 text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]">
      <button
        id={buttonId}
        type="button"
        aria-label={muted ? 'unmute' : 'mute'}
        className="group/control relative flex h-full w-8 items-center justify-center transition-colors duration-150 hover:text-primaryBlue"
        onClick={() => (muted ? unmuteVideo : muteVideo)(videoRef.current)}
      >
        <SpeakerIcon muted={muted} level={dial} />
        <span role="tooltip" className={cn(TIP, TIP_AT['above-left'])}>
          {muted ? 'unmute' : 'mute'}
        </span>
      </button>
      <input
        id={dialId}
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={dial}
        aria-label="volume"
        title={`volume ${Math.round(dial * 100)}%`}
        onChange={(e) => setVolume(videoRef.current, e.target.valueAsNumber)}
        onPointerDown={() => (grabbed.current = dial)}
        onPointerUp={() => settleDial(grabbed.current)}
        onKeyDown={(e) => {
          if (!e.repeat) grabbed.current = dial;
        }}
        onKeyUp={() => settleDial(grabbed.current)}
        className={cn(DIAL, dialClassName)}
        style={{ background: `linear-gradient(to right, rgb(255 255 255) ${dial * 100}%, rgb(255 255 255 / 0.3) ${dial * 100}%)` }}
      />
    </div>
  );
}
