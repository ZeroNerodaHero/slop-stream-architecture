import { type MouseEvent, type PointerEvent, type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { Button } from '@/shared-components/Button';
import { SHEET_DIALOG, SheetGrab, useSheetBack } from '@/shared-components/MobileSheet';
import { cn } from '@/utils/cn';

interface ConfirmDialogProps {
  id: string;
  title: string;
  message?: string;
  children?: ReactNode;
  yes: string;
  onYes: () => void;
  onNo: () => void;
}

export function ConfirmDialog(props: ConfirmDialogProps) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
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

function ConfirmBox({ id, title, message, children, yes, onYes, onNo }: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const saidYes = useRef(false);
  const pressedBackdrop = useRef(false);

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
      id={id}
      data-sheet=""
      aria-labelledby={`${id}-title`}
      aria-describedby={message ? `${id}-message` : undefined}
      onPointerDown={onPointerDown}
      onClick={onClick}
      onClose={(event) => {
        event.stopPropagation();
        if (saidYes.current) onYes();
        else onNo();
      }}
      className={cn('m-auto w-[min(420px,calc(100vw-3rem))] md:rounded-panel border border-primaryStroke bg-backgroundSecondary p-6 text-base text-textPrimary backdrop:bg-black/60', SHEET_DIALOG)}
    >
      <SheetGrab onDismiss={close} />
      <h2 id={`${id}-title`} className="border-l-4 border-primaryBlue pl-3 text-xl font-semibold leading-tight">
        {title}
      </h2>
      {message && (
        <p id={`${id}-message`} className="mt-4 text-textSecondary">
          {message}
        </p>
      )}
      {children && <div className="mt-4 flex flex-col gap-3">{children}</div>}
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
