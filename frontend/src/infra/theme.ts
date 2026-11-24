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

export const BSOD: Palette = {
  background: [0, 0, 170],
  backgroundSecondary: [0, 0, 140],
  backgroundTertiary: [0, 0, 120],
  textPrimary: [255, 255, 255],
  textSecondary: [208, 208, 236],
  textTertiary: [170, 170, 255],
  primaryColor: [255, 255, 85],
  primaryColorHover: [255, 255, 170],
  primaryStroke: [85, 85, 255],
  secondaryStroke: [170, 170, 255],
  increase: [85, 255, 85],
  decrease: [255, 120, 120]
};

export const YOTSUBA: Palette = {
  background: [255, 255, 238],
  backgroundSecondary: [240, 224, 214],
  backgroundTertiary: [232, 210, 198],
  textPrimary: [128, 0, 0],
  textSecondary: [122, 40, 30],
  textTertiary: [132, 70, 58],
  primaryColor: [0, 0, 238],
  primaryColorHover: [221, 0, 0],
  primaryStroke: [217, 191, 183],
  secondaryStroke: [184, 146, 136],
  increase: [17, 119, 67],
  decrease: [204, 17, 5]
};

export const STAWBURY: Palette = {
  background: [255, 244, 249],
  backgroundSecondary: [253, 230, 241],
  backgroundTertiary: [249, 214, 234],
  textPrimary: [74, 28, 58],
  textSecondary: [118, 58, 98],
  textTertiary: [134, 78, 114],
  primaryColor: [201, 34, 113],
  primaryColorHover: [168, 22, 92],
  primaryStroke: [242, 196, 222],
  secondaryStroke: [196, 168, 232],
  increase: [18, 122, 84],
  decrease: [200, 28, 60]
};

export const PRESETS = { dark: DARK, light: LIGHT, paper: PAPER, midnight: MIDNIGHT, bsod: BSOD, yotsuba: YOTSUBA, stawbury: STAWBURY } as const;
export type PresetName = keyof typeof PRESETS;
export const PRESET_NAMES = Object.keys(PRESETS) as PresetName[];
export const PRESET_LABELS: Partial<Record<PresetName, string>> = { bsod: 'BSOD' };

const WHITE: RGB = [255, 255, 255];
const BLACK: RGB = [0, 0, 0];

const clamp01 = (v: number) => (v > 0 ? (v < 1 ? v : 1) : 0);
const clamp255 = (v: number) => (v > 0 ? (v < 255 ? Math.round(v) : 255) : 0);
export const rgb = (r: number, g: number, b: number): RGB => [clamp255(r), clamp255(g), clamp255(b)];

const linearize = (c: number) => {
  const v = clamp01(c / 255);
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const delinearize = (c: number) => {
  const v = clamp01(c);
  return 255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
};

export const luminance = ([r, g, b]: RGB) => 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);

export function contrast(a: RGB, b: RGB): number {
  const la = luminance(a) + 0.05;
  const lb = luminance(b) + 0.05;
  return la > lb ? la / lb : lb / la;
}

export const isDark = (bg: RGB) => contrast(WHITE, bg) >= contrast(BLACK, bg);

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

export function mix(a: RGB, b: RGB, t: number): RGB {
  const k = clamp01(t);
  const A = toLab(a);
  const B = toLab(b);
  return fromLab([A[0] + (B[0] - A[0]) * k, A[1] + (B[1] - A[1]) * k, A[2] + (B[2] - A[2]) * k]);
}

function tint(c: RGB, source: RGB, t: number): RGB {
  const k = clamp01(t);
  const C = toLab(c);
  const S = toLab(source);
  return fromLab([C[0], C[1] + (S[1] - C[1]) * k, C[2] + (S[2] - C[2]) * k]);
}

export function ensureContrast(fg: RGB, bg: RGB, min: number, toward: RGB = isDark(bg) ? WHITE : BLACK): RGB {
  if (contrast(fg, bg) >= min) return fg;
  for (let i = 1; i < 64; i++) {
    const c = mix(fg, toward, i / 64);
    if (contrast(c, bg) >= min) return c;
  }
  return toward;
}

export interface DeriveInput {
  background: RGB;
  accent: RGB;
  text?: RGB;
}

const SURFACE = { dark: [0.06, 0.12], light: [0.035, 0.07] } as const;
const STROKE = [0.16, 0.26] as const;
const TEXT_FADE = [0.32, 0.5] as const;
const HOVER = { dark: 0.16, light: 0.1 } as const;
const TINT = { surface: 0.05, ink: 0.09 } as const;

export function derivePalette({ background, accent, text }: DeriveInput): Palette {
  const bg = rgb(...background);
  const dark = isDark(bg);
  const seed = dark ? DARK : LIGHT;
  const away: RGB = dark ? WHITE : BLACK;
  const [s1, s2] = dark ? SURFACE.dark : SURFACE.light;

  const primaryColor = ensureContrast(rgb(...accent), bg, 3, away);
  const surface = (c: RGB) => tint(c, primaryColor, TINT.surface);
  const ink = (c: RGB) => tint(c, primaryColor, TINT.ink);

  const textBase = ensureContrast(text ? rgb(...text) : seed.textPrimary, bg, 4.5, away);
  const backgroundSecondary = surface(mix(bg, textBase, s1));
  const backgroundTertiary = surface(mix(bg, textBase, s2));

  const textPrimary = ensureContrast(textBase, backgroundTertiary, 4.5, away);
  const textSecondary = ensureContrast(ink(mix(textPrimary, bg, TEXT_FADE[0])), backgroundTertiary, 4.5, away);
  const textTertiary = ensureContrast(ink(mix(textPrimary, bg, TEXT_FADE[1])), backgroundTertiary, 3, away);

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

export const toCssVars = (p: Palette): Record<string, string> => Object.fromEntries(TOKENS.map((t) => [CSS_VAR[t], rgb(...p[t]).join(' ')]));

export const schemeOf = (p: Palette): 'dark' | 'light' => (isDark(p.background) ? 'dark' : 'light');

export function applyPalette(p: Palette, root: HTMLElement = document.documentElement): void {
  const style = root.style;
  for (const [name, value] of Object.entries(toCssVars(p))) style.setProperty(name, value);
  style.setProperty('color-scheme', schemeOf(p));
}

export function clearPalette(root: HTMLElement = document.documentElement): void {
  const style = root.style;
  for (const t of TOKENS) style.removeProperty(CSS_VAR[t]);
  style.removeProperty('color-scheme');
}

export const hex = (c: RGB): string =>
  '#' +
  rgb(...c)
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');

export function fromHex(s: string, fallback: RGB = BLACK): RGB {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(s).trim());
  const digits = m?.[1];
  if (!digits) return fallback;
  const h = digits.length === 3 ? digits.replace(/./g, (ch) => ch + ch) : digits;
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export const isHex = (s: unknown): s is string => typeof s === 'string' && /^#[0-9a-f]{6}$/i.test(s);
