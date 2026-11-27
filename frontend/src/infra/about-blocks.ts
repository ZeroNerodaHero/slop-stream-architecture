import type { Socials } from './socials.ts';

export const BLOCK_KINDS = ['heading', 'text', 'panel', 'image', 'gallery', 'buttons', 'socials', 'schedule', 'clip', 'sound', 'stats', 'quote', 'divider'] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];
export const PHONES = ['full', 'half', 'hide'] as const;
export type Phone = (typeof PHONES)[number];
export const FILLS = ['none', 'card', 'accent', 'image'] as const;
export type Fill = (typeof FILLS)[number];
export const FONTS = ['geist', 'mono', 'serif', 'display'] as const;
export type Font = (typeof FONTS)[number];
export const ALIGNS = ['left', 'center', 'right'] as const;
export type Align = (typeof ALIGNS)[number];
export const ACCENTS = ['', '#5b3ea6', '#1fa58c', '#c4772b', '#c43b5c', '#4f8bff'] as const;
export type FileKind = 'image' | 'video' | 'sound';

export const GRID = 12;
export const SPAN_MIN = 3;
export const SPAN_MAX = 12;
export const SPAN_CHOICES: readonly number[] = [3, 4, 6, 8, 12];
export const BLOCKS_MAX = 60;
export const TITLE_MAX = 80;
export const SUB_MAX = 160;
export const LABEL_MAX = 40;
export const MD_MAX = 10_000;
export const ITEMS_MAX = 12;
export const LINK_MAX = 500;

export interface BlockItem {
  file: number;
  label: string;
  href: string;
}

export interface AboutBlock {
  id: string;
  kind: BlockKind;
  span: number;
  phone: Phone;
  fill: Fill;
  accent: string;
  font: Font;
  align: Align;
  href: string;
  title: string;
  sub: string;
  md: string;
  file: number;
  bg: number;
  label: string;
  link: string;
  socials: boolean;
  items: BlockItem[];
  html?: string;
}

export interface AboutPage {
  blocks: AboutBlock[];
  followers: number;
  streams: number;
  joined: string | null;
  avatar: number | null;
  socials: Socials;
  changed?: boolean;
}

export interface Wants {
  title?: boolean;
  sub?: boolean;
  md?: boolean;
  href?: boolean;
  button?: boolean;
  items?: boolean;
  file?: FileKind;
}

export const WANTS: Record<BlockKind, Wants> = {
  heading: { title: true, sub: true, href: true },
  text: { md: true, href: true },
  panel: { title: true, md: true, href: true, button: true, file: 'image' },
  image: { title: true, href: true, file: 'image' },
  gallery: { items: true },
  buttons: { items: true },
  socials: { title: true },
  schedule: { title: true, md: true },
  clip: { title: true, file: 'video' },
  sound: { title: true, file: 'sound' },
  stats: {},
  quote: { md: true, sub: true },
  divider: { title: true }
};

export const FONT_WORD: Record<Font, string> = { geist: 'geist', mono: 'geist mono', serif: 'serif', display: 'display' };

export function defaultSpan(kind: BlockKind): number {
  if (kind === 'heading' || kind === 'gallery' || kind === 'divider') return 12;
  if (kind === 'buttons' || kind === 'socials' || kind === 'schedule' || kind === 'sound' || kind === 'stats') return 4;
  return 6;
}

export function defaultFill(kind: BlockKind): Fill {
  if (kind === 'heading') return 'accent';
  if (kind === 'image' || kind === 'gallery' || kind === 'buttons' || kind === 'divider' || kind === 'clip') return 'none';
  return 'card';
}

export function newId(): string {
  let id = 'b';
  while (id.length < 11) id += Math.floor(Math.random() * 36).toString(36);
  return id;
}

export function blankBlock(kind: BlockKind, over: Partial<AboutBlock> = {}): AboutBlock {
  return {
    id: newId(),
    kind,
    span: defaultSpan(kind),
    phone: 'full',
    fill: defaultFill(kind),
    accent: '',
    font: 'geist',
    align: 'left',
    href: '',
    title: '',
    sub: '',
    md: '',
    file: 0,
    bg: 0,
    label: '',
    link: '',
    socials: false,
    items: [],
    ...over
  };
}

export function starterBlock(kind: BlockKind): AboutBlock {
  switch (kind) {
    case 'heading':
      return blankBlock(kind, { title: 'my page', sub: 'what i do · when i stream' });
    case 'text':
      return blankBlock(kind, { md: '### hi\na few words about you.' });
    case 'panel':
      return blankBlock(kind, { title: 'panel', md: 'what this panel is about.' });
    case 'buttons':
      return blankBlock(kind, { items: [{ file: 0, label: 'my link', href: '' }] });
    case 'gallery':
      return blankBlock(kind, { items: [] });
    case 'schedule':
      return blankBlock(kind, { title: "when i'm on" });
    case 'quote':
      return blankBlock(kind, { md: 'something someone said.', sub: 'someone' });
    case 'stats':
      return blankBlock(kind, { socials: true });
    default:
      return blankBlock(kind);
  }
}

