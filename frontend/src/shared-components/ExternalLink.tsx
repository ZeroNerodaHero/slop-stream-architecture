import { type AnchorHTMLAttributes, type MouseEvent, type PointerEvent, type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { isSameOrigin } from '@/infra/about';
import { linkWarningAtom, setLinkWarning } from '@/infra/atoms/settings-atoms';
import { store } from '@/infra/store';
import { buttonClassName } from '@/shared-components/Button';
import { SHEET_DIALOG, SheetGrab, useSheetBack } from '@/shared-components/MobileSheet';
import { CHECKBOX } from '@/shared-components/user-modal/parts';
import { cn } from '@/utils/cn';

export const EXTERNAL_REL = 'noopener noreferrer nofollow';

export function siteOf(href: string): string {
  try {
    return new URL(href).hostname.replace(/^www\./, '');
  } catch {
    return href;
  }
}

function asks(href: string): boolean {
  return !isSameOrigin(href) && store.get(linkWarningAtom);
}

export function useExternalLink(href: string, from?: string) {
  const [asking, setAsking] = useState(false);
  const ask = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented || !asks(href)) return;
    e.preventDefault();
    setAsking(true);
  };
  return {
    onClick: ask,
    onAuxClick: (e: MouseEvent<HTMLAnchorElement>) => {
      if (e.button === 1) ask(e);
    },
    dialog: asking ? <LeaveDialog href={href} from={from} onClose={() => setAsking(false)} /> : null
  };
}

type ExternalLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'target' | 'rel'> & {
  href: string;
  from?: string;
  children?: ReactNode;
};

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
  from?: string;
  onClose: () => void;
}

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
  const pressedBackdrop = useRef(false);
  const [dontAsk, setDontAsk] = useState(false);
  const site = siteOf(href);

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
      className={cn(
        'm-auto w-[min(440px,calc(100vw-3rem))] md:rounded-panel border border-primaryStroke bg-backgroundSecondary p-6 text-base text-textPrimary backdrop:bg-black/60',
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
      <p id="leave-site-href" className="mt-3 rounded-control border border-primaryStroke bg-background px-3 py-2 text-sm text-textSecondary [overflow-wrap:anywhere]">
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
