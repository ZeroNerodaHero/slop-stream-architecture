export interface LinkEmbedImage {
  id: string;
  width: number;
  height: number;
}

export interface LinkEmbed {
  url: string;
  site?: string;
  title?: string;
  description?: string;
  image?: LinkEmbedImage;
  color?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLOR = /^#[0-9a-f]{6}$/i;
const MAX_SIDE = 10_000;
const LINK = /(^|[^\p{L}\p{N}])(https?:\/\/[^\s、。，．！？：；…—“”（）「」『』【】《》〈〉［］｛｝]+)/giu;
const TRAIL = /[.,;:!?'"»”’]+$/;
const BRACKETS: readonly (readonly [open: string, close: string])[] = [
  ['(', ')'],
  ['[', ']'],
  ['{', '}'],
  ['<', '>']
];

function text(raw: unknown, max: number): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const t = raw.trim();
  return t ? t.slice(0, max) : undefined;
}

function side(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isInteger(raw) && raw > 0 && raw <= MAX_SIDE ? raw : null;
}

function webUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

function imageOf(raw: unknown): LinkEmbedImage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const { id, width, height } = raw as { id?: unknown; width?: unknown; height?: unknown };
  const w = side(width);
  const h = side(height);
  if (typeof id !== 'string' || !UUID.test(id) || w === null || h === null) return undefined;
  return { id, width: w, height: h };
}

export function linkEmbedOf(raw: unknown): LinkEmbed | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const url = webUrl(r.url);
  if (!url) return null;
  const title = text(r.title, 200);
  const description = text(r.description, 500);
  if (!title && !description) return null;
  const site = text(r.site, 80);
  const image = imageOf(r.image);
  const color = typeof r.color === 'string' && COLOR.test(r.color) ? r.color.toLowerCase() : undefined;
  return {
    url,
    ...(site ? { site } : {}),
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(image ? { image } : {}),
    ...(color ? { color } : {})
  };
}

export function embedImageSrc(image: LinkEmbedImage): string {
  return `/api/chat-images/${encodeURIComponent(image.id)}`;
}

function count(s: string, c: string): number {
  let n = 0;
  for (const ch of s) if (ch === c) n += 1;
  return n;
}

function trimLink(raw: string): string {
  let link = raw;
  for (;;) {
    const before = link;
    link = link.replace(TRAIL, '');
    for (const [open, close] of BRACKETS) {
      if (link.endsWith(close) && count(link, open) < count(link, close)) link = link.slice(0, -1);
    }
    if (link === before) return link;
  }
}

export function firstLink(text: string): string | null {
  for (const m of text.matchAll(LINK)) {
    const href = webUrl(trimLink(m[2] ?? ''));
    if (href && new URL(href).hostname) return href;
  }
  return null;
}
