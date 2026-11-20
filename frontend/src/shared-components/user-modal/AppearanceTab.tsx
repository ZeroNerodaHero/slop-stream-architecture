import { useAtomValue } from 'jotai';

import { customFrom, paletteAtom, setCustomColor, setTextSize, setTheme, TEXT_SIZES, type TextSize, textSizeAtom, themeAtom } from '@/infra/atoms/settings-atoms';
import { contrast, hex, type Palette, PRESET_NAMES, PRESETS, type TokenName, TOKENS } from '@/infra/theme';
import { Button } from '@/shared-components/Button';
import { FIELDSET, Block, Field, OptionCard, SECTION_TITLE } from '@/shared-components/user-modal/parts';
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

const css = (c: readonly number[]) => `rgb(${c.join(' ')})`;

/** A palette in one picture: its page with a box on it, the site's title motif inside: a blue bar and `Aa` in its text. */
function Swatch({ palette }: { palette: Palette }) {
  return (
    <span
      aria-hidden
      className="flex h-16 w-full min-w-0 items-center overflow-hidden p-1 max-md:h-12"
      style={{ backgroundColor: css(palette.background), border: `1px solid ${css(palette.primaryStroke)}` }}
    >
      <span
        className="flex h-full min-w-0 flex-1 items-center gap-1 px-1"
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

/** The browser's colour box, squared off: no padding, no inner border, no corners. */
const COLOR_INPUT =
  'h-11 w-11 shrink-0 cursor-pointer appearance-none border border-primaryStroke bg-transparent p-0 [&::-moz-color-swatch]:border-0 [&::-webkit-color-swatch-wrapper]:p-0 [&::-webkit-color-swatch]:border-0 disabled:cursor-default disabled:opacity-40';

/** The five sizes, smallest first, each with its word. */
const SIZE_WORDS: Record<TextSize, string> = {
  80: 'smallest',
  90: 'small',
  100: 'normal',
  110: 'large',
  125: 'largest'
};

/**
 * A size in one picture: `Aa` at that share of the page's, on the page. In rems, so the cards
 * shrink and grow with the pick and keep their steps apart from one another.
 */
function SizeSwatch({ size }: { size: TextSize }) {
  return (
    <span aria-hidden className="flex h-16 w-full items-center justify-center border border-primaryStroke bg-background [--aa:1.75rem] max-md:h-9 max-md:[--aa:0.95rem]">
      <span className="font-semibold leading-none" style={{ fontSize: `calc(${size / 100} * var(--aa))` }}>
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
      <fieldset className={FIELDSET}>
        <legend className={SECTION_TITLE}>theme</legend>
        {/* one row of five on a desktop; a phone has the three presets in thirds, then midnight and custom in halves */}
        <div role="presentation" className="mt-2 grid grid-cols-6 gap-2 md:grid-cols-5 md:gap-3">
          {PRESET_NAMES.map((name, i) => (
            <div key={name} className={cn('grid min-w-0 md:col-span-1', i < 3 ? 'col-span-2' : 'col-span-3')}>
              <OptionCard
                id={`theme-${name}`}
                name="theme"
                checked={theme.kind === 'preset' && theme.name === name}
                onChange={() => setTheme({ kind: 'preset', name })}
                picture={<Swatch palette={PRESETS[name]} />}
                label={name}
                compact
              />
            </div>
          ))}
          <div className="col-span-3 grid min-w-0 md:col-span-1">
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

      {custom && (
        <Block title="colours">
          <div className="flex flex-col gap-3">
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
              contrast {contrast(palette.textPrimary, palette.background).toFixed(1)}:1
              {theme.text !== null && contrast(palette.textPrimary, palette.background) >= 4.5 && hex(palette.textPrimary) !== theme.text.toLowerCase()
                ? ' (yours, nudged to read)'
                : ''}
            </p>
            <div>
              <Button id="theme-reset" size="sm" onClick={() => setTheme({ kind: 'preset', name: 'dark' })}>
                reset
              </Button>
            </div>
          </div>
        </Block>
      )}

      {/* the root font size as a percentage (settings.textSize): every rem in the stylesheet follows it,
          so the words and the room around them shrink and grow together, the way the browser's zoom does */}
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
