import { BLOCKS_MAX, TEXT_MAX } from './about.ts';
import type { PageWire } from './api.ts';

export type CardKey = 'stream' | 'when' | 'setup' | 'rules' | 'links' | 'faq' | 'more';
export type MediaKind = 'image' | 'video' | 'sound';

export interface CardMedia {
  key: string;
  kind: MediaKind;
  id: number;
  src: string;
}

export interface Card {
  key: CardKey;
  title: string;
  body: string;
  on: boolean;
  link: string;
  media: CardMedia[];
  ids: number[];
}

export const CARD_KEYS: readonly CardKey[] = ['stream', 'when', 'setup', 'rules', 'links', 'faq', 'more'];
export const PRESET_KEYS: readonly CardKey[] = CARD_KEYS.filter((key) => key !== 'more');
export const CARD_TITLES: Record<CardKey, string> = {
  stream: 'what i stream',
  when: "when i'm on",
  setup: 'my setup',
  rules: 'rules',
  links: 'links',
  faq: 'faq',
  more: 'more'
};

export const CARD_X = 1600;
export const SLOT = 100;
export const MEDIA_AT = 50;
export const TITLE_MAX = 40;
export const BODY_MAX = 4000;
export const LINK_MAX = 500;
const CHUNK_BYTES = TEXT_MAX - 1;

const MEDIA_KINDS: readonly string[] = ['image', 'video', 'sound'];
const HEAD = /^<h3>([^<]*)<\/h3><p>([^<]*)<\/p>(?:<blockquote>([^<]*)<\/blockquote>)?$/;
const MORE = /^<p>([^<]*)<\/p>$/;
const utf8 = new TextEncoder();

export function blankCard(key: CardKey): Card {
  return { key, title: CARD_TITLES[key], body: '', on: false, link: '', media: [], ids: [] };
}

export function cleanText(raw: string): string {
  let out = '';
  for (const ch of raw.replace(/\r\n?/g, '\n')) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch !== '\n' && ch !== '\t' && (code < 0x20 || (code >= 0x7f && code <= 0x9f))) continue;
    out += ch;
  }
  return out;
}

export function cleanTitle(raw: string): string {
  return [...cleanText(raw).replace(/[\n\t]/g, ' ')].slice(0, TITLE_MAX).join('');
}

export function titleOf(card: Card): string {
  return cleanTitle(card.title).trim() || CARD_TITLES[card.key];
}

export function cleanLink(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const full = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(full);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname || url.username || url.password) return null;
    return url.href.length <= LINK_MAX ? url.href : null;
  } catch {
    return null;
  }
}

export function cleanCard(card: Card): Card {
  return {
    ...card,
    title: titleOf(card),
    body: cleanText(card.body),
    link: cleanLink(card.link) ?? '',
    media: card.media.filter((m) => m.id > 0)
  };
}

export function isDefault(card: Card): boolean {
  const clean = cleanCard(card);
  return !clean.on && clean.body === '' && clean.link === '' && clean.media.length === 0 && clean.title === CARD_TITLES[card.key];
}

export function hasContent(card: Card): boolean {
  return card.body.trim() !== '' || !!cleanLink(card.link) || card.media.some((m) => m.id > 0 || m.src !== '');
}

export function shownCards(cards: Card[]): Card[] {
  return cards.filter((card) => card.on && hasContent(card));
}

