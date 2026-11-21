import { type MouseEvent, type PointerEvent, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useIsMobile } from '@/infra/mobile';
import { Button } from '@/shared-components/Button';
import { SHEET_DIALOG, SheetGrab, useSheetBack } from '@/shared-components/MobileSheet';
import { cn } from '@/utils/cn';

/** A join's reason (voice-atoms.ts `fail`) in words a person can act on, by what is in it. */
export function voiceFailWords(error: string): string {
  const said = error.toLowerCase();
  if (said.includes('bad offer')) return "the voice server couldn't set up your call.";
  if (said.includes('room full')) return 'this channel is full.';
  if (said.includes('no audio path')) return 'your network is blocking voice (udp). try another wifi or turn off your vpn.';
  if (said.includes('too many voice peers')) return 'too many people on your network are already in voice.';
  if (said.includes('unreachable')) return "the voice server didn't answer.";
  if (said.includes('notallowederror') || said.includes('permission')) return 'your browser blocked the mic.';
  return 'something went wrong.';
}

interface VoiceFailDialogProps {
  /** The last try's reason, as the server or the browser said it. */
  error: string;
  /** Close, escape, a click on the backdrop, a drag down, the back button: the greyed seat stays. */
  onClose: () => void;
  /** A fresh run of tries. */
  onRetry: () => void;
}

/**
 * Why a voice join failed, once its last try did. ConfirmDialog's way: mounted = shown, a native
 * <dialog> opened modal on mount, on the page's body; a phone's is a sheet up from the foot
 * (MobileSheet.tsx). The human reason first, the raw one under it, then close and retry.
 */
export function VoiceFailDialog(props: VoiceFailDialogProps) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    setHost(anchor.current?.ownerDocument.body ?? null);
  }, []);
  return (
    <>
      <span ref={anchor} hidden />
      {host && createPortal(<FailBox {...props} />, host)}
    </>
  );
}

function FailBox({ error, onClose, onRetry }: VoiceFailDialogProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  /** Retry was pressed: the `close` that follows is a retry. Anything else only closes. */
  const retrying = useRef(false);
  /** The press that began this click was on the backdrop too: a drag that ends outside is not a close. */
  const pressedBackdrop = useRef(false);
  const mobile = useIsMobile();

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    dialog.showModal();
    dialog.querySelector<HTMLElement>('#voice-fail-close')?.focus();
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
    if (pressedBackdrop.current && e.target === e.currentTarget) close();
  };

  return (
    <dialog
      ref={dialogRef}
      id="voice-fail"
      data-sheet={mobile ? '' : undefined}
      aria-labelledby="voice-fail-title"
      aria-describedby="voice-fail-reason"
      onPointerDown={onPointerDown}
      onClick={onClick}
      onClose={(event) => {
        event.stopPropagation();
        if (retrying.current) onRetry();
        else onClose();
      }}
      // the dialog box is the panel: a click whose target is the dialog element landed on the backdrop
      className={cn('m-auto w-[min(420px,calc(100vw-3rem))] border border-primaryStroke bg-backgroundSecondary p-6 text-base text-textPrimary backdrop:bg-black/60', SHEET_DIALOG)}
    >
      <SheetGrab onDismiss={close} />
      <h2 id="voice-fail-title" className="border-l-4 border-primaryBlue pl-3 text-xl font-semibold leading-tight">
        failed to join
      </h2>
      <p id="voice-fail-reason" className="mt-4 text-sm text-textPrimary">
        {voiceFailWords(error)}
      </p>
      <p id="voice-fail-raw" className="mt-2 break-words font-mono text-xs text-textTertiary">
        {error}
      </p>
      <div className="mt-6 flex items-center justify-end gap-3">
        <Button id="voice-fail-close" variant="secondary" className="px-4 py-2 max-md:flex-1" onClick={close}>
          close
        </Button>
        <Button
          id="voice-fail-retry"
          variant="primary"
          className="px-4 py-2 max-md:flex-1"
          onClick={() => {
            retrying.current = true;
            close();
          }}
        >
          retry
        </Button>
      </div>
    </dialog>
  );
}
