import type { Box } from './box.ts';
import { AVATAR_SHAPES, type AvatarShape } from './avatar-look.ts';
import type { Shape } from './shape.ts';

export type TextAlign = 'left' | 'center' | 'right';

export interface TextStyle {
  size: number;
  color: string;
  bg?: string;
  align?: TextAlign;
  shape?: AvatarShape;
}

export type TimerMode = 'clock' | 'countdown' | 'uptime';

export interface TimerSpec {
  mode: TimerMode;
  start?: number;
  end?: number;
}

export interface ChatSpec {
  lines: number;
}

export type TextKind = 'title' | 'lower third' | 'label';

export interface TextPreset {
  style: TextStyle;
  box: Box;
}

export const TEXT_MAX = 120;
export const TEXT_SIZE_MIN = 0.01;
export const TEXT_SIZE_MAX = 0.5;
export const CHAT_LINES_MAX = 20;
export const TEXT_ALIGNS: readonly TextAlign[] = ['left', 'center', 'right'];
export const TEXT_KINDS: readonly TextKind[] = ['title', 'lower third', 'label'];
export const TEXT_COLOR = '#ffffff';
export const TEXT_BG = '#000000';
export const TEXT_FONT = '"Geist Variable", system-ui, sans-serif';
export const TEXT_WEIGHT = 600;
export const TEXT_LEADING = 1.2;
export const TEXT_PAD = 0.5;
export const TEXT_WORD = 'text';

export const TEXT_PRESETS: Record<TextKind, TextPreset> = {
  title: { style: { size: 0.1, color: TEXT_COLOR, align: 'center' }, box: { x: 0.1, y: 0.38, w: 0.8, h: 0.24 } },
  'lower third': { style: { size: 0.05, color: TEXT_COLOR, bg: TEXT_BG, align: 'left' }, box: { x: 0.04, y: 0.78, w: 0.5, h: 0.12 } },
  label: { style: { size: 0.035, color: TEXT_COLOR, bg: TEXT_BG, align: 'center' }, box: { x: 0.04, y: 0.04, w: 0.22, h: 0.08 } }
};

const HEX = /^#[0-9a-f]{6}$/i;
const LATEST_EPOCH_MS = 4_102_444_800_000;

const record = (raw: unknown): Record<string, unknown> | null => (raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null);
const hex = (raw: unknown): string | undefined => (typeof raw === 'string' && HEX.test(raw) ? raw.toLowerCase() : undefined);
const epoch = (raw: unknown): number | undefined => (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= LATEST_EPOCH_MS ? raw : undefined);

const shown = (ch: string) => {
  const code = ch.codePointAt(0) ?? 0;
  return ch === '\n' || !(code < 32 || (code >= 127 && code <= 159));
};

export function cleanText(raw: string): string {
  const flat = raw.replace(/\r\n?/g, '\n').replace(/\t/g, ' ');
  return [...flat].filter(shown).slice(0, TEXT_MAX).join('');
}

export function readText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = cleanText(raw);
  return text.trim() ? text : null;
}

export function readTextStyle(raw: unknown): TextStyle | null {
  const s = record(raw);
  if (!s || typeof s.size !== 'number' || !Number.isFinite(s.size)) return null;
  const bg = hex(s.bg);
  const align = TEXT_ALIGNS.includes(s.align as TextAlign) ? (s.align as TextAlign) : undefined;
  const shape = AVATAR_SHAPES.includes(s.shape as AvatarShape) ? (s.shape as AvatarShape) : undefined;
  return {
    size: Math.round(Math.min(TEXT_SIZE_MAX, Math.max(TEXT_SIZE_MIN, s.size)) * 1000) / 1000,
    color: hex(s.color) ?? TEXT_COLOR,
    ...(bg && { bg }),
    ...(align && { align }),
    ...(shape && { shape })
  };
}

