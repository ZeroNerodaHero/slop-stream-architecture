import type { Box } from './box.ts';
import type { ExternalChat } from './api.ts';
import type { ChatLine } from './atoms/chat-atoms.ts';
import { type ChatPick, type ChatPlatform, emoteUrlOk } from './chat-source.ts';
import type { Shape } from './shape.ts';
import { CHAT_LINES_MAX, type ChatSpec, TEXT_FONT, type TextAlign, type TextStyle } from './text-paint.ts';

export type OverlayPart = { text: string } | { emote: string; url: string };

export interface OverlayLine {
  id: string;
  from: string;
  color: string;
  platform: ChatPick;
  parts: OverlayPart[];
}

export interface ChatPaint {
  lines: readonly OverlayLine[];
  style: TextStyle;
  shape: Shape;
}

export interface ChatPiece {
  kind: 'mark' | 'name' | 'word' | 'emote';
  x: number;
  w: number;
  text: string;
  color?: string;
  url?: string;
  platform?: ChatPlatform;
}

export interface ChatCard {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rows: ChatPiece[][];
  radii: [number, number, number, number];
}

export type Measure = (text: string, bold: boolean) => number;

export const CHAT_LINES = 8;
export const CHAT_SIZE_MIN = 0.015;
export const CHAT_SIZE_MAX = 0.08;
export const CHAT_STYLE: TextStyle = { size: 0.03, color: '#ffffff', bg: '#000000', align: 'left' };
export const CHAT_BOX: Box = { x: 0.02, y: 0.3, w: 0.3, h: 0.62 };
export const CHAT_WORD = 'chat';
export const CHAT_CARD_ALPHA = 0.78;
export const NAME_COLORS = { streamer: '#3fb950', verified: '#4f8bff', anon: '#f85149', platform: '#f2f3f5' } as const;
export const PLATFORM_TINTS: Record<ChatPlatform, string> = { twitch: '#9146ff', kick: '#53fc18' };
export const PLATFORM_PATHS: Record<ChatPlatform, string> = {
  twitch:
    'M21.001 3V14.7391L16.3053 19.4348H12.3923L9.95523 21.7826H6.91402V19.4348H3.00098V6.13043L4.2281 3H21.001ZM19.4358 4.56522H6.13141V16.3043H9.26185V18.6522L11.6097 16.3043H16.3053L19.4358 13.1739V4.56522ZM16.3053 7.69565V12.3913H14.7401V7.69565H16.3053ZM12.3923 7.69565V12.3913H10.8271V7.69565H12.3923Z',
  kick: 'M3 3H21V21H3V3ZM10.5637 5.53613H6.25452V18.4635H10.5637V15.5907H12.0001V17.0271H13.4364V18.4635H17.7455V14.1543H16.3091V12.7179H14.8728V11.2816H16.3091V9.8452H17.7455V5.53613H13.4364V6.97249H12.0001V8.40884H10.5637V5.53613Z'
};

const PAD_X = 0.55;
const PAD_Y = 0.28;
const LEADING = 1.3;
const GAP = 0.3;
const RUN_GAP = 0.1;
const EMOTE = 1.3;
const MARK = 1;
const MARK_GAP = 0.3;
const SOFT = 0.375;
const OUTER = 1.15;
const JOIN = 0.32;
const OUTLINE = 0.16;
const BODY_WEIGHT = 500;
const NAME_WEIGHT = 700;

export const chatLinesOf = (spec: ChatSpec | undefined): number => Math.min(CHAT_LINES_MAX, Math.max(1, spec?.lines ?? CHAT_LINES));

export function burnablePlatforms(sources: readonly ChatPlatform[], mode: ExternalChat | null | undefined): ChatPlatform[] {
  if (mode === null || mode === undefined) return [...sources];
  return mode === 'everyone' ? [...sources] : [];
}

const nameColor = (line: ChatLine): string => (line.streamer ? NAME_COLORS.streamer : line.verified ? NAME_COLORS.verified : NAME_COLORS.anon);

function partsOf(line: ChatLine, plain: (text: string) => string): OverlayPart[] {
  const source = line.source;
  if (source && source.parts.length > 0)
    return source.parts.flatMap((p): OverlayPart[] => (p.emote && emoteUrlOk(p.url) ? [{ emote: p.emote, url: p.url }] : p.text ? [{ text: p.text }] : []));
  const text = (source ? line.text : plain(line.text)).replace(/\s+/g, ' ').trim();
  return text ? [{ text }] : [];
}

