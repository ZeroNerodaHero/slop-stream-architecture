import { Fragment, type MouseEvent, type PointerEvent, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';

import { isSameOrigin, linkHref } from '@/infra/about';
import { linkWarningAtom, setLinkWarning } from '@/infra/atoms/settings-atoms';
import { store } from '@/infra/store';
import { buttonClassName } from '@/shared-components/Button';
import { CHECKBOX } from '@/shared-components/user-modal/parts';

/**
 * A link in talk: `http(s)://…` or `www.…` at the start of a word, up to the next space. The
 * same shape as `has_link` in postgres (migrate-22.sql), so what the panel draws as a link is
 * what `has:link` finds.
 */
const LINK_RE = /(^|[^\p{L}\p{N}])((?:https?:\/\/|www\.)[^\s]+)/giu;
/** What a sentence puts after a link and is not part of it: `see https://x.y/z.` */
const TRAIL = /[.,;:!?'"\u00bb\u201d\u2019]+$/;
const BRACKETS: readonly (readonly [open: string, close: string])[] = [
  ['(', ')'],
  ['[', ']'],
  ['{', '}']
];
const LINK = 'text-primaryBlue underline-offset-2 hover:underline';

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

/** Where the link goes, or null for one the browser would not take as http(s). A `www.` link is https. */
export function hrefOf(link: string): string | null {
  return linkHref(/^www\./i.test(link) ? `https://${link}` : link);
}

/** The site a link goes to, for the words: its host, without a `www.`. */
export function siteOf(href: string): string {
  try {
    return new URL(href).hostname.replace(/^www\./, '');
  } catch {
    return href;
  }
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
 * The words of a line with its links drawn as links. Nothing else is read into the words: no
 * markdown, no mentions. A link on this origin is a router link; any other opens in a new tab
 * (`rel="noopener noreferrer nofollow"`, about.md's rule for a link) and, while the links
 * setting asks for it, first says which site you are leaving for (`LeaveDialog`). The chat's
 * lines and a direct message's are drawn through this.
 */
export function LinkedText({ text }: { text: string }) {
  const parts = splitLinks(text);
  return <>{parts.map((part, i) => (typeof part === 'string' ? <Fragment key={i}>{part}</Fragment> : <TalkLink key={i} text={part.text} href={part.href} />))}</>;
}

function TalkLink({ text, href }: { text: string; href: string }) {
  const [asking, setAsking] = useState(false);
  if (isSameOrigin(href)) {
    const url = new URL(href);
    return (
      <Link to={url.pathname + url.search + url.hash} className={LINK}>
        {text}
      </Link>
    );
  }
  return (
    <>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer nofollow"
        title={siteOf(href)}
        data-site={siteOf(href)}
        className={LINK}
        onClick={(e) => {
          // the setting as it is at the click, not as it was when the line was drawn
          if (!store.get(linkWarningAtom)) return;
          e.preventDefault();
          setAsking(true);
        }}
      >
        {text}
      </a>
      {asking && <LeaveDialog href={href} onClose={() => setAsking(false)} />}
    </>
  );
}

interface LeaveDialogProps {
  href: string;
  /** Closed any way: gone through, stayed, escape, the backdrop. */
  onClose: () => void;
}

/**
 * The word before a link out: which site it goes to, the whole address, and the way on or back.
 * On the page's body, not inside whatever drew the line (a modal inside a modal closes the outer
 * one with it), and in the line's own window: the popped-out player's when the chat is there.
 * The way on is the link itself, so the browser opens the tab the way it opens any link;
 * `don't ask again` turns the links setting off as it goes through, and the chat tab turns it
 * back on.
 */
export function LeaveDialog({ href, onClose }: LeaveDialogProps) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    setHost(anchor.current?.ownerDocument.body ?? null);
  }, []);
  return (
    <>
      <span ref={anchor} hidden />
      {host && createPortal(<LeaveBox href={href} onClose={onClose} />, host)}
    </>
  );
}

function LeaveBox({ href, onClose }: LeaveDialogProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  /** The press that began this click was on the backdrop too: a drag that ends outside is not a stay. */
  const pressedBackdrop = useRef(false);
  const [dontAsk, setDontAsk] = useState(false);
  const site = siteOf(href);

  // A layout effect, as ConfirmDialog: its cleanup runs while the node is still in the
  // document, which is when close() hands focus back to the link. "stay" has focus to begin
  // with: a stray enter goes nowhere.
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    dialog.showModal();
    dialog.querySelector<HTMLElement>('#leave-site-stay')?.focus();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  const close = () => dialogRef.current?.close();
  const onPointerDown = (e: PointerEvent<HTMLDialogElement>) => {
    pressedBackdrop.current = e.target === e.currentTarget;
  };
  const onClick = (e: MouseEvent<HTMLDialogElement>) => {
    if (pressedBackdrop.current && e.target === e.currentTarget) close();
  };

  return (
    <dialog
      ref={dialogRef}
      id="leave-site"
      data-site={site}
      aria-labelledby="leave-site-title"
      aria-describedby="leave-site-message"
      onPointerDown={onPointerDown}
      onClick={onClick}
      onClose={(event) => {
        event.stopPropagation();
        onClose();
      }}
      // the dialog box is the panel: a click whose target is the dialog element landed on the backdrop
      className="m-auto w-[min(440px,calc(100vw-3rem))] border border-primaryStroke bg-backgroundSecondary p-6 text-base text-textPrimary backdrop:bg-black/60"
    >
      <h2 id="leave-site-title" className="border-l-4 border-primaryBlue pl-3 text-xl font-semibold leading-tight [overflow-wrap:anywhere]">
        you are leaving this site for {site}
      </h2>
      <p id="leave-site-message" className="mt-4 text-textSecondary">
        this link was put in the chat by whoever said the line, not by this site, and this site cannot say what is there. it opens in a new tab.
      </p>
      <p id="leave-site-href" className="mt-3 border border-primaryStroke bg-background px-3 py-2 text-sm text-textSecondary [overflow-wrap:anywhere]">
        {href}
      </p>
      <label htmlFor="leave-site-dont-ask" className="mt-4 flex cursor-pointer items-start gap-2 text-sm text-textSecondary">
        <input id="leave-site-dont-ask" type="checkbox" checked={dontAsk} onChange={(e) => setDontAsk(e.target.checked)} className={`${CHECKBOX} mt-0.5`} />
        <span>don&rsquo;t ask again: links open at once. the chat tab of your settings asks again</span>
      </label>
      <div className="mt-6 flex items-center justify-end gap-3">
        <button id="leave-site-stay" type="button" className="text-base font-semibold text-textTertiary" onClick={close}>
          stay
        </button>
        {/* the link itself, dressed as the button: the browser opens the tab, and the box closes behind it */}
        <a
          id="leave-site-go"
          href={href}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className={buttonClassName('primary', 'px-4 py-2 [overflow-wrap:anywhere]')}
          onClick={() => {
            if (dontAsk) setLinkWarning(false);
            close();
          }}
        >
          go to {site}
        </a>
      </div>
    </dialog>
  );
}
