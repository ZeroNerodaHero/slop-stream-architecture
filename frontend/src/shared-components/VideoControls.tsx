import { useAtomValue } from 'jotai';
import { type ButtonHTMLAttributes, type ReactNode, type RefObject, useRef } from 'react';

import { dialAtom, muteVideo, mutedAtom, setVolume, settleDial, unmuteVideo } from '@/infra/atoms/watch-atoms';
import { cn } from '@/utils/cn';

export const CHIP = 'flex h-8 items-center border border-white/10 bg-black/70 text-sm font-semibold text-white backdrop-blur-sm transition-colors duration-150';
export const CHIP_BUTTON = cn(CHIP, 'hover:border-primaryBlue hover:bg-black/90 hover:text-primaryBlue');
const TIP =
  'pointer-events-none absolute whitespace-nowrap border border-white/10 bg-black/90 px-2 py-1 text-xs font-semibold text-white opacity-0 transition-opacity duration-150 group-hover/control:opacity-100 group-focus-visible/control:opacity-100';
const TIP_AT = {
  'above-left': 'bottom-full left-0 mb-2',
  'above-right': 'bottom-full right-0 mb-2',
  'below-left': 'left-0 top-full mt-2',
  'below-right': 'right-0 top-full mt-2'
} as const;

export type TipAt = keyof typeof TIP_AT;

export function ControlTip({ at, children }: { at: TipAt; children: ReactNode }) {
  return (
    <span role="tooltip" className={cn(TIP, TIP_AT[at])}>
      {children}
    </span>
  );
}

export function revealClassName(shown: boolean): string {
  return cn(
    'transition-[opacity,transform] duration-200',
    !shown &&
      'translate-y-1 opacity-0 delay-300 group-hover:translate-y-0 group-hover:opacity-100 group-hover:delay-0 [&:has(:focus-visible)]:translate-y-0 [&:has(:focus-visible)]:opacity-100 [&:has(:focus-visible)]:delay-0 [&:has([aria-expanded=true])]:translate-y-0 [&:has([aria-expanded=true])]:opacity-100 [&:has([aria-expanded=true])]:delay-0 [@media(hover:none)]:translate-y-0 [@media(hover:none)]:opacity-100'
  );
}

interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'> {
  label: string;
  tipAt?: keyof typeof TIP_AT;
  active?: boolean;
  tone?: 'glass' | 'page';
}

export function IconButton({ label, tipAt = 'above-right', active = false, tone = 'glass', className, children, ...props }: IconButtonProps) {
  if (tone === 'page') {
    return (
      <button
        type="button"
        aria-label={label}
        aria-pressed={active || undefined}
        className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center border border-primaryStroke bg-backgroundSecondary text-textPrimary transition-colors duration-150 hover:border-primaryBlue hover:text-primaryBlue focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primaryBlue disabled:cursor-default disabled:opacity-50 max-md:min-h-11 max-md:min-w-11 [&_svg]:h-[18px] [&_svg]:w-[18px]',
          active && 'border-primaryBlue text-primaryBlue',
          className
        )}
        {...props}
      >
        {children}
      </button>
    );
  }
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

export function PipIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2}>
      <path d="M3 5h18v14H3z" />
      <path d="M11 11h8v6h-8z" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function PopOutIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="miter">
      <path d="M14 13v6H3V8h6" />
      <path d="M11 13L21 3" />
      <path d="M13 3h8v8" />
    </svg>
  );
}

export function ChatIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="miter">
      <path d="M3 4h18v12H9l-5 4v-4H3z" />
    </svg>
  );
}

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

const DIAL = cn(
  'h-1 cursor-pointer appearance-none bg-white/30',
  '[&::-webkit-slider-thumb]:-mt-1 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:bg-white',
  '[&::-moz-range-thumb]:h-3 [&::-moz-range-thumb]:w-3 [&::-moz-range-thumb]:rounded-none [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-white',
  '[&:focus-visible::-webkit-slider-thumb]:bg-primaryBlue [&:focus-visible::-moz-range-thumb]:bg-primaryBlue'
);

interface SoundControlProps {
  videoRef: RefObject<HTMLVideoElement | null>;
  buttonId: string;
  dialId: string;
  dialClassName?: string;
}

export function SoundControl({ videoRef, buttonId, dialId, dialClassName = 'w-24' }: SoundControlProps) {
  const muted = useAtomValue(mutedAtom);
  const dial = useAtomValue(dialAtom);
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