export function overlayLinesOf(lines: readonly ChatLine[], allowed: readonly ChatPlatform[], count: number, plain: (text: string) => string = (t) => t): OverlayLine[] {
  const want = Math.min(CHAT_LINES_MAX, Math.max(1, Math.floor(count)));
  const out: OverlayLine[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < want; i--) {
    const line = lines[i]!;
    if (line.pending) continue;
    const platform: ChatPick = line.source?.platform ?? 'slop';
    if (platform !== 'slop' && !allowed.includes(platform)) continue;
    const parts = partsOf(line, plain);
    if (parts.length === 0) continue;
    const color = line.source ? (line.source.color ?? NAME_COLORS.platform) : nameColor(line);
    out.push({ id: line.id, from: line.from, color, platform, parts });
  }
  return out.reverse();
}

const sameRun = (a: OverlayLine | undefined, b: OverlayLine | undefined) => !!a && !!b && a.from === b.from && a.platform === b.platform;

function pieces(line: OverlayLine, named: boolean, measure: Measure, px: number, ready: (url: string) => boolean): ChatPiece[] {
  const out: ChatPiece[] = [];
  if (named && line.platform !== 'slop') out.push({ kind: 'mark', x: 0, w: px * MARK, text: '', platform: line.platform });
  if (named) out.push({ kind: 'name', x: 0, w: measure(line.from, true), text: line.from, color: line.color });
  for (const part of line.parts) {
    if ('emote' in part) {
      out.push(
        ready(part.url)
          ? { kind: 'emote', x: 0, w: px * EMOTE, text: part.emote, url: part.url }
          : { kind: 'word', x: 0, w: measure(part.emote, false), text: part.emote }
      );
      continue;
    }
    for (const word of part.text.split(/\s+/)) if (word) out.push({ kind: 'word', x: 0, w: measure(word, false), text: word });
  }
  return out;
}

function split(piece: ChatPiece, measure: Measure, width: number): ChatPiece[] {
  if (piece.kind === 'mark' || piece.kind === 'emote' || piece.w <= width) return [piece];
  const bold = piece.kind === 'name';
  const out: ChatPiece[] = [];
  let chunk = '';
  for (const ch of piece.text) {
    if (chunk && measure(chunk + ch, bold) > width) {
      out.push({ ...piece, text: chunk, w: measure(chunk, bold) });
      chunk = ch;
    } else chunk += ch;
  }
  if (chunk) out.push({ ...piece, text: chunk, w: measure(chunk, bold) });
  return out;
}

function rowsOf(list: ChatPiece[], measure: Measure, width: number, px: number): ChatPiece[][] {
  const space = measure(' ', false);
  const rows: ChatPiece[][] = [];
  let row: ChatPiece[] = [];
  let x = 0;
  let after = 0;
  for (const whole of list) {
    for (const piece of split(whole, measure, width)) {
      const at = row.length ? x + after : 0;
      if (row.length && at + piece.w > width) {
        rows.push(row);
        row = [];
        x = 0;
        after = 0;
      }
      const start = row.length ? x + after : 0;
      row.push({ ...piece, x: start });
      x = start + piece.w;
      after = piece.kind === 'mark' ? px * MARK_GAP : space;
    }
  }
  if (row.length) rows.push(row);
  return rows;
}

const rowWidth = (row: ChatPiece[]) => (row.length ? row[row.length - 1]!.x + row[row.length - 1]!.w : 0);

function radiiOf(shape: Shape, align: TextAlign, h: number, px: number, first: boolean, last: boolean): [number, number, number, number] {
  if (shape === 'block') return [0, 0, 0, 0];
  if (shape === 'soft') {
    const r = Math.min(h / 2, px * SOFT);
    return [r, r, r, r];
  }
  const outer = Math.min(h / 2, px * OUTER);
  const join = Math.min(outer, px * JOIN);
  const top = first ? outer : join;
  const bottom = last ? outer : join;
  if (align === 'right') return [outer, top, bottom, outer];
  if (align === 'center') return [outer, outer, outer, outer];
  return [top, outer, outer, bottom];
}

