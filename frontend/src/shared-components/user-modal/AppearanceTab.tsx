import { useAtomValue } from 'jotai';

import { customFrom, paletteAtom, setCustomColor, setTextSize, setTheme, TEXT_SIZES, type TextSize, textSizeAtom, themeAtom } from '@/infra/atoms/settings-atoms';
import { contrast, hex, type Palette, PRESET_NAMES, PRESETS, type PresetName, type TokenName, TOKENS } from '@/infra/theme';
import { Field, OptionCard, SECTION_TITLE, Section } from '@/shared-components/user-modal/parts';
import { cn } from '@/utils/cn';

const PRESET_DETAIL: Record<PresetName, string> = {
  dark: 'the default',
  light: 'the same boxes on white',
  paper: 'warm, like unbleached paper',
  midnight: 'deeper, bluer black'
};

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

const css = (c: readonly number[]) => `rgb(${c.join(' ')})`;

/** A palette in one picture: its page with a box on it, the site's title motif inside: a blue bar and `Aa` in its text. */
function Swatch({ palette }: { palette: Palette }) {
  return (
    <span
      aria-hidden
      className="flex h-14 w-full items-center p-2"
      style={{ backgroundColor: css(palette.background), border: `1px solid ${css(palette.primaryStroke)}` }}
    >
      <span
        className="flex h-full flex-1 items-center gap-2 px-2"
        style={{
          backgroundColor: css(palette.backgroundSecondary),
          border: `1px solid ${css(palette.primaryStroke)}`
        }}
      >
        <span className="h-5 w-1" style={{ backgroundColor: css(palette.primaryColor) }} />
        <span className="text-base font-semibold leading-none" style={{ color: css(palette.textPrimary) }}>
          Aa
        </span>
        <span className="ml-auto h-2 w-2" style={{ backgroundColor: css(palette.increase) }} />
      </span>
    </span>
  );
}

/** The browser's colour box, squared off: no padding, no inner border, no corners. */
const COLOR_INPUT =
  'h-11 w-11 shrink-0 cursor-pointer appearance-none border border-primaryStroke bg-transparent p-0 [&::-moz-color-swatch]:border-0 [&::-webkit-color-swatch-wrapper]:p-0 [&::-webkit-color-swatch]:border-0 disabled:cursor-default disabled:opacity-40';

/** The five sizes, smallest first, each with its word and what it is of the browser's own. */
const SIZE_WORDS: Record<TextSize, { label: string; detail: string }> = {
  80: { label: 'smallest', detail: '80%. the most on a screen' },
  90: { label: 'small', detail: '90%. a step down' },
  100: { label: 'normal', detail: '100%, the default: the browser\u2019s own size' },
  110: { label: 'large', detail: '110%. a step up' },
  125: { label: 'largest', detail: '125%. for a screen across the room' }
};

/**
 * A size in one picture: `Aa` at that share of the page's, on the page. In rems, so the cards
 * shrink and grow with the pick and keep their steps apart from one another.
 */
function SizeSwatch({ size }: { size: TextSize }) {
  return (
    <span aria-hidden className="flex h-14 w-full items-center justify-center border border-primaryStroke bg-background">
      <span className="font-semibold leading-none" style={{ fontSize: `${(size / 100) * 1.5}rem` }}>
        Aa
      </span>
    </span>
  );
}

/**
 * The theme: a preset, or colours of their own. Picking applies and keeps at once, so the page
 * behind is the preview; the derivation keeps the text readable whatever the picks, and dark
 * is one click away. And the size: how big the whole page is, in five steps. Kept in this
 * browser, like the layout.
 */
