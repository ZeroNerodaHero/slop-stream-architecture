import { Fragment } from 'react';
import { Link } from 'react-router-dom';

import { isSameOrigin, linkHref } from '@/infra/about';
import { onlyEmotes, splitEmotes, useEmotes } from '@/infra/emotes';
import { splitMentions } from '@/infra/mention-text';
import { Emote } from '@/shared-components/Emote';
import { ExternalLink, siteOf } from '@/shared-components/ExternalLink';
import { Mention } from '@/shared-components/Mention';

const LINK_RE =
  /(^|[^\p{L}\p{N}])((?:https?:\/\/|www\.)[^\s\u3001\u3002\uff0c\uff0e\uff01\uff1f\uff1a\uff1b\u2026\u2014\u201c\u201d\uff08\uff09\u300c\u300d\u300e\u300f\u3010\u3011\u300a\u300b\u3008\u3009\uff3b\uff3d\uff5b\uff5d]+)/giu;
const TRAIL = /[.,;:!?'"\u00bb\u201d\u2019]+$/;
const BRACKETS: readonly (readonly [open: string, close: string])[] = [
  ['(', ')'],
  ['[', ']'],
  ['{', '}'],
  ['<', '>']
];
const LINK = 'text-primaryBlue underline-offset-2 hover:underline';
export const TALK_FROM = 'this link was put in the chat by whoever said the line, not by this site.';

type Part = string | { text: string; href: string };

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

export function hrefOf(link: string): string | null {
  if (!/^(https?:\/\/|www\.)/i.test(link)) return null;
  const href = linkHref(/^www\./i.test(link) ? `https://${link}` : link);
  if (href && isSameOrigin(href) && !/^\/(?![/\\])/.test(new URL(href).pathname)) return null;
  return href;
}

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

export function LinkedText({ text, mentions }: { text: string; mentions?: readonly string[] }) {
  const parts = splitEmotes(text);
  const emotes = useEmotes(parts.flatMap((p) => (typeof p === 'string' ? [] : [p.id])));
  const jumbo = onlyEmotes(parts);
  return (
    <>
      {parts.map((part, i) =>
        typeof part === 'string' ? (
          <Links key={i} text={part} mentions={mentions} />
        ) : (
          <Emote key={i} id={part.id} name={part.name} info={emotes.get(part.id)} jumbo={jumbo} />
        )
      )}
    </>
  );
}

function Links({ text, mentions }: { text: string; mentions?: readonly string[] }) {
  const parts = splitLinks(text);
  return (
    <>
      {parts.map((part, i) =>
        typeof part !== 'string' ? (
          <TalkLink key={i} text={part.text} href={part.href} />
        ) : mentions && mentions.length > 0 ? (
          <Mentioned key={i} text={part} mentions={mentions} />
        ) : (
          <Fragment key={i}>{part}</Fragment>
        )
      )}
    </>
  );
}

function Mentioned({ text, mentions }: { text: string; mentions: readonly string[] }) {
  const parts = splitMentions(text, mentions);
  return <>{parts.map((part, i) => (typeof part === 'string' ? <Fragment key={i}>{part}</Fragment> : <Mention key={i} name={part.mention} text={part.text} />))}</>;
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
    <ExternalLink href={href} from={TALK_FROM} title={siteOf(href)} data-site={siteOf(href)} className={LINK}>
      {text}
    </ExternalLink>
  );
}