export function layoutChat(measure: Measure, paint: ChatPaint, box: Box, px: number, ready: (url: string) => boolean = () => false): ChatCard[] {
  const { lines, style, shape } = paint;
  if (box.w <= 0 || box.h <= 0 || lines.length === 0) return [];
  const align = style.align ?? 'left';
  const runs = shape === 'bubble';
  const padX = Math.min(box.w / 4, px * PAD_X);
  const padY = px * PAD_Y;
  const lh = px * LEADING;
  const inner = Math.max(1, box.w - padX * 2);
  const cards: ChatCard[] = [];
  let bottom = box.y + box.h;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    const first = !runs || !sameRun(lines[i - 1], line);
    const last = !runs || !sameRun(line, lines[i + 1]);
    const rows = rowsOf(pieces(line, first, measure, px, ready), measure, inner, px);
    const h = rows.length * lh + padY * 2;
    const y = bottom - h;
    if (y < box.y - 0.5) break;
    const w = Math.min(box.w, Math.max(...rows.map(rowWidth)) + padX * 2);
    const x = align === 'right' ? box.x + box.w - w : align === 'center' ? box.x + (box.w - w) / 2 : box.x;
    cards.unshift({ id: line.id, x, y, w, h, rows, radii: radiiOf(shape, align, h, px, first, last) });
    bottom = y - px * (first ? GAP : RUN_GAP);
  }
  return cards;
}

const paths = new Map<ChatPlatform, Path2D>();

function pathOf(platform: ChatPlatform): Path2D | null {
  if (typeof Path2D === 'undefined') return null;
  let p = paths.get(platform);
  if (!p) {
    p = new Path2D(PLATFORM_PATHS[platform]);
    paths.set(platform, p);
  }
  return p;
}

export const chatFont = (px: number, bold: boolean) => `${bold ? NAME_WEIGHT : BODY_WEIGHT} ${px}px ${TEXT_FONT}`;

export function paintChat(
  ctx: CanvasRenderingContext2D,
  box: Box,
  paint: ChatPaint,
  frameHeight: number,
  emote: (url: string) => CanvasImageSource | null = () => null
) {
  if (box.w <= 0 || box.h <= 0) return;
  const { style } = paint;
  const px = Math.max(1, style.size * frameHeight);
  const fonts = [chatFont(px, false), chatFont(px, true)] as const;
  let font = '';
  const use = (bold: boolean) => {
    const f = fonts[bold ? 1 : 0];
    if (font !== f) {
      ctx.font = f;
      font = f;
    }
  };
  const measure: Measure = (s, bold) => {
    use(bold);
    return ctx.measureText(s).width;
  };
  const cards = layoutChat(measure, paint, box, px, (url) => emote(url) !== null);
  const padX = Math.min(box.w / 4, px * PAD_X);
  const padY = px * PAD_Y;
  const lh = px * LEADING;
  const outline = !style.bg;
  ctx.save();
  ctx.beginPath();
  ctx.rect(box.x, box.y, box.w, box.h);
  ctx.clip();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = px * OUTLINE;
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  for (const card of cards) {
    if (style.bg) {
      ctx.globalAlpha = CHAT_CARD_ALPHA;
      ctx.fillStyle = style.bg;
      ctx.beginPath();
      ctx.roundRect(card.x, card.y, card.w, card.h, card.radii);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    card.rows.forEach((row, r) => {
      const cy = card.y + padY + r * lh + lh / 2;
      for (const piece of row) {
        const x = card.x + padX + piece.x;
        if (piece.kind === 'mark' && piece.platform) {
          const path = pathOf(piece.platform);
          if (!path) continue;
          const s = (px * MARK) / 24;
          ctx.save();
          ctx.translate(x, cy - (px * MARK) / 2);
          ctx.scale(s, s);
          ctx.fillStyle = PLATFORM_TINTS[piece.platform];
          ctx.fill(path);
          ctx.restore();
          continue;
        }
        if (piece.kind === 'emote' && piece.url) {
          const img = emote(piece.url);
          if (img) {
            const size = px * EMOTE;
            const iw = (img as HTMLImageElement).naturalWidth || size;
            const ih = (img as HTMLImageElement).naturalHeight || size;
            const k = Math.min(size / iw, size / ih);
            ctx.drawImage(img, x + (size - iw * k) / 2, cy - (ih * k) / 2, iw * k, ih * k);
          }
          continue;
        }
        const bold = piece.kind === 'name';
        use(bold);
        if (outline) ctx.strokeText(piece.text, x, cy);
        ctx.fillStyle = piece.color ?? style.color;
        ctx.fillText(piece.text, x, cy);
      }
    });
  }
  ctx.restore();
}