export function AppearanceTab() {
  const theme = useAtomValue(themeAtom);
  const palette = useAtomValue(paletteAtom);
  const size = useAtomValue(textSizeAtom);
  const custom = theme.kind === 'custom';
  // the custom card's picture: the colours it would start from, or the ones it has
  const customPalette = custom ? palette : null;

  return (
    <div className="divide-y divide-primaryStroke">
      <fieldset className="m-0 border-0 p-0 py-6 first:pt-0 last:pb-0">
        <legend className={SECTION_TITLE}>theme</legend>
        <p className="mt-1 text-textSecondary">kept in this browser. the page behind follows as you pick.</p>
        <div role="presentation" className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {PRESET_NAMES.map((name) => (
            <OptionCard
              key={name}
              id={`theme-${name}`}
              name="theme"
              checked={theme.kind === 'preset' && theme.name === name}
              onChange={() => setTheme({ kind: 'preset', name })}
              picture={<Swatch palette={PRESETS[name]} />}
              label={name}
              detail={PRESET_DETAIL[name]}
            />
          ))}
          <OptionCard
            id="theme-custom"
            name="theme"
            checked={custom}
            onChange={() => setTheme(customFrom(palette))}
            picture={<Swatch palette={customPalette ?? palette} />}
            label="custom"
            detail="your own colours; the rest follows them"
          />
        </div>
      </fieldset>

      {custom && (
        <Section
          title="colours"
          description="pick the page and the accent; the boxes, strokes and greys are made from them so everything stays readable. the text too, unless you set it."
        >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field id="color-background" label="background">
              <span className="flex items-center gap-3">
                <input
                  id="color-background"
                  type="color"
                  value={theme.background}
                  onChange={(e) => setCustomColor('background', e.target.value)}
                  className={COLOR_INPUT}
                />
                <code className="text-sm text-textSecondary">{theme.background}</code>
              </span>
            </Field>
            <Field id="color-accent" label="accent">
              <span className="flex items-center gap-3">
                <input id="color-accent" type="color" value={theme.accent} onChange={(e) => setCustomColor('accent', e.target.value)} className={COLOR_INPUT} />
                <code className="text-sm text-textSecondary">{theme.accent}</code>
              </span>
            </Field>
            <Field id="color-text" label="text">
              <span className="flex items-center gap-3">
                <input
                  id="color-text"
                  type="color"
                  value={theme.text ?? hex(palette.textPrimary)}
                  disabled={theme.text === null}
                  onChange={(e) => setCustomColor('text', e.target.value)}
                  className={COLOR_INPUT}
                />
                <label className="flex items-center gap-2 text-sm text-textSecondary">
                  <input
                    id="color-text-auto"
                    type="checkbox"
                    checked={theme.text === null}
                    onChange={(e) => setCustomColor('text', e.target.checked ? null : hex(palette.textPrimary))}
                    className="h-4 w-4 appearance-none border border-primaryStroke bg-background checked:border-primaryBlue checked:bg-primaryBlue"
                  />
                  auto
                </label>
              </span>
            </Field>
          </div>

          {/* what the three make: the twelve, so a nudge for readability is seen, not suffered */}
          <ul className="flex flex-wrap gap-2" aria-label="the colours these make">
            {TOKENS.map((token) => (
              <li key={token} className="flex flex-col items-center gap-1" title={`${TOKEN_LABEL[token]} ${hex(palette[token])}`}>
                <span className="h-7 w-7 border border-primaryStroke" style={{ backgroundColor: css(palette[token]) }} />
                <span className="text-[10px] uppercase tracking-wider text-textTertiary">{TOKEN_LABEL[token]}</span>
              </li>
            ))}
          </ul>
          <p className={cn('text-sm', contrast(palette.textPrimary, palette.background) >= 4.5 ? 'text-textTertiary' : 'text-decrease')}>
            text on background: {contrast(palette.textPrimary, palette.background).toFixed(1)}:1
            {theme.text !== null && contrast(palette.textPrimary, palette.background) >= 4.5 && hex(palette.textPrimary) !== theme.text.toLowerCase()
              ? ' (yours, nudged to read)'
              : ''}
          </p>
          <div>
            <button id="theme-reset" type="button" className="text-base font-semibold text-primaryBlue" onClick={() => setTheme({ kind: 'preset', name: 'dark' })}>
              back to dark
            </button>
          </div>
        </Section>
      )}

      {/* the root font size as a percentage (settings.textSize): every rem in the stylesheet follows it,
          so the words and the room around them shrink and grow together, the way the browser's zoom does */}
      <fieldset className="m-0 border-0 p-0 py-6 first:pt-0 last:pb-0">
        <legend className={SECTION_TITLE}>size</legend>
        <p className="mt-1 text-textSecondary">
          how big everything is: the words, and the room around them. the browser&apos;s own size, or a step or two either way. the page behind follows as you pick.
        </p>
        <div role="presentation" className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          {TEXT_SIZES.map((s) => (
            <OptionCard
              key={s}
              id={`text-size-${s}`}
              name="text-size"
              checked={s === size}
              onChange={() => setTextSize(s)}
              picture={<SizeSwatch size={s} />}
              label={SIZE_WORDS[s].label}
              detail={SIZE_WORDS[s].detail}
            />
          ))}
        </div>
        <p className="mt-4 text-sm text-textTertiary">kept in this browser, for every page. the browser&apos;s own zoom works on top of it.</p>
      </fieldset>
    </div>
  );
}
