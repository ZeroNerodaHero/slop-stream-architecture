import { type KeyboardEvent, type PointerEvent, useState } from 'react';

import { type Hsv, cleanHex, hexToHsv, hsvToHex } from '@/infra/about-blocks';
import { INPUT } from '@/shared-components/input';
import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

export const RAINBOW = 'conic-gradient(#ff3b3b, #ffd23b, #3bff6b, #3bd8ff, #4f3bff, #ff3bd2, #ff3b3b)';
const HUES = 'linear-gradient(90deg, #ff0000, #ffff00, #00ff00, #00ffff, #0000ff, #ff00ff, #ff0000)';
const KNOB = 'pointer-events-none absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-control border-2 border-white outline outline-1 outline-black/60';

function spot(e: PointerEvent<HTMLDivElement>): [number, number] {
  const r = e.currentTarget.getBoundingClientRect();
  return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
}

function grab(e: PointerEvent<HTMLDivElement>, move: (x: number, y: number) => void) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.currentTarget.setPointerCapture(e.pointerId);
  e.currentTarget.focus();
  move(...spot(e));
}

function drag(e: PointerEvent<HTMLDivElement>, move: (x: number, y: number) => void) {
  if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
  move(...spot(e));
}

function arrows(e: KeyboardEvent, step: number): [number, number] | null {
  const by = e.shiftKey ? step * 10 : step;
  const d: Record<string, [number, number]> = { ArrowLeft: [-by, 0], ArrowRight: [by, 0], ArrowUp: [0, -by], ArrowDown: [0, by] };
  const hit = d[e.key];
  if (!hit) return null;
  e.preventDefault();
  return hit;
}

interface ColorReset {
  word: string;
  tip: string;
}

const THEME_RESET: ColorReset = { word: 'theme', tip: 'use the theme color' };

export function ColorPick({
  id,
  label,
  value,
  fallback,
  reset = THEME_RESET,
  onChange
}: {
  id: string;
  label: string;
  value: string;
  fallback: string;
  reset?: ColorReset;
  onChange: (hex: string) => void;
}) {
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(value || fallback));
  const [text, setText] = useState(value);
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    setText(value);
    if (value && hsvToHex(hsv) !== value) setHsv(hexToHsv(value));
  }
  const put = (next: Hsv) => {
    setHsv(next);
    const hex = hsvToHex(next);
    setText(hex);
    onChange(hex);
  };
  const hue = hsvToHex({ h: hsv.h, s: 1, v: 1 });
  const bad = text !== '' && cleanHex(text) === null;
  return (
    <div id={id} role="group" aria-label={`${label} color`} className="flex flex-col gap-1.5 rounded-card border border-primaryStroke bg-background p-2">
      <div
        id={`${id}-area`}
        role="slider"
        tabIndex={0}
        aria-label={`${label} saturation and brightness`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(hsv.s * 100)}
        aria-valuetext={`saturation ${Math.round(hsv.s * 100)}, brightness ${Math.round(hsv.v * 100)}`}
        onPointerDown={(e) => grab(e, (x, y) => put({ ...hsv, s: x, v: 1 - y }))}
        onPointerMove={(e) => drag(e, (x, y) => put({ ...hsv, s: x, v: 1 - y }))}
        onKeyDown={(e) => {
          const d = arrows(e, 0.01);
          if (d) put({ ...hsv, s: Math.min(1, Math.max(0, hsv.s + d[0])), v: Math.min(1, Math.max(0, hsv.v - d[1])) });
        }}
        style={{ backgroundColor: hue, backgroundImage: 'linear-gradient(transparent, #000), linear-gradient(90deg, #fff, transparent)' }}
        className="relative h-24 w-full cursor-crosshair touch-none rounded-control focus:outline-none focus-visible:outline focus-visible:outline-1 focus-visible:outline-primaryBlue"
      >
        <span className={KNOB} style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, backgroundColor: hsvToHex(hsv) }} />
      </div>
      <div
        id={`${id}-hue`}
        role="slider"
        tabIndex={0}
        aria-label={`${label} hue`}
        aria-valuemin={0}
        aria-valuemax={360}
        aria-valuenow={Math.round(hsv.h)}
        onPointerDown={(e) => grab(e, (x) => put({ ...hsv, h: x * 360 }))}
        onPointerMove={(e) => drag(e, (x) => put({ ...hsv, h: x * 360 }))}
        onKeyDown={(e) => {
          const d = arrows(e, 1);
          if (d) put({ ...hsv, h: Math.min(360, Math.max(0, hsv.h + d[0] - d[1])) });
        }}
        style={{ backgroundImage: HUES }}
        className="relative h-3 w-full cursor-pointer touch-none rounded-control focus:outline-none focus-visible:outline focus-visible:outline-1 focus-visible:outline-primaryBlue"
      >
        <span className={KNOB} style={{ left: `${(hsv.h / 360) * 100}%`, top: '50%', backgroundColor: hue }} />
      </div>
      <div className="flex items-center gap-1.5">
        <span aria-hidden className="size-6 shrink-0 rounded-control border border-primaryStroke" style={{ backgroundColor: value || fallback }} />
        <input
          id={`${id}-hex`}
          aria-label={`${label} hex`}
          aria-invalid={bad || undefined}
          value={text}
          maxLength={7}
          spellCheck={false}
          placeholder="hex"
          onChange={(e) => {
            setText(e.target.value);
            const hex = cleanHex(e.target.value);
            if (hex) {
              setHsv(hexToHsv(hex));
              onChange(hex);
            }
          }}
          onBlur={() => setText(value)}
          className={cn(INPUT, 'py-1 font-mono text-xs', bad && 'border-decrease focus:border-decrease')}
        />
        <Tooltip content={reset.tip}>
          <button
            id={`${id}-reset`}
            type="button"
            disabled={!value}
            onClick={() => {
              setText('');
              onChange('');
            }}
            className="shrink-0 rounded-control border border-primaryStroke bg-backgroundSecondary px-2 py-1 text-xs text-textSecondary transition-colors hover:border-primaryBlue hover:text-textPrimary disabled:opacity-40"
          >
            {reset.word}
          </button>
        </Tooltip>
      </div>
    </div>
  );
}

export function ColorChip({ id, word, value, open, onClick }: { id: string; word: string; value: string; open: boolean; onClick: () => void }) {
  return (
    <button
      id={id}
      type="button"
      aria-expanded={open}
      aria-label={`${word} color${value ? ` ${value}` : ', theme'}`}
      onClick={onClick}
      className={cn(
        'flex items-center gap-1 rounded-control border px-1.5 py-0.5 text-xs text-textSecondary transition-colors hover:text-textPrimary',
        open ? 'border-primaryBlue text-textPrimary' : 'border-primaryStroke hover:border-secondaryStroke'
      )}
    >
      <span
        aria-hidden
        className={cn('size-3 shrink-0 rounded-control border', value ? 'border-transparent' : 'border-dashed border-secondaryStroke')}
        style={{ backgroundColor: value || undefined }}
      />
      {word}
    </button>
  );
}
