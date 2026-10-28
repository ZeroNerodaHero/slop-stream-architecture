import { type MouseEvent, type PointerEvent, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { Button } from '@/shared-components/Button';

interface ConfirmDialogProps {
  /** The ids the tests key on: `<id>`, `<id>-title`, `<id>-message`, `<id>-yes`, `<id>-no`. */
  id: string;
  /** The question, as the heading. */
  title: string;
  /** What a yes does, spelled out. */
  message: string;
  /** The yes button's word ("yes, stop"). The other one says "no". */
  yes: string;
  onYes: () => void;
  /** No, escape, a click on the backdrop, or the question taken away unanswered. */
  onNo: () => void;
}

/**
 * A yes or no before something that cannot be undone (stopping a stream from its corner
 * player). Mounted = asked, the way UserModal is mounted = shown: a native <dialog> opened
 * modal on mount, so the browser keeps focus in it, closes it on escape and hands focus back
 * to the button that asked. Every way out goes through the element's `close`, which says
 * which answer it was. It is asked in its own window, the page's or the popped-out player's,
 * and not inside another dialog: a modal inside a modal closes the outer one with it. "no"
 * has focus to begin with: a stray enter changes nothing.
 */
export function ConfirmDialog(props: ConfirmDialogProps) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  // On the page, not inside whatever dialog asked: a modal inside a modal closes the outer one
  // with it. The anchor's document is the popped-out player's own window when the question is
  // asked there.
  useLayoutEffect(() => {
    setHost(anchor.current?.ownerDocument.body ?? null);
  }, []);
  return (
    <>
      <span ref={anchor} hidden />
      {host && createPortal(<ConfirmBox {...props} />, host)}
    </>
  );
}

function ConfirmBox({ id, title, message, yes, onYes, onNo }: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  /** Yes was pressed: the `close` that follows is a yes. Anything else is a no. */
  const saidYes = useRef(false);
  /** The press that began this click was on the backdrop too: a drag that ends outside is not a no. */
  const pressedBackdrop = useRef(false);

  // A layout effect: its cleanup runs while the node is still in the document, which is when
  // close() hands focus back. Taken away while still open (the player hid under it, a route
  // change from the browser's own buttons), the question was not answered: a no.
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    dialog.showModal();
    dialog.querySelector<HTMLElement>(`#${CSS.escape(id)}-no`)?.focus();
    return () => {
      if (!dialog.open) return;
      dialog.close();
      onNo();
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
      id={id}
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-message`}
      onPointerDown={onPointerDown}
      onClick={onClick}
      onClose={(event) => {
        event.stopPropagation();
        if (saidYes.current) onYes();
        else onNo();
      }}
      // the dialog box is the panel: a click whose target is the dialog element landed on the backdrop
      className="m-auto w-[min(420px,calc(100vw-3rem))] border border-primaryStroke bg-backgroundSecondary p-6 text-base text-textPrimary backdrop:bg-black/60"
    >
      <h2 id={`${id}-title`} className="border-l-4 border-primaryBlue pl-3 text-xl font-semibold leading-tight">
        {title}
      </h2>
      <p id={`${id}-message`} className="mt-4 text-textSecondary">
        {message}
      </p>
      <div className="mt-6 flex items-center justify-end gap-3">
        <button id={`${id}-no`} type="button" className="text-base font-semibold text-textTertiary" onClick={close}>
          no
        </button>
        <Button
          id={`${id}-yes`}
          variant="danger"
          className="px-4 py-2"
          onClick={() => {
            saidYes.current = true;
            close();
          }}
        >
          {yes}
        </Button>
      </div>
    </dialog>
  );
}
