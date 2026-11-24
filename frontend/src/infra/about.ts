import { api } from '@/infra/api';

export type AboutBlock =
  | { kind: 'text'; text: string }
  | { kind: 'image'; src: string }
  | { kind: 'video'; src: string; poster?: string }
  | { kind: 'music'; tracks: { src: string }[] };

export interface AboutDoc {
  blocks: AboutBlock[];
}

export function linkHref(href: unknown): string | null {
  if (typeof href !== 'string' || href.length === 0 || href.length > 2000) return null;
  let url: URL;
  try {
    url = new URL(href, location.origin);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  return url.href;
}

export function isSameOrigin(href: string): boolean {
  try {
    return new URL(href, location.origin).origin === location.origin;
  } catch {
    return false;
  }
}

function fnv(name: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const DUMMY_WHO = [
  'night streams from a small room. the lamp does most of the work.',
  'the cat is the co-host. i am the one who talks.',
  'here for the chat, and whatever was already open.',
  'one desk, a microphone that mostly behaves, and a long one.'
];
const DUMMY_STREAM = [
  'retro games, then a tangent, then the game again.',
  'a cozy nothing. lo-fi, long silences, the plant in the corner.',
  'building a thing live. it has been almost done for a while.',
  'music i made, played badly, then talked over.'
];
const DUMMY_WHEN = [
  'weeknights after 10. sundays if the coffee works.',
  'late. later than i said.',
  'no set time. the title says when.',
  'saturday long, tuesday short.'
];

export function dummyPage(name: string, pictures: { offline: number | null }): AboutDoc {
  const h = fnv(name);
  const who = DUMMY_WHO[h % DUMMY_WHO.length] ?? DUMMY_WHO[0];
  const stream = DUMMY_STREAM[(h >>> 4) % DUMMY_STREAM.length] ?? DUMMY_STREAM[0];
  const when = DUMMY_WHEN[(h >>> 8) % DUMMY_WHEN.length] ?? DUMMY_WHEN[0];
  return {
    blocks: [
      { kind: 'text', text: `${who}\n\n${stream}\n\n${when}` },
      { kind: 'image', src: pictures.offline !== null ? api.offlineUrl(name, pictures.offline) : '/about-demo/banner.jpg' },
      { kind: 'video', src: '/about-demo/clip.mp4', poster: '/about-demo/poster.jpg' },
      { kind: 'music', tracks: [{ src: '/about-demo/track-1.mp3' }, { src: '/about-demo/track-2.mp3' }] }
    ]
  };
}

export const TEXT_MAX = 10_000;
export const BLOCKS_MAX = 40;

const PAGE_TAGS = new Set(['p', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'a', 'ul', 'ol', 'li', 'h2', 'h3', 'blockquote']);
const PAGE_DROP = new Set([
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'svg',
  'math',
  'noscript',
  'template',
  'textarea',
  'title',
  'head',
  'link',
  'meta',
  'base',
  'form'
]);

function pageUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 500) return null;
  try {
    const url = new URL(trimmed);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return null;
    return url.href.length <= 500 ? url.href : null;
  } catch {
    return null;
  }
}

function escapeText(text: string, budget: { n: number }): string {
  let out = '';
  for (const ch of text) {
    if (budget.n <= 0) return out;
    if (ch === '\u0000' || (ch < ' ' && ch !== '\n' && ch !== '\t')) continue;
    budget.n -= 1;
    if (ch === '<') out += '&lt;';
    else if (ch === '>') out += '&gt;';
    else if (ch === '&') out += '&amp;';
    else out += ch;
  }
  return out;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function renderPageNode(node: Node, budget: { n: number }): string {
  if (budget.n <= 0) return '';
  if (node.nodeType === Node.TEXT_NODE) return escapeText(node.textContent ?? '', budget);
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const el = node as Element;
  const name = el.tagName.toLowerCase();
  if (PAGE_DROP.has(name)) return '';
  const kids = () => [...el.childNodes].map((child) => renderPageNode(child, budget)).join('');
  if (name === 'br') return '<br>';
  if (name === 'a') {
    const href = pageUrl(el.getAttribute('href') ?? '');
    const inner = kids();
    return href ? `<a href="${escapeAttr(href)}">${inner}</a>` : inner;
  }
  const tag = name === 'div' ? 'p' : name;
  if (!PAGE_TAGS.has(tag)) return kids();
  return `<${tag}>${kids()}</${tag}>`;
}

export function sanitizeHtml(raw: string): string {
  if (!raw) return '';
  const doc = new DOMParser().parseFromString(raw, 'text/html');
  const budget = { n: TEXT_MAX };
  return [...doc.body.childNodes].map((node) => renderPageNode(node, budget)).join('');
}