export function readTimer(raw: unknown): TimerSpec | null {
  const t = record(raw);
  if (!t) return null;
  const start = epoch(t.start);
  const end = epoch(t.end);
  if (t.mode === 'clock') return { mode: 'clock' };
  if (t.mode === 'countdown' && end !== undefined) return { mode: 'countdown', end };
  if (t.mode === 'uptime' && start !== undefined) return { mode: 'uptime', start };
  return null;
}

export function readChat(raw: unknown): ChatSpec | null {
  const c = record(raw);
  return c && typeof c.lines === 'number' && Number.isInteger(c.lines) && c.lines >= 1 && c.lines <= CHAT_LINES_MAX ? { lines: c.lines } : null;
}

export const textStyleOf = (style: TextStyle | undefined): TextStyle => style ?? TEXT_PRESETS['lower third'].style;

export const alignOf = (style: TextStyle): TextAlign => style.align ?? 'center';

export const textShape = (style: TextStyle, site: Shape): Shape => (style.shape && style.shape !== 'default' ? style.shape : site);

export function kindOfStyle(style: TextStyle): TextKind | null {
  return (
    TEXT_KINDS.find((k) => {
      const p = TEXT_PRESETS[k].style;
      return p.size === style.size && !!p.bg === !!style.bg && alignOf(p) === alignOf(style);
    }) ?? null
  );
}

export function textLabel(text: string): string {
  const line = text.split('\n').find((l) => l.trim()) ?? '';
  return line.replace(/\s+/g, ' ').trim().slice(0, 32).trim() || TEXT_WORD;
}

export function textRadius(shape: Shape, h: number, px: number): number {
  if (shape === 'block') return 0;
  if (shape === 'soft') return Math.min(h / 2, px * 0.25);
  return h / 2;
}

function broken(measure: (s: string) => number, word: string, width: number): string[] {
  const out: string[] = [];
  let piece = '';
  for (const ch of word) {
    if (piece && measure(piece + ch) > width) {
      out.push(piece);
      piece = ch;
    } else piece += ch;
  }
  out.push(piece);
  return out;
}

export function wrapText(measure: (s: string) => number, text: string, width: number): string[] {
  const lines: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/ +/)) {
      const tried = line ? `${line} ${word}` : word;
      if (measure(tried) <= width) {
        line = tried;
        continue;
      }
      if (line) lines.push(line);
      const pieces = broken(measure, word, width);
      lines.push(...pieces.slice(0, -1));
      line = pieces[pieces.length - 1] ?? '';
    }
    lines.push(line);
  }
  return lines;
}

export interface TextPaint {
  text: string;
  style: TextStyle;
  shape: Shape;
}

export function paintText(ctx: CanvasRenderingContext2D, box: Box, paint: TextPaint, frameHeight: number) {
  if (box.w <= 0 || box.h <= 0) return;
  const { style } = paint;
  const px = Math.max(1, style.size * frameHeight);
  const radius = style.bg ? textRadius(paint.shape, box.h, px) : 0;
  const pad = Math.min(box.w / 4, Math.max(px * TEXT_PAD, radius * 0.6));
  const align = alignOf(style);
  ctx.save();
  ctx.beginPath();
  ctx.rect(box.x, box.y, box.w, box.h);
  ctx.clip();
  if (style.bg) {
    ctx.fillStyle = style.bg;
    ctx.beginPath();
    ctx.roundRect(box.x, box.y, box.w, box.h, radius);
    ctx.fill();
  }
  ctx.font = `${TEXT_WEIGHT} ${px}px ${TEXT_FONT}`;
  ctx.fillStyle = style.color;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  const lines = wrapText((s) => ctx.measureText(s).width, paint.text, Math.max(1, box.w - pad * 2));
  const lineHeight = px * TEXT_LEADING;
  const top = box.y + (box.h - lines.length * lineHeight) / 2 + lineHeight / 2;
  const x = align === 'left' ? box.x + pad : align === 'right' ? box.x + box.w - pad : box.x + box.w / 2;
  lines.forEach((line, i) => ctx.fillText(line, x, top + i * lineHeight));
  ctx.restore();
}
