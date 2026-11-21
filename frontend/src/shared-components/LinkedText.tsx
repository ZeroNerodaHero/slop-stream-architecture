import { Fragment } from 'react';
import { Link } from 'react-router-dom';

import { isSameOrigin, linkHref } from '@/infra/about';
import { onlyEmotes, splitEmotes, useEmotes } from '@/infra/emotes';
import { Emote } from '@/shared-components/Emote';
import { ExternalLink, siteOf } from '@/shared-components/ExternalLink';

/**
 * A link in talk: `http(s)://…` or `www.…` at the start of a word, up to the next space or the
 * first mark of CJK punctuation, which Chinese and Japanese put no space after: `、。，．！？：；`
 * (U+3001-3002, U+FF0C, U+FF0E, U+FF01, U+FF1F, U+FF1A-1B), `…—“”` (U+2026, U+2014, U+201C-D)
 * and the brackets `（）「」『』【】《》〈〉［］｛｝` (U+FF08-09, U+300C-F, U+3010-11, U+300A-B, U+3008-9,
 * U+FF3B, U+FF3D, U+FF5B, U+FF5D). U+3002/U+FF0E would be a host's dot to the URL parser
 * (UTS #46): the cut is on purpose, since `。` ending a sentence before unspaced prose is far more
 * common than a fullwidth dot typed inside a host. The same start as `has_link` in postgres
 * (schema.sql), which says nothing about where a link ends, so what the panel draws as a
 * link is what `has:link` finds.
 */
const LINK_RE =
  /(^|[^\p{L}\p{N}])((?:https?:\/\/|www\.)[^\s\u3001\u3002\uff0c\uff0e\uff01\uff1f\uff1a\uff1b\u2026\u2014\u201c\u201d\uff08\uff09\u300c\u300d\u300e\u300f\u3010\u3011\u300a\u300b\u3008\u3009\uff3b\uff3d\uff5b\uff5d]+)/giu;
/** What a sentence puts after a link and is not part of it: `see https://x.y/z.` */
const TRAIL = /[.,;:!?'"\u00bb\u201d\u2019]+$/;
const BRACKETS: readonly (readonly [open: string, close: string])[] = [
  ['(', ')'],
  ['[', ']'],
  ['{', '}'],
  ['<', '>']
];
const LINK = 'text-primaryBlue underline-offset-2 hover:underline';
/** Who put a link in a line, for the word before it. */
const FROM = 'this link was put in the chat by whoever said the line, not by this site.';

type Part = string | { text: string; href: string };

function count(s: string, c: string): number {
  let n = 0;
  for (const ch of s) if (ch === c) n += 1;
  return n;
}

/** The link without the sentence's punctuation after it. A closing bracket is the link's own when the link opened it (`wiki/Foo_(bar)`). */
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

/**
 * Where the link goes, or null for one the browser would not take as http(s). A `www.` link is
 * https. Null too for a match the trim left without its `https://` or `www.` (`www..` → `www`):
 * `linkHref` would take that as a path on this site. And null for this origin with a path that
 * starts `//` (`https://<site>//evil.example/`; `\\`, `/\` and `/..//` parse to the same).
 */
export function hrefOf(link: string): string | null {
  if (!/^(https?:\/\/|www\.)/i.test(link)) return null;
  const href = linkHref(/^www\./i.test(link) ? `https://${link}` : link);
  // react-router reads a `to` of `//host` as another origin and renders a bare same-tab anchor to
  // it, past the leave-site dialog: the same shape `AuthPage.nextFrom` walls for `?next=`
  if (href && isSameOrigin(href) && !/^\/(?![/\\])/.test(new URL(href).pathname)) return null;
  return href;
}

/** The words apart from their links, in order. Plain words when there is none. */
export function splitLinks(text: string): Part[] {
  const parts: Part[] = [];
  let at = 0;
  for (const m of text.matchAll(LINK_RE)) {
    const lead = m[1] ?? '';
    const raw = m[2] ?? '';
    const start = m.index + lead.length;
    const link = trimLink(raw);
    const href = link ? hrefOf(link) : null;
    if (!href) continue;
    if (start > at) parts.push(text.slice(at, start));
    parts.push({ text: link, href });
    at = start + link.length;
  }
  if (at < text.length) parts.push(text.slice(at));
  return parts;
}

/**
 * The words of a line with its links drawn as links and its emote tokens as their pictures
 * (`Emote.tsx`, docs/chat.md "emotes"; bigger on a line of emotes alone). Nothing else is read
 * into the words: no markdown, no mentions. A link on this origin is a router link; any other
 * opens in a new tab through `ExternalLink`, which while the links setting asks for it first
 * says which site you are leaving for. The chat's lines and a direct message's are drawn
 * through this.
 */
export function LinkedText({ text }: { text: string }) {
  const parts = splitEmotes(text);
  const emotes = useEmotes(parts.flatMap((p) => (typeof p === 'string' ? [] : [p.id])));
  const jumbo = onlyEmotes(parts);
  return (
    <>
      {parts.map((part, i) =>
        typeof part === 'string' ? <Links key={i} text={part} /> : <Emote key={i} id={part.id} name={part.name} info={emotes.get(part.id)} jumbo={jumbo} />
      )}
    </>
  );
}

function Links({ text }: { text: string }) {
  const parts = splitLinks(text);
  return <>{parts.map((part, i) => (typeof part === 'string' ? <Fragment key={i}>{part}</Fragment> : <TalkLink key={i} text={part.text} href={part.href} />))}</>;
}

function TalkLink({ text, href }: { text: string; href: string }) {
  if (isSameOrigin(href)) {
    const url = new URL(href);
    return (
      <Link to={url.pathname + url.search + url.hash} className={LINK}>
        {text}
      </Link>
    );
  }
  return (
    <ExternalLink href={href} from={FROM} title={siteOf(href)} data-site={siteOf(href)} className={LINK}>
      {text}
    </ExternalLink>
  );
}