export function httpUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > LINK_MAX) return null;
  try {
    const url = new URL(trimmed);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname || url.username || url.password) return null;
    return url.href.length <= LINK_MAX ? url.href : null;
  } catch {
    return null;
  }
}

export function cleanLink(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  return httpUrl(/^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`);
}

export function wireBlock(b: AboutBlock): AboutBlock {
  const { html: _html, ...rest } = b;
  return {
    ...rest,
    href: cleanLink(b.href) ?? '',
    link: cleanLink(b.link) ?? '',
    items: b.items.slice(0, ITEMS_MAX).map((item) => ({ ...item, href: cleanLink(item.href) ?? '' }))
  };
}

export function spanOptions(span: number): number[] {
  return SPAN_CHOICES.includes(span) ? [...SPAN_CHOICES] : [...SPAN_CHOICES, span].sort((a, b) => a - b);
}

export function clampSpan(n: number): number {
  return Math.min(SPAN_MAX, Math.max(SPAN_MIN, Math.round(n)));
}

export function phoneColumns(phone: Phone): number {
  return phone === 'full' ? 2 : phone === 'half' ? 1 : 0;
}

export function fileSrc(name: string, id: number): string {
  return `/api/streamers/${encodeURIComponent(name)}/about-file/${id}`;
}

export function filesOf(blocks: readonly AboutBlock[]): number[] {
  return blocks.flatMap((b) => [b.file, b.bg, ...b.items.map((i) => i.file)]).filter((id) => id > 0);
}

export function compactCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(Math.floor(n / 100) / 10).toString()}K`;
  if (n < 1_000_000) return `${Math.floor(n / 1000)}K`;
  return `${(Math.floor(n / 100_000) / 10).toString()}M`;
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

export function joinedWord(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${MONTHS[d.getMonth()]} '${String(d.getFullYear() % 100).padStart(2, '0')}`;
}

export const WEEKDAYS = ['mo', 'tu', 'we', 'th', 'fr', 'sa', 'su'] as const;

export function weekdaysOf(starts: readonly string[]): boolean[] {
  const on = WEEKDAYS.map(() => false);
  for (const iso of starts) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) continue;
    on[(d.getDay() + 6) % 7] = true;
  }
  return on;
}

function escapeText(c: string): string {
  if (c === '&') return '&amp;';
  if (c === '<') return '&lt;';
  if (c === '>') return '&gt;';
  if (c === '"') return '&quot;';
  return c;
}

function escapeAll(s: string): string {
  let out = '';
  for (const c of s) out += escapeText(c);
  return out;
}

const PUNCT = '\\`*_{}[]()#+-.!~>|<&"\'';

function findClose(s: string, from: number, mark: string): number {
  let i = from;
  while (i < s.length) {
    if (s[i] === '\\') {
      i += 2;
      continue;
    }
    if (s.startsWith(mark, i)) {
      if (mark.length === 1 && s.startsWith(mark, i + 1)) {
        i += 2;
        continue;
      }
      return i;
    }
    i += 1;
  }
  return -1;
}

const WORD = /[\p{L}\p{N}]/u;
const isWord = (c: string | undefined) => c !== undefined && WORD.test(c);

const MARKS: readonly [string, string][] = [
  ['**', 'strong'],
  ['__', 'u'],
  ['~~', 's'],
  ['*', 'em'],
  ['_', 'em']
];

function emphasis(s: string, i: number, links: boolean): [string, number] | null {
  for (const [mark, tag] of MARKS) {
    if (!s.startsWith(mark, i)) continue;
    if (mark.length === 1 && s.startsWith(mark, i + 1)) continue;
    const start = i + mark.length;
    if (mark === '_' && isWord(s[i - 1])) return null;
    const end = findClose(s, start, mark);
    if (end < 0) return null;
    const inner = s.slice(start, end);
    if (!inner || /^\s/u.test(inner) || /\s$/u.test(inner)) return null;
    const after = end + mark.length;
    if (mark === '_' && isWord(s[after])) return null;
    return [`<${tag}>${inline(inner, links)}</${tag}>`, after];
  }
  return null;
}

function bracketLink(s: string, i: number, links: boolean): [string, number] | null {
  const close = findClose(s, i + 1, ']');
  if (close < 0 || s[close + 1] !== '(') return null;
  const end = s.indexOf(')', close + 1);
  if (end < 0) return null;
  const target = s.slice(close + 2, end).trim();
  const label = inline(s.slice(i + 1, close), false);
  const href = links ? httpUrl(target) : null;
  if (!href) return [label, end + 1];
  return [`<a href="${escapeAll(href)}">${label || escapeAll(href)}</a>`, end + 1];
}

