/**
 * The palette: the twelve colours globals.css holds as rgb triplets (so tailwind can add alpha),
 * the presets, and the derivation that turns a background and an accent of someone's choosing
 * into all twelve, readable. No dependencies. Mixing is done in oklab (a straight line there is
 * what "a little toward the text" should mean; near-greys have no hue to arc through), contrast
 * is wcag 2's ratio. Every function is total: channels clamp to 0..255, NaN falls to 0.
 */

export const TOKENS = [
  'background',
  'backgroundSecondary',
  'backgroundTertiary',
  'textPrimary',
  'textSecondary',
  'textTertiary',
  'primaryColor',
  'primaryColorHover',
  'primaryStroke',
  'secondaryStroke',
  'increase',
  'decrease'
] as const;

export type TokenName = (typeof TOKENS)[number];
export type RGB = [number, number, number];
export type Palette = Record<TokenName, RGB>;

/** The css variable each token is, in globals.css. */
export const CSS_VAR: Record<TokenName, string> = {
  background: '--background',
  backgroundSecondary: '--background-secondary',
  backgroundTertiary: '--background-tertiary',
  textPrimary: '--text-primary',
  textSecondary: '--text-secondary',
  textTertiary: '--text-tertiary',
  primaryColor: '--primary-color',
  primaryColorHover: '--primary-color-hover',
  primaryStroke: '--primary-stroke',
  secondaryStroke: '--secondary-stroke',
  increase: '--increase',
  decrease: '--decrease'
};

// ---- presets ---------------------------------------------------------------------------

/** What globals.css says. The stylesheet's own values; this preset applies nothing. */
export const DARK: Palette = {
  background: [15, 17, 21],
  backgroundSecondary: [24, 27, 34],
  backgroundTertiary: [32, 36, 46],
  textPrimary: [242, 243, 245],
  textSecondary: [154, 163, 178],
  textTertiary: [110, 118, 132],
  primaryColor: [79, 139, 255],
  primaryColorHover: [110, 160, 255],
  primaryStroke: [42, 47, 58],
  secondaryStroke: [58, 64, 78],
  increase: [63, 185, 80],
  decrease: [248, 81, 73]
};

/** The same boxes on white. The accent is deeper than the dark theme's: #4f8bff on white is 3.3:1, this is 5.2. */
export const LIGHT: Palette = {
  background: [255, 255, 255],
  backgroundSecondary: [245, 246, 249],
  backgroundTertiary: [235, 237, 242],
  textPrimary: [17, 19, 24],
  textSecondary: [84, 92, 108],
  textTertiary: [120, 128, 144],
  primaryColor: [37, 99, 235],
  primaryColorHover: [29, 78, 216],
  primaryStroke: [212, 215, 222],
  secondaryStroke: [186, 191, 202],
  increase: [22, 133, 62],
  decrease: [220, 38, 38]
};

/** Warm light: unbleached paper, ink-blue accent. */
export const PAPER: Palette = {
  background: [247, 243, 235],
  backgroundSecondary: [240, 235, 225],
  backgroundTertiary: [231, 225, 213],
  textPrimary: [38, 32, 26],
  textSecondary: [104, 94, 82],
  textTertiary: [132, 121, 107],
  primaryColor: [37, 88, 176],
  primaryColorHover: [29, 71, 146],
  primaryStroke: [212, 204, 189],
  secondaryStroke: [188, 179, 163],
  increase: [20, 125, 58],
  decrease: [196, 48, 36]
};

/** Deep blue-black: a lower floor than dark, cooler greys, a touch more electric accent. */
export const MIDNIGHT: Palette = {
  background: [8, 12, 24],
  backgroundSecondary: [16, 21, 37],
  backgroundTertiary: [24, 31, 52],
  textPrimary: [232, 236, 248],
  textSecondary: [150, 162, 190],
  textTertiary: [104, 116, 144],
  primaryColor: [88, 146, 255],
  primaryColorHover: [122, 170, 255],
  primaryStroke: [34, 44, 70],
  secondaryStroke: [52, 64, 96],
  increase: [52, 199, 89],
  decrease: [255, 92, 84]
};

