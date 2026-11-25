import { RiCloseLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { useLayoutEffect, useRef } from 'react';

import { type AuthMode, authDialogAtom, closeAuthDialog, openAuthDialog } from '@/infra/atoms/auth-atoms';
import { AuthForm } from '@/shared-components/AuthForm';
import { SHEET_CLOSE, SHEET_DIALOG, SheetGrab, focusOnOpen, useSheetBack } from '@/shared-components/MobileSheet';
import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

export function AuthDialog() {
  const mode = useAtomValue(authDialogAtom);
  return mode ? <AuthBox mode={mode} /> : null;
}

function AuthBox({ mode }: { mode: AuthMode }) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const pressedBackdrop = useRef(false);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    dialog.showModal();
    focusOnOpen(dialog, '#auth-name');
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  const close = () => dialogRef.current?.close();
  useSheetBack(close);

  return (
    <dialog
      ref={dialogRef}
      id="auth-dialog"
      data-sheet=""
      data-mode={mode}
      aria-labelledby="auth-title"
      onPointerDown={(e) => {
        pressedBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (pressedBackdrop.current && e.target === e.currentTarget) close();
      }}
      onClose={(event) => {
        if (event.target !== event.currentTarget) return;
        closeAuthDialog();
      }}
      className={cn(
        'm-auto w-[min(420px,calc(100vw-3rem))] md:rounded-panel border border-primaryStroke bg-backgroundSecondary px-5 py-4 text-textPrimary backdrop:bg-black/60 backdrop:backdrop-blur-sm',
        SHEET_DIALOG
      )}
    >
      <SheetGrab onDismiss={close} />
      <div className="relative">
        <div className="absolute -right-2 -top-2">
          <Tooltip content="close" at="left">
            <button
              id="auth-close"
              type="button"
              aria-label="close"
              aria-keyshortcuts="Escape"
              onClick={close}
              className={cn(
                'flex h-8 w-8 items-center justify-center rounded-control border border-primaryStroke bg-backgroundSecondary text-textSecondary transition-colors duration-150 hover:border-primaryBlue hover:text-primaryBlue focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-primaryBlue',
                SHEET_CLOSE
              )}
            >
              <RiCloseLine aria-hidden size={18} />
            </button>
          </Tooltip>
        </div>
        <h2 id="auth-title" className="border-l-4 border-primaryBlue pl-3 pr-10 text-xl font-semibold leading-tight">
          {mode === 'signup' ? 'sign up' : 'log in'}
        </h2>
      </div>
      <AuthForm mode={mode} onMode={openAuthDialog} onDone={close} />
    </dialog>
  );
}
