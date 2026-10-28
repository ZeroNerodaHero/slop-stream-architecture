/**
 * The about tab's document (docs/about.md), and the rules that keep it a page of boxes and
 * nothing else. A person's page is blocks of fixed kinds that react draws (never html from a
 * string), with pictures, a clip and tracks from this origin's own paths, links that are http(s),
 * and css of their own over it all. The css is the part that could go wrong, so it goes through
 * the browser's own parser first and only what is left is written: style rules and `@media` /
 * `@supports`, every selector scoped under the box, and no declaration that could load a thing,
 * run a thing, or leave the box. Scripts have no door: there is no block that takes one.
 */

import { api } from '@/infra/api';

export type AboutBlock =
  | { kind: 'heading'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'image'; src: string; alt: string; caption?: string }
  | { kind: 'gallery'; images: { src: string; alt: string }[] }
  | { kind: 'video'; src: string; poster?: string; caption?: string }
  | { kind: 'music'; title?: string; tracks: { title: string; src: string }[] }
  | { kind: 'links'; links: { label: string; href: string }[] }
  | { kind: 'divider' };

export interface AboutDoc {
  blocks: AboutBlock[];
  /** Their css, as typed. Never written to the page as it is: `safeCss` first. */
  css: string;
}

/** Where a block's picture, clip or track may come from: paths on this origin, and only these. */
const MEDIA_PREFIXES = ['/api/streamers/', '/thumb/', '/about-demo/'];

/**
 * A media path, or null for anything else: a scheme (`https:`, `data:`, `javascript:`), a
 * protocol-relative `//host`, a backslash, a walk up, whitespace or control characters, a
 * path outside the prefixes above. What passes is a same-origin url the browser fetches like
 * any other picture on the page, with the viewer's cookies and nothing of the viewer leaving.
 */
export function mediaPath(src: unknown): string | null {
  if (typeof src !== 'string' || src.length === 0 || src.length > 500) return null;
  if (!/^\/[\x21-\x7e]*$/.test(src) || src.startsWith('//') || src.includes('\\') || src.includes('..')) return null;
  return MEDIA_PREFIXES.some((p) => src.startsWith(p)) ? src : null;
}

/** A link target, or null: only http and https, absolute or on this origin. `javascript:`, `data:`, `blob:` and the rest are null. */
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

/** The same origin as the page: a router link, not a new tab. */
export function isSameOrigin(href: string): boolean {
  try {
    return new URL(href, location.origin).origin === location.origin;
  } catch {
    return false;
  }
}

export const CSS_MAX = 20_000;
const RULE_MAX = 400;
const DECL_MAX = 2000;
const SELECTOR_MAX = 300;

/**
 * A value (or a condition) that could load, run, or read as markup, so its declaration goes:
 * anything with `url` in it (`url(…)`, `attr(x url)`), `image-set`, `image()`, `src()`,
 * `element()`, `cross-fade()`, a paint worklet, old `expression()`, `javascript:`, an
 * `@import`, a backslash escape (the parser has already decoded the legitimate ones, so one
 * that is still there is spelling something) and a closing tag.
 */