export const PRESETS = { dark: DARK, light: LIGHT, paper: PAPER, midnight: MIDNIGHT } as const;
export type PresetName = keyof typeof PRESETS;
export const PRESET_NAMES = Object.keys(PRESETS) as PresetName[];

// ---- numbers ---------------------------------------------------------------------------

const WHITE: RGB = [255, 255, 255];
const BLACK: RGB = [0, 0, 0];

// comparisons are false for NaN, so NaN lands on the lower bound
const clamp01 = (v: number) => (v > 0 ? (v < 1 ? v : 1) : 0);
const clamp255 = (v: number) => (v > 0 ? (v < 255 ? Math.round(v) : 255) : 0);
export const rgb = (r: number, g: number, b: number): RGB => [clamp255(r), clamp255(g), clamp255(b)];

/** sRGB 0..255 to linear light 0..1 (wcag). */
const linearize = (c: number) => {
  const v = clamp01(c / 255);
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
/** Linear light to sRGB 0..255. Clamps first, so an out-of-gamut negative cannot make NaN. */
const delinearize = (c: number) => {
  const v = clamp01(c);
  return 255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
};

export const luminance = ([r, g, b]: RGB) => 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);

/** wcag 2 contrast ratio, 1..21. */
export function contrast(a: RGB, b: RGB): number {
  const la = luminance(a) + 0.05;
  const lb = luminance(b) + 0.05;
  return la > lb ? la / lb : lb / la;
}

/**
 * "Dark" is a background white text reads better on than black text does. The crossover is
 * at relative luminance ~0.18 (grey 118), which is also what settles a mid-grey: whichever
 * text wins, wins.
 */
export const isDark = (bg: RGB) => contrast(WHITE, bg) >= contrast(BLACK, bg);

// ---- oklab (björn ottosson, 2020) ----------------------------------------------------------

type Lab = [number, number, number];

function toLab([r, g, b]: RGB): Lab {
  const R = linearize(r);
  const G = linearize(g);
  const B = linearize(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  ];
}