function bareLink(s: string, i: number): [string, number] | null {
  const rest = s.slice(i);
  if (!rest.startsWith('https://') && !rest.startsWith('http://')) return null;
  if (isWord(s[i - 1])) return null;
  let end = rest.search(/[\s<>"]/u);
  if (end < 0) end = rest.length;
  while (end > 0 && ".,;:!?)'*_~".includes(rest[end - 1] ?? '')) end -= 1;
  const href = httpUrl(rest.slice(0, end));
  if (!href) return null;
  return [`<a href="${escapeAll(href)}">${escapeAll(rest.slice(0, end))}</a>`, i + end];
}

export function inline(s: string, links = true): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i] ?? '';
    if (c === '\\' && i + 1 < s.length && PUNCT.includes(s[i + 1] ?? '')) {
      out += escapeText(s[i + 1] ?? '');
      i += 2;
      continue;
    }
    const hit = c === '[' ? bracketLink(s, i, links) : c === '*' || c === '_' || c === '~' ? emphasis(s, i, links) : links && c === 'h' ? bareLink(s, i) : null;
    if (hit) {
      out += hit[0];
      i = hit[1];
      continue;
    }
    out += escapeText(c);
    i += 1;
  }
  return out;
}

type Open = { kind: 'p' | 'blockquote'; lines: string[] } | { kind: 'ul' | 'ol'; lines: string[] } | null;

function closeOpen(open: Open): string {
  if (!open) return '';
  if (open.kind === 'p') return `<p>${open.lines.join('<br>')}</p>`;
  if (open.kind === 'blockquote') return `<blockquote>${open.lines.join('<br>')}</blockquote>`;
  return `<${open.kind}>${open.lines.map((l) => `<li>${l}</li>`).join('')}</${open.kind}>`;
}

export function markdownToHtml(md: string): string {
  if (!md.trim()) return '';
  let out = '';
  let open: Open = null;
  const push = (kind: 'p' | 'blockquote' | 'ul' | 'ol', line: string) => {
    const cur: Open = open;
    if (cur && cur.kind === kind) {
      cur.lines.push(line);
      return;
    }
    out += closeOpen(cur);
    open = { kind, lines: [line] };
  };
  for (const raw of md.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line) {
      out += closeOpen(open);
      open = null;
      continue;
    }
    const head = /^(#{1,6}) +(.*)$/.exec(line);
    if (head && head[2]?.trim()) {
      out += closeOpen(open);
      open = null;
      const tag = (head[1] ?? '').length <= 2 ? 'h2' : 'h3';
      out += `<${tag}>${inline(head[2].trim())}</${tag}>`;
      continue;
    }
    const quote = /^> ?(.*)$/.exec(line);
    if (quote && quote[1]?.trim()) {
      push('blockquote', inline(quote[1].trim()));
      continue;
    }
    const bullet = /^[-*+] (.*)$/.exec(line);
    if (bullet && bullet[1]?.trim()) {
      push('ul', inline(bullet[1].trim()));
      continue;
    }
    const numbered = /^\d{1,3}[.)] (.*)$/.exec(line);
    if (numbered && numbered[1]?.trim()) {
      push('ol', inline(numbered[1].trim()));
      continue;
    }
    push('p', inline(line));
  }
  return out + closeOpen(open);
}

export function moved<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  if (from < 0 || from >= next.length) return next;
  const [item] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(next.length, to)), 0, item as T);
  return next;
}

export function isBlank(b: AboutBlock, socials: number): boolean {
  switch (b.kind) {
    case 'text':
    case 'quote':
      return !b.md.trim();
    case 'image':
    case 'clip':
    case 'sound':
      return b.file === 0;
    case 'gallery':
      return b.items.length === 0;
    case 'buttons':
      return !b.items.some((i) => i.label.trim());
    case 'socials':
      return socials === 0;
    case 'panel':
      return !b.title.trim() && !b.md.trim() && b.file === 0 && !b.label.trim();
    default:
      return false;
  }
}

export function kindWord(kind: BlockKind): string {
  return kind === 'buttons' ? 'links' : kind;
}

export function blockWord(b: AboutBlock): string {
  const first =
    b.md
      .split('\n')
      .find((l) => l.trim())
      ?.replace(/^[#>*\-+\d.)\s]+/, '')
      .replace(/[*_~[\]]/g, '') ?? '';
  const word = b.title || first || b.items.find((i) => i.label)?.label || '';
  return word ? `${kindWord(b.kind)} · ${word.slice(0, 40)}` : kindWord(b.kind);
}
