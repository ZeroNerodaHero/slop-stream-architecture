import { RiRefreshLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { type CSSProperties, type ReactNode, useState } from 'react';

import {
  customFrom,
  type CustomTheme,
  paletteAtom,
  setCustomColor,
  setShape,
  setTextSize,
  setTheme,
  SHAPES,
  shapeAtom,
  TEXT_SIZES,
  type TextSize,
  textSizeAtom,
  themeAtom
} from '@/infra/atoms/settings-atoms';
import { type Shape } from '@/infra/shape';
import {
  contrast,
  contrastWords,
  fromHex,
  hex,
  type Palette,
  parseHex,
  PRESET_LABELS,
  PRESET_NAMES,
  PRESETS,
  schemeOf,
  toCssVars,
  type TokenName,
  TOKENS
} from '@/infra/theme';
import { Button } from '@/shared-components/Button';
import { Switch } from '@/shared-components/Switch';
import { Tooltip } from '@/shared-components/Tooltip';
import { FIELDSET, Block, OptionCard, SECTION_TITLE } from '@/shared-components/user-modal/parts';
import { cn } from '@/utils/cn';

const TOKEN_LABEL: Record<TokenName, string> = {
  background: 'background',
  backgroundSecondary: 'boxes',
  backgroundTertiary: 'lifted',
  textPrimary: 'text',
  textSecondary: 'text 2',
  textTertiary: 'text 3',
  primaryColor: 'accent',
  primaryColorHover: 'accent hover',
  primaryStroke: 'stroke',
  secondaryStroke: 'stroke 2',
  increase: 'live',
  decrease: 'danger'
};

const SHAPE_LOOK: Record<Shape, { panel: string; line: string; chip: string; avatar: string }> = {
  block: {
    panel: 'rounded-none border border-primaryStroke bg-backgroundSecondary',
    line: 'rounded-none border border-primaryStroke bg-background',
    chip: 'rounded-none',
    avatar: 'rounded-none'
  },
  soft: {
    panel: 'rounded-[4px] border border-primaryStroke bg-backgroundSecondary',
    line: 'rounded-[3px] border border-primaryStroke bg-background',
    chip: 'rounded-[3px]',
    avatar: 'rounded-[3px]'
  },
  bubble: {
    panel: 'rounded-[8px] bg-backgroundSecondary',
    line: 'rounded-[999px] bg-backgroundTertiary',
    chip: 'rounded-[999px]',
    avatar: 'rounded-[999px]'
  }
};

function ShapeSwatch({ shape }: { shape: Shape }) {
  const look = SHAPE_LOOK[shape];
  return (
    <span aria-hidden className={cn('flex h-16 w-full min-w-0 items-center gap-1.5 overflow-hidden px-2 max-md:h-12 max-md:gap-1 max-md:px-1.5', look.panel)}>
      <span className={cn('h-2.5 w-2.5 shrink-0 bg-primaryBlue', look.avatar)} />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className={cn('h-2.5 w-[85%]', look.line)} />
        <span className={cn('h-2.5 w-[55%]', look.line)} />
      </span>
      <span className={cn('h-3 w-5 shrink-0 bg-primaryBlue max-md:w-3', look.chip)} />
    </span>
  );
}

function ShapePicker() {
  const shape = useAtomValue(shapeAtom);
  return (
    <div role="presentation" className="mt-2 grid grid-cols-3 gap-2 md:gap-3">
      {SHAPES.map((s) => (
        <div key={s} className="grid min-w-0">
          <OptionCard id={`shape-${s}`} name="shape" checked={shape === s} onChange={() => setShape(s)} picture={<ShapeSwatch shape={s} />} label={s} compact />
        </div>
      ))}
    </div>
  );
}

const css = (c: readonly number[]) => `rgb(${c.join(' ')})`;

function Swatch({ palette }: { palette: Palette }) {
  return (
    <span
      aria-hidden
      className="flex h-16 w-full min-w-0 items-center overflow-hidden p-1 soft:rounded-[4px] bubble:rounded-[8px] max-md:h-12"
      style={{ backgroundColor: css(palette.background), border: `1px solid ${css(palette.primaryStroke)}` }}
    >
      <span
        className="flex h-full min-w-0 flex-1 items-center gap-1 px-1 soft:rounded-[2px] bubble:rounded-[5px]"
        style={{
          backgroundColor: css(palette.backgroundSecondary),
          border: `1px solid ${css(palette.primaryStroke)}`
        }}
      >
        <span className="h-3 w-0.5 shrink-0" style={{ backgroundColor: css(palette.primaryColor) }} />
        <span className="text-sm font-semibold leading-none" style={{ color: css(palette.textPrimary) }}>
          Aa
        </span>
      </span>
    </span>
  );
}

const HEX_BOX =
  'flex h-7 w-[6.5rem] shrink-0 items-center gap-1 rounded-control border border-primaryStroke bg-background px-2 font-sans text-sm tabular-nums focus-within:border-primaryBlue';

function HexField({
  id,
  label,
  value,
  muted,
  readOnly,
  onCommit
}: {
  id: string;
  label: string;
  value: string;
  muted?: boolean;
  readOnly?: boolean;
  onCommit: (hex: string) => void;
}) {
  const shown = value.replace('#', '').toLowerCase();
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? shown;
  const bad = draft !== null && draft !== '' && parseHex(draft) === null;

  const commit = (raw: string) => {
    const parsed = parseHex(raw);
    if (parsed) onCommit(parsed);
    return parsed;
  };

  return (
    <span className={cn(HEX_BOX, bad && 'border-decrease focus-within:border-decrease')}>
      <span aria-hidden className="text-textTertiary">
        #
      </span>
      <input
        id={id}
        type="text"
        inputMode="text"
        autoComplete="off"
        spellCheck={false}
        maxLength={7}
        placeholder="hex"
        aria-label={`${label} hex`}
        aria-invalid={bad || undefined}
        readOnly={readOnly}
        value={text}
        onFocus={() => !readOnly && setDraft(shown)}
        onChange={(e) => {
          const next = e.target.value
            .replace(/[^0-9a-f]/gi, '')
            .slice(0, 6)
            .toLowerCase();
          setDraft(next);
          if (next.length === 6) commit(next);
        }}
        onBlur={() => {
          if (draft !== null) commit(draft);
          setDraft(null);
        }}
        onKeyDown={(e) => {
          if (readOnly) return;
          if (e.key === 'Enter') {
            const parsed = commit(text);
            if (parsed) setDraft(parsed.slice(1));
          } else if (e.key === 'Escape' && draft !== null) {
            e.stopPropagation();
            setDraft(shown);
          }
        }}
        className={cn(
          'w-full min-w-0 border-0 bg-transparent p-0 font-sans tabular-nums outline-none placeholder:text-textTertiary',
          muted ? 'text-textTertiary' : 'text-textPrimary'
        )}
      />
    </span>
  );
}

function ColourChip({ id, label, value, disabled, onPick }: { id: string; label: string; value: string; disabled?: boolean; onPick: (hex: string) => void }) {
  return (
    <span
      className={cn(
        'relative h-6 w-9 shrink-0 overflow-hidden rounded-control border border-primaryStroke focus-within:border-primaryBlue',
        !disabled && 'hover:border-secondaryStroke'
      )}
      style={{ backgroundColor: value }}
    >
      <input
        id={id}
        type="color"
        aria-label={`pick ${label}`}
        value={value}
        disabled={disabled}
        onChange={(e) => onPick(e.target.value)}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-default"
      />
    </span>
  );
}

const ROW = 'flex min-h-[38px] items-center gap-3';
const ROW_LABEL = 'w-20 shrink-0 text-sm text-textSecondary max-md:w-[4.5rem]';

function ColourRow({
  slot,
  value,
  children,
  muted,
  locked
}: {
  slot: 'background' | 'accent' | 'text';
  value: string;
  children?: ReactNode;
  muted?: boolean;
  locked?: boolean;
}) {
  return (
    <div className={ROW}>
      <label htmlFor={`color-${slot}-hex`} className={ROW_LABEL}>
        {slot}
      </label>
      <ColourChip id={`color-${slot}`} label={slot} value={value} disabled={locked} onPick={(v) => setCustomColor(slot, v)} />
      <HexField id={`color-${slot}-hex`} label={slot} value={value} muted={muted} readOnly={locked} onCommit={(v) => setCustomColor(slot, v)} />
      {children}
    </div>
  );
}

function PaletteStrip({ palette }: { palette: Palette }) {
  return (
    <div className={ROW}>
      <span className={ROW_LABEL}>makes</span>
      <ul aria-label="the colours these make" className="flex h-3 min-w-0 flex-1 overflow-hidden rounded-control border border-primaryStroke">
        {TOKENS.map((token) => {
          const words = `${TOKEN_LABEL[token]} · ${hex(palette[token])}`;
          return (
            <li key={token} className="flex min-w-0 flex-1">
              <Tooltip content={words}>
                <span id={`palette-${token}`} role="img" aria-label={words} className="h-full w-full" style={{ backgroundColor: css(palette[token]) }} />
              </Tooltip>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const PREVIEW_PILL = 'rounded-control border px-2 py-0.5 text-[11px] font-semibold leading-tight';

function ThemePreview({ palette }: { palette: Palette }) {
  return (
    <div
      id="theme-preview"
      aria-label="preview"
      role="img"
      className="flex min-h-[200px] w-full min-w-0 overflow-hidden rounded-card border border-primaryStroke bg-background font-sans text-textPrimary"
      style={{ ...toCssVars(palette), colorScheme: schemeOf(palette) } as CSSProperties}
    >
      <span className="flex w-8 shrink-0 flex-col items-center gap-2 border-r border-primaryStroke bg-backgroundSecondary py-2">
        <span className="h-4 w-4 rounded-avatar bg-primaryBlue" />
        <span className="relative h-4 w-4 rounded-avatar bg-backgroundTertiary">
          <span className="absolute -bottom-px -right-px h-1.5 w-1.5 rounded-avatar bg-increase" />
        </span>
        <span className="h-4 w-4 rounded-avatar bg-backgroundTertiary" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-2 p-2">
        <span className="flex items-center gap-1.5">
          <span className="text-xs font-semibold">billy</span>
          <span className="rounded-control bg-increase px-1 text-[9px] font-bold uppercase leading-[14px] text-background">live</span>
          <span className={cn(PREVIEW_PILL, 'ml-auto border-primaryBlue bg-primaryBlue text-background')}>go live</span>
        </span>
        <span className="flex flex-col gap-0.5 rounded-card border border-primaryStroke bg-backgroundSecondary px-2 py-1.5 text-[11px] leading-snug">
          <span className="text-[10px] tabular-nums text-textTertiary">2:41 am</span>
          <span>this colour is so good</span>
          <span className="text-textSecondary">
            replying to <span className="font-semibold text-primaryBlue">@miata</span>
          </span>
        </span>
        <span className="flex gap-1.5">
          <span className={cn(PREVIEW_PILL, 'border-primaryStroke bg-backgroundSecondary')}>cancel</span>
          <span className={cn(PREVIEW_PILL, 'border-decrease text-decrease')}>delete</span>
        </span>
        <span className="mt-auto rounded-control border border-primaryStroke bg-backgroundTertiary px-2 py-1 text-[11px] text-textTertiary">message</span>
      </span>
    </div>
  );
}

function CustomColours({ theme, palette }: { theme: CustomTheme; palette: Palette }) {
  const auto = theme.text === null;
  const shownText = theme.text ?? hex(palette.textPrimary);
  const ratio = contrast(fromHex(shownText), palette.background);
  const words = contrastWords(ratio);
  const nudged = !auto && hex(palette.textPrimary) !== shownText.toLowerCase();
  const applied = contrast(palette.textPrimary, palette.background);

  return (
    <div className="flex flex-col-reverse gap-4 md:flex-row md:items-stretch">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <ColourRow slot="background" value={theme.background} />
        <ColourRow slot="accent" value={theme.accent} />
        <ColourRow slot="text" value={shownText} muted={auto} locked={auto}>
          <label className="flex items-center gap-2 text-sm text-textSecondary">
            <Switch id="color-text-auto" checked={auto} label="auto" onChange={(on) => setCustomColor('text', on ? null : hex(palette.textPrimary))} />
            auto
          </label>
        </ColourRow>
        <PaletteStrip palette={palette} />
        <div className="mt-2 flex items-center gap-3">
          <p id="theme-contrast" className={cn('min-w-0 flex-1 text-sm tabular-nums', words.readable ? 'text-textTertiary' : 'text-decrease')}>
            text on background {words.text}
            {nudged ? ` · nudged to ${applied.toFixed(1)}:1` : ''}
          </p>
          <Button id="theme-reset" size="sm" className="gap-1.5" onClick={() => setTheme({ kind: 'preset', name: 'dark' })}>
            <RiRefreshLine aria-hidden size={14} />
            reset
          </Button>
        </div>
      </div>
      <div className="flex min-w-0 md:w-[46%] md:shrink-0">
        <ThemePreview palette={palette} />
      </div>
    </div>
  );
}

const SIZE_WORDS: Record<TextSize, string> = {
  80: 'smallest',
  90: 'small',
  100: 'normal',
  110: 'large',
  125: 'largest'
};

function SizeSwatch({ size }: { size: TextSize }) {
  return (
    <span
      aria-hidden
      className="flex h-16 w-full items-center justify-center border border-primaryStroke bg-background soft:rounded-[4px] bubble:rounded-[8px] [--aa:1.75rem] max-md:h-9 max-md:[--aa:0.95rem]"
    >
      <span className="font-semibold leading-none" style={{ fontSize: `calc(${size / 100} * var(--aa))` }}>
        Aa
      </span>
    </span>
  );
}

export function AppearanceTab() {
  const theme = useAtomValue(themeAtom);
  const palette = useAtomValue(paletteAtom);
  const size = useAtomValue(textSizeAtom);
  const custom = theme.kind === 'custom';
  const customPalette = custom ? palette : null;

  return (
    <div className="divide-y divide-primaryStroke">
      <fieldset className={FIELDSET}>
        <legend className={SECTION_TITLE}>shape</legend>
        <ShapePicker />
      </fieldset>

      <fieldset className={FIELDSET}>
        <legend className={SECTION_TITLE}>theme</legend>
        <div role="presentation" className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-4 md:gap-3">
          {PRESET_NAMES.map((name) => (
            <div key={name} className="grid min-w-0">
              <OptionCard
                id={`theme-${name}`}
                name="theme"
                checked={theme.kind === 'preset' && theme.name === name}
                onChange={() => setTheme({ kind: 'preset', name })}
                picture={<Swatch palette={PRESETS[name]} />}
                label={PRESET_LABELS[name] ?? name}
                compact
              />
            </div>
          ))}
          <div className="grid min-w-0">
            <OptionCard
              id="theme-custom"
              name="theme"
              checked={custom}
              onChange={() => setTheme(customFrom(palette))}
              picture={<Swatch palette={customPalette ?? palette} />}
              label="custom"
              compact
            />
          </div>
        </div>
      </fieldset>

      {theme.kind === 'custom' && (
        <Block title="colours">
          <CustomColours theme={theme} palette={palette} />
        </Block>
      )}

      <fieldset className={FIELDSET}>
        <legend className={SECTION_TITLE}>size</legend>
        <div role="presentation" className="mt-2 grid grid-cols-5 gap-1.5 md:gap-3">
          {TEXT_SIZES.map((s) => (
            <OptionCard
              key={s}
              id={`text-size-${s}`}
              name="text-size"
              checked={s === size}
              onChange={() => setTextSize(s)}
              picture={<SizeSwatch size={s} />}
              label={SIZE_WORDS[s]}
              compact="tight"
            />
          ))}
        </div>
      </fieldset>
    </div>
  );
}
