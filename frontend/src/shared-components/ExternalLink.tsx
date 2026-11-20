import { type AnchorHTMLAttributes, type MouseEvent, type PointerEvent, type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { isSameOrigin } from '@/infra/about';
import { linkWarningAtom, setLinkWarning } from '@/infra/atoms/settings-atoms';
import { store } from '@/infra/store';
import { buttonClassName } from '@/shared-components/Button';
import { SHEET_DIALOG, SheetGrab, useSheetBack } from '@/shared-components/MobileSheet';
import { CHECKBOX } from '@/shared-components/user-modal/parts';
import { cn } from '@/utils/cn';

/** What every link out of this origin wears: a new tab that gets nothing of this page (about.md's rule for a link). */
export const EXTERNAL_REL = 'noopener noreferrer nofollow';

/** The site a link goes to, for the words: its host, without a `www.`. */
export function siteOf(href: string): string {
  try {
    return new URL(href).hostname.replace(/^www\./, '');
  } catch {
    return href;
  }
}

/** The links setting as it is at the click, not as it was when the link was drawn. */
function asks(href: string): boolean {
  return !isSameOrigin(href) && store.get(linkWarningAtom);
}

/**
 * The one way a link leaves this site (.cursor/rules/external-links.mdc): while the links
 * setting asks for it (the chat tab, `settings.linkWarning`), a click on it, a cmd/ctrl/shift
 * click or a middle click included, shows the word first (`LeaveDialog`) in place of the tab. A
 * link on this origin is let through as it is. `from` is who put the link there, the word's
 * first sentence. Spread the handlers on the `<a>` and draw `dialog` beside it; or take
 * `ExternalLink`, which does both.
 */
export function useExternalLink(href: string, from?: string) {
  const [asking, setAsking] = useState(false);
  const ask = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented || !asks(href)) return;
    e.preventDefault();
    setAsking(true);
  };
  return {
    onClick: ask,
    // the middle button opens a tab on auxclick, not click
    onAuxClick: (e: MouseEvent<HTMLAnchorElement>) => {
      if (e.button === 1) ask(e);
    },
    dialog: asking ? <LeaveDialog href={href} from={from} onClose={() => setAsking(false)} /> : null
  };
}

type ExternalLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'target' | 'rel'> & {
  href: string;
  /** Who put the link there: the word's first sentence. */
  from?: string;
  children?: ReactNode;
};

/** An `<a>` to another site: a new tab with `EXTERNAL_REL`, through the word while the links setting asks. */
export function ExternalLink({ href, from, onClick, onAuxClick, children, ...rest }: ExternalLinkProps) {
  const link = useExternalLink(href, from);
  return (
    <>
      <a
        {...rest}
        href={href}
        target="_blank"
        rel={EXTERNAL_REL}
        onClick={(e) => {
          onClick?.(e);
          link.onClick(e);
        }}
        onAuxClick={(e) => {
          onAuxClick?.(e);
          link.onAuxClick(e);
        }}
      >
        {children}
      </a>
      {link.dialog}
    </>
  );
}

interface LeaveDialogProps {
  href: string;
  /** Who put the link there. Unsaid: another site, nothing more. */
  from?: string;
  /** Closed any way: gone through, stayed, escape, the backdrop. */
  onClose: () => void;
}

/**
 * The word before a link out: which site it goes to, the whole address, and the way on or back.
 * On the page's body, not inside whatever drew the link (a modal inside a modal closes the outer
 * one with it), and in the link's own window: the popped-out player's when the chat is there.
 * The way on is the link itself, so the browser opens the tab the way it opens any link;
 * `don't ask again` turns the links setting off as it goes through, and the chat tab turns it
 * back on.
 */
export function LeaveDialog({ href, from, onClose }: LeaveDialogProps) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    setHost(anchor.current?.ownerDocument.body ?? null);
  }, []);
  return (
    <>
      <span ref={anchor} hidden />
      {host && createPortal(<LeaveBox href={href} from={from} onClose={onClose} />, host)}
    </>
  );
}

function LeaveBox({ href, from = 'this link goes to another site.', onClose }: LeaveDialogProps) {
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
  useSheetBack(close);
  const onPointerDown = (e: PointerEvent<HTMLDialogElement>) => {
    pressedBackdrop.current = e.target === e.currentTarget;
  };
  const onClick = (e: MouseEvent<HTMLDialogElement>) => {
    // the second click of a double-click on the link lands on the backdrop the first one opened: not a stay
    if (e.detail > 1) return;
    if (pressedBackdrop.current && e.target === e.currentTarget) close();
  };
  const go = () => {
    if (dontAsk) setLinkWarning(false);
    close();
  };

  return (
    <dialog
      ref={dialogRef}
      id="leave-site"
      data-sheet=""
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
      // a phone's is a sheet up from the foot (MobileSheet.tsx)
      className={cn(
        'm-auto w-[min(440px,calc(100vw-3rem))] border border-primaryStroke bg-backgroundSecondary p-6 text-base text-textPrimary backdrop:bg-black/60',
        SHEET_DIALOG
      )}
    >
      <SheetGrab onDismiss={close} />
      <h2 id="leave-site-title" className="border-l-4 border-primaryBlue pl-3 text-xl font-semibold leading-tight [overflow-wrap:anywhere]">
        you are leaving this site for {site}
      </h2>
      <p id="leave-site-message" className="mt-4 text-textSecondary">
        {from} this site cannot say what is there. it opens in a new tab.
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
          rel={EXTERNAL_REL}
          className={buttonClassName('primary', 'px-4 py-2 [overflow-wrap:anywhere]')}
          onClick={go}
          onAuxClick={(e) => {
            if (e.button === 1) go();
          }}
        >
          go to {site}
        </a>
      </div>
    </dialog>
  );
}