function fromLab([L, a, b]: Lab): RGB {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return rgb(
    delinearize(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    delinearize(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    delinearize(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)
  );
}

/** t = 0 is a, t = 1 is b, a straight line in oklab between. */
export function mix(a: RGB, b: RGB, t: number): RGB {
  const k = clamp01(t);
  const A = toLab(a);
  const B = toLab(b);
  return fromLab([A[0] + (B[0] - A[0]) * k, A[1] + (B[1] - A[1]) * k, A[2] + (B[2] - A[2]) * k]);
}

/** c's hue and chroma pulled toward `source` by t, its lightness kept, so contrast is untouched. */
function tint(c: RGB, source: RGB, t: number): RGB {
  const k = clamp01(t);
  const C = toLab(c);
  const S = toLab(source);
  return fromLab([C[0], C[1] + (S[1] - C[1]) * k, C[2] + (S[2] - C[2]) * k]);
}

/**
 * fg nudged toward `toward` (white on a dark bg, black on a light one) until it reads at `min`
 * against bg. A scan, not a bisection: a fg on the wrong side of bg dips through bg's luminance
 * before it rises. When even the extreme cannot reach `min` (a mid-grey), the extreme it is.
 */
export function ensureContrast(fg: RGB, bg: RGB, min: number, toward: RGB = isDark(bg) ? WHITE : BLACK): RGB {
  if (contrast(fg, bg) >= min) return fg;
  for (let i = 1; i < 64; i++) {
    const c = mix(fg, toward, i / 64);
    if (contrast(c, bg) >= min) return c;
  }
  return toward;
}

// ---- derivation -------------------------------------------------------------------------

export interface DeriveInput {
  background: RGB;
  accent: RGB;
  /** Left out: near-white on a dark background, near-black on a light one. */
  text?: RGB;
}

// oklab mix amounts, calibrated on DARK: deriving from its background, accent and text gives
// it back within a few units per channel. a light field takes half the surface step, since
// the same lift reads as a dirtier grey on white.
const SURFACE = { dark: [0.06, 0.12], light: [0.035, 0.07] } as const;
const STROKE = [0.16, 0.26] as const;
const TEXT_FADE = [0.32, 0.5] as const;
const HOVER = { dark: 0.16, light: 0.1 } as const;
/** The neutrals carry a little of the accent's hue, the way the shipped greys are blue-tinted slate. */
const TINT = { surface: 0.05, ink: 0.09 } as const;

export function derivePalette({ background, accent, text }: DeriveInput): Palette {
  const bg = rgb(...background);
  const dark = isDark(bg);
  const seed = dark ? DARK : LIGHT;
  // the way that gains contrast against the page, fixed once: a surface lifted toward the
  // text could sit across the crossover and flip the text to the worse colour otherwise
  const away: RGB = dark ? WHITE : BLACK;
  const [s1, s2] = dark ? SURFACE.dark : SURFACE.light;

  // the accent is theirs; touched only if it fails 3:1 on the page (wcag 1.4.11)
  const primaryColor = ensureContrast(rgb(...accent), bg, 3, away);
  const surface = (c: RGB) => tint(c, primaryColor, TINT.surface);
  const ink = (c: RGB) => tint(c, primaryColor, TINT.ink);

  const textBase = ensureContrast(text ? rgb(...text) : seed.textPrimary, bg, 4.5, away);
  const backgroundSecondary = surface(mix(bg, textBase, s1));
  const backgroundTertiary = surface(mix(bg, textBase, s2));

  // checked against the tertiary surface, the one nearest the text: passing there passes everywhere
  const textPrimary = ensureContrast(textBase, backgroundTertiary, 4.5, away);
  const textSecondary = ensureContrast(ink(mix(textPrimary, bg, TEXT_FADE[0])), backgroundTertiary, 4.5, away);
  const textTertiary = ensureContrast(ink(mix(textPrimary, bg, TEXT_FADE[1])), backgroundTertiary, 3, away);

  // hover moves away from the page, so it reads as more, never as faded
  const primaryColorHover = mix(primaryColor, away, dark ? HOVER.dark : HOVER.light);

  return {
    background: bg,
    backgroundSecondary,
    backgroundTertiary,
    textPrimary,
    textSecondary,
    textTertiary,
    primaryColor,
    primaryColorHover,
    primaryStroke: ink(mix(bg, textPrimary, STROKE[0])),
    secondaryStroke: ink(mix(bg, textPrimary, STROKE[1])),
    increase: ensureContrast(seed.increase, backgroundTertiary, 3, away),
    decrease: ensureContrast(seed.decrease, backgroundTertiary, 3, away)
  };
}

// ---- css -------------------------------------------------------------------------------

/** `--background: '15 17 21'` and the eleven others, the way globals.css spells them. */
export const toCssVars = (p: Palette): Record<string, string> => Object.fromEntries(TOKENS.map((t) => [CSS_VAR[t], rgb(...p[t]).join(' ')]));

export const schemeOf = (p: Palette): 'dark' | 'light' => (isDark(p.background) ? 'dark' : 'light');

/** The palette onto a document: inline on its <html> (this page's unless another is given: the popped out player's), which outranks the stylesheet's :root. */
export function applyPalette(p: Palette, root: HTMLElement = document.documentElement): void {
  const style = root.style;
  for (const [name, value] of Object.entries(toCssVars(p))) style.setProperty(name, value);
  style.setProperty('color-scheme', schemeOf(p));
}

/** Back to the stylesheet: the dark theme, as written. */
export function clearPalette(root: HTMLElement = document.documentElement): void {
  const style = root.style;
  for (const t of TOKENS) style.removeProperty(CSS_VAR[t]);
  style.removeProperty('color-scheme');
}

// ---- <input type="color"> --------------------------------------------------------------------

export const hex = (c: RGB): string =>
  '#' +
  rgb(...c)
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');

/** #rrggbb, rrggbb or #rgb. Anything else is `fallback`. */
export function fromHex(s: string, fallback: RGB = BLACK): RGB {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(s).trim());
  const digits = m?.[1];
  if (!digits) return fallback;
  const h = digits.length === 3 ? digits.replace(/./g, (ch) => ch + ch) : digits;
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export const isHex = (s: unknown): s is string => typeof s === 'string' && /^#[0-9a-f]{6}$/i.test(s);
