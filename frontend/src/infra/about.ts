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