function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function bytesOf(text: string): number {
  return utf8.encode(text).length;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(text: string): string {
  return text.replace(/&([^;&\s]{1,11});/g, (whole, body: string) => {
    const named = ENTITIES[body];
    if (named) return named;
    if (body.startsWith('#')) {
      const n = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      if (Number.isFinite(n) && n >= 0 && n <= 0x10ffff) {
        try {
          return String.fromCodePoint(n);
        } catch {
          return whole;
        }
      }
    }
    return whole;
  });
}

function splitBody(body: string, first: number, rest: number): string[] {
  const parts: string[] = [];
  let part = '';
  let used = 0;
  let room = first;
  for (const ch of body) {
    const cost = bytesOf(escapeText(ch));
    if (used + cost > room) {
      parts.push(part);
      part = '';
      used = 0;
      room = rest;
    }
    part += ch;
    used += cost;
  }
  parts.push(part);
  return parts;
}

export function cardHtml(card: Card): string[] {
  const clean = cleanCard(card);
  const head = `<h3>${escapeText(clean.title)}</h3>`;
  const tail = clean.link ? `<blockquote>${escapeText(clean.link)}</blockquote>` : '';
  const wrap = '<p></p>'.length;
  const parts = splitBody(clean.body, CHUNK_BYTES - bytesOf(head) - bytesOf(tail) - wrap, CHUNK_BYTES - wrap);
  return parts.map((part, i) => (i === 0 ? `${head}<p>${escapeText(part)}</p>${tail}` : `<p>${escapeText(part)}</p>`));
}

export function slotOf(key: CardKey): number {
  return CARD_KEYS.indexOf(key);
}

export function cardsToBlocks(cards: Card[]): PageWire[] {
  const out: PageWire[] = [];
  for (const key of CARD_KEYS) {
    const card = cards.find((c) => c.key === key);
    if (!card || isDefault(card)) continue;
    const y = slotOf(key) * SLOT;
    const z = card.on ? 1 : 0;
    cardHtml(card).forEach((html, p) => {
      out.push({ type: 'text', id: card.ids[p] ?? 0, x: CARD_X, y: y + p, z, html });
    });
    card.media
      .filter((m) => m.id > 0)
      .forEach((m, i) => {
        out.push({ type: m.kind, id: m.id, x: CARD_X, y: y + MEDIA_AT + i, z });
      });
  }
  return out;
}

export function overLimit(blocks: PageWire[]): boolean {
  return blocks.length > BLOCKS_MAX;
}

interface Tag {
  key: CardKey;
  part: number;
}

function tagOf(block: PageWire): Tag | null {
  if (block.x !== CARD_X || block.y < 0) return null;
  const key = CARD_KEYS[Math.floor(block.y / SLOT)];
  if (!key) return null;
  const part = block.y % SLOT;
  if (block.type === 'text') return part < MEDIA_AT ? { key, part } : null;
  if (MEDIA_KINDS.includes(block.type)) return part >= MEDIA_AT ? { key, part } : null;
  return null;
}

export function htmlToText(html: string): string {
  let out = '';
  const lists: { ordered: boolean; n: number }[] = [];
  const links: { href: string; at: number }[] = [];
  const lineStart = () => {
    if (out && !out.endsWith('\n')) out += '\n';
  };
  const token = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*)>|([^<]+)|</g;
  for (const m of html.matchAll(token)) {
    const [whole, close, rawName, attrs, text] = m;
    if (text !== undefined) {
      out += decodeEntities(text);
      continue;
    }
    if (!rawName) {
      out += whole;
      continue;
    }
    const name = rawName.toLowerCase();
    if (name === 'br') {
      out += '\n';
    } else if (name === 'p' || name === 'div' || name === 'h2' || name === 'h3' || name === 'blockquote') {
      if (close) out += '\n';
      else lineStart();
    } else if (name === 'ul' || name === 'ol') {
      if (close) {
        lists.pop();
        lineStart();
      } else {
        lineStart();
        lists.push({ ordered: name === 'ol', n: 0 });
      }
    } else if (name === 'li') {
      if (close) {
        lineStart();
      } else {
        lineStart();
        const list = lists[lists.length - 1];
        if (list) list.n += 1;
        out += list?.ordered ? `${list.n}. ` : '- ';
      }
    } else if (name === 'a') {
      if (close) {
        const link = links.pop();
        if (link?.href) {
          const label = out.slice(link.at).trim();
          if (!label) out += link.href;
          else if (!label.includes(link.href)) out += ` (${link.href})`;
        }
      } else {
        const href = /href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs ?? '');
        links.push({ href: decodeEntities(href?.[1] ?? href?.[2] ?? href?.[3] ?? '').trim(), at: out.length });
      }
    }
  }
  return cleanText(out)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function mediaOf(block: PageWire): CardMedia {
  return { key: `m${block.id}`, kind: block.type as MediaKind, id: block.id, src: block.src ?? '' };
}

function readText(blocks: PageWire[], card: Card): void {
  blocks.forEach((block, i) => {
    const html = block.html ?? '';
    const head = i === 0 ? HEAD.exec(html) : null;
    const more = i > 0 ? MORE.exec(html) : null;
    if (head) {
      card.title = cleanTitle(decodeEntities(head[1] ?? '')).trim() || CARD_TITLES[card.key];
      card.body += decodeEntities(head[2] ?? '');
      card.link = cleanLink(decodeEntities(head[3] ?? '')) ?? '';
    } else if (more) {
      card.body += decodeEntities(more[1] ?? '');
    } else {
      const text = htmlToText(html);
      if (text) card.body = card.body ? `${card.body}\n\n${text}` : text;
    }
    card.ids.push(block.id);
  });
  card.body = cleanText(card.body);
}

export function blocksToCards(blocks: PageWire[]): Card[] {
  const texts = new Map<CardKey, { part: number; block: PageWire }[]>();
  const media = new Map<CardKey, { part: number; block: PageWire }[]>();
  const legacy: PageWire[] = [];
  for (const block of blocks) {
    const tag = tagOf(block);
    if (!tag) {
      legacy.push(block);
      continue;
    }
    const into = block.type === 'text' ? texts : media;
    const list = into.get(tag.key) ?? [];
    list.push({ part: tag.part, block });
    into.set(tag.key, list);
  }
  const cards = CARD_KEYS.map((key) => {
    const card = blankCard(key);
    const words = (texts.get(key) ?? []).sort((a, b) => a.part - b.part).map((t) => t.block);
    const files = (media.get(key) ?? []).sort((a, b) => a.part - b.part).map((t) => t.block);
    const first = words[0] ?? files[0];
    if (first) card.on = first.z > 0;
    readText(words, card);
    card.media = files.filter((b) => b.id > 0).map(mediaOf);
    return card;
  });
  const more = cards.find((c) => c.key === 'more');
  const old = legacy.filter((b) => b.type === 'text' || MEDIA_KINDS.includes(b.type)).sort((a, b) => a.y - b.y || a.x - b.x || a.z - b.z);
  if (more && old.length > 0) {
    const words = old.filter((b) => b.type === 'text').map((b) => htmlToText(b.html ?? '')).filter(Boolean);
    const files = old.filter((b) => b.type !== 'text' && b.id > 0).map(mediaOf);
    if (words.length > 0 || files.length > 0) {
      more.on = true;
      more.body = [more.body, ...words].filter(Boolean).join('\n\n');
      more.media = [...more.media, ...files];
    }
  }
  return cards.filter((card) => card.key !== 'more' || !isDefault(card));
}

export function withSavedIds(cards: Card[], saved: PageWire[]): Card[] {
  const ids = new Map<CardKey, { part: number; id: number }[]>();
  for (const block of saved) {
    const tag = tagOf(block);
    if (!tag || block.type !== 'text') continue;
    const list = ids.get(tag.key) ?? [];
    list.push({ part: tag.part, id: block.id });
    ids.set(tag.key, list);
  }
  return cards.map((card) => ({ ...card, ids: (ids.get(card.key) ?? []).sort((a, b) => a.part - b.part).map((t) => t.id) }));
}