const BAD_VALUE = /url|image-set|image\s*\(|src\s*\(|element\s*\(|cross-fade|paint\s*\(|expression\s*\(|javascript:|@import|\\|<\//i;
/** Properties that bound script or behaviour in old engines. Gone whatever the value. */
const BAD_PROPERTY = /binding|behavior/i;

export interface SafeCss {
  /** What may be written into a `<style>` inside the box. '' for nothing. */
  css: string;
  /** Declarations written. */
  kept: number;
  /** Declarations and rules that were refused. */
  dropped: number;
}

interface Budget {
  rules: number;
  decls: number;
  kept: number;
  dropped: number;
}

/**
 * Parsed by the browser, nothing fetched: a constructed stylesheet is not attached to any
 * document, and `@import` is ignored in one. Where constructed sheets do not exist, a detached
 * document parses it, and a sheet with any at-rule at all is refused rather than reasoned about.
 */
function parse(css: string): CSSRuleList | null {
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    return sheet.cssRules;
  } catch {
    // an older browser, or a sheet the constructor refused
  }
  if (css.includes('@')) return null;
  try {
    const doc = document.implementation.createHTMLDocument('');
    const style = doc.createElement('style');
    style.textContent = css;
    doc.head.appendChild(style);
    return style.sheet?.cssRules ?? null;
  } catch {
    return null;
  }
}

/** A selector list at its top-level commas: inside `(…)`, `[…]` and quotes a comma is part of the selector. */
export function splitSelectors(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? '';
    if (quote) {
      cur += ch;
      if (ch === '\\' && i + 1 < text.length) cur += text[++i];
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Every selector of the list under the box: `#scope <selector>`. The subject of each is then a descendant of the box, whatever it says. */
function scopeSelectors(selectorText: string, scope: string, budget: Budget): string[] {
  const parts = splitSelectors(selectorText);
  const kept: string[] = [];
  for (const part of parts) {
    if (part.length > SELECTOR_MAX || part.includes('\\') || part.includes('{') || part.includes('}')) {
      budget.dropped++;
      continue;
    }
    kept.push(`#${scope} ${part}`);
  }
  return kept;
}

function declarationsOf(style: CSSStyleDeclaration, budget: Budget): string[] {
  const decls: string[] = [];
  for (let i = 0; i < style.length; i++) {
    if (budget.decls >= DECL_MAX) break;
    const name = style[i] ?? '';
    let value = style.getPropertyValue(name);
    if (!name || !value) continue;
    if (BAD_PROPERTY.test(name) || BAD_VALUE.test(name) || BAD_VALUE.test(value)) {
      budget.dropped++;
      continue;
    }
    // the box is the containing block for a fixed descendant anyway (`contain: layout paint`);
    // this keeps the intent and loses the word
    if (name === 'position' && /fixed/i.test(value)) value = 'absolute';
    const priority = style.getPropertyPriority(name);
    budget.decls++;
    budget.kept++;
    decls.push(`${name}: ${value}${priority ? ' !important' : ''}`);
  }
  return decls;
}

function emit(rule: CSSRule, scope: string, out: string[], budget: Budget): void {
  if (budget.rules >= RULE_MAX) {
    budget.dropped++;
    return;
  }
  if (rule instanceof CSSStyleRule) {
    budget.rules++;
    const selectors = scopeSelectors(rule.selectorText, scope, budget);
    if (selectors.length === 0) return;
    const decls = declarationsOf(rule.style, budget);
    if (decls.length === 0) return;
    out.push(`${selectors.join(', ')} { ${decls.join('; ')} }`);
    return;
  }
  const supports = typeof CSSSupportsRule !== 'undefined' && rule instanceof CSSSupportsRule;
  if (rule instanceof CSSMediaRule || supports) {
    budget.rules++;
    const condition = (rule as CSSConditionRule).conditionText;
    if (condition.length > SELECTOR_MAX || BAD_VALUE.test(condition) || condition.includes('{') || condition.includes('}')) {
      budget.dropped++;
      return;
    }
    const inner: string[] = [];
    for (const r of Array.from((rule as CSSGroupingRule).cssRules)) emit(r, scope, inner, budget);
    if (inner.length > 0) out.push(`@${supports ? 'supports' : 'media'} ${condition} {\n${inner.join('\n')}\n}`);
    return;
  }
  // everything else: @import, @font-face, @keyframes, @namespace, @page, @property, @layer,
  // @container, a rule nested in a rule. none of it is needed to colour a box
  budget.dropped++;
}

/**
 * Their css, as the page may wear it: parsed, kept to style rules and `@media` / `@supports`,
 * every selector under `#scope`, declarations that load or run or escape taken out, the rest
 * written back from the parsed form (not from their text) with its `!important`s. Capped at
 * CSS_MAX characters, 400 rules, 2000 declarations.
 */
export function safeCss(css: string, scope: string): SafeCss {
  const budget: Budget = { rules: 0, decls: 0, kept: 0, dropped: 0 };
  if (!css.trim()) return { css: '', kept: 0, dropped: 0 };
  if (css.length > CSS_MAX || !/^[a-z][a-z0-9_-]*$/i.test(scope)) return { css: '', kept: 0, dropped: 1 };
  const rules = parse(css);
  if (!rules) return { css: '', kept: 0, dropped: 1 };
  const out: string[] = [];
  for (const rule of Array.from(rules)) emit(rule, scope, out, budget);
  return { css: out.join('\n'), kept: budget.kept, dropped: budget.dropped };
}

/** The css the sample wears, and the box the editor starts with. Legitimate styling of the blocks' own classes. */
export const DEMO_CSS = `/* your css goes over the blocks. selectors stay inside the box;
   anything that loads, runs or leaves it is dropped. */
.about-heading { font-size: 1.5em; letter-spacing: -0.01em; }
.about-text { color: rgb(154 163 178); }
.about-image img, .about-video video { border-color: rgb(79 139 255); }
.about-music { border-color: rgb(79 139 255); }
.about-music-track[aria-current="true"] { color: rgb(79 139 255); }
.about-links a:hover { color: rgb(79 139 255); text-decoration: underline; }
@media (max-width: 640px) {
  .about-heading { font-size: 1.25em; }
}`;

/**
 * A sample document for `name`'s tab until the editor exists: what each kind of block looks
 * like, with the person's own pictures where they have put some (the offline picture, the home
 * card's) and the demo media under /about-demo/ otherwise. Nothing of it is saved anywhere.
 */
export function demoAbout(name: string, pictures: { offline: number | null; thumbs: number[] }): AboutDoc {
  const blocks: AboutBlock[] = [
    { kind: 'heading', text: `about ${name}` },
    {
      kind: 'text',
      text: "a page of your own under the player: words, pictures, a clip, a few tracks, links, and your css over all of it. the blocks are the site's; the look is yours."
    },
    pictures.offline !== null
      ? { kind: 'image', src: api.offlineUrl(name, pictures.offline), alt: `${name}'s offline picture`, caption: 'the offline picture, as a block' }
      : { kind: 'image', src: '/about-demo/banner.jpg', alt: 'a sample banner', caption: 'a picture block. yours would be your own upload' },
    { kind: 'video', src: '/about-demo/clip.mp4', poster: '/about-demo/poster.jpg', caption: 'a clip block. a highlight, a trailer, whatever you keep' },
    {
      kind: 'music',
      title: 'on repeat',
      tracks: [
        { title: 'first light', src: '/about-demo/track-1.mp3' },
        { title: 'late set', src: '/about-demo/track-2.mp3' }
      ]
    }
  ];
  if (pictures.thumbs.length > 0) {
    blocks.push({ kind: 'gallery', images: pictures.thumbs.slice(0, 6).map((id) => ({ src: api.streamThumbUrl(name, id), alt: `${name}'s card picture` })) });
  }
  blocks.push({ kind: 'divider' });
  blocks.push({
    kind: 'links',
    links: [
      { label: 'home', href: '/' },
      { label: 'groups', href: '/groups' },
      { label: `/watch/${name}`, href: `/watch/${name}` }
    ]
  });
  return { blocks, css: DEMO_CSS };
}
