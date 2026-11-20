import { RiCloseLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { useLayoutEffect, useRef } from 'react';

import { type AuthMode, authDialogAtom, closeAuthDialog, openAuthDialog } from '@/infra/atoms/auth-atoms';
import { AuthForm } from '@/shared-components/AuthForm';
import { SHEET_CLOSE, SHEET_DIALOG, SheetGrab, focusOnOpen, useSheetBack, useSheetKeyboard } from '@/shared-components/MobileSheet';
import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

/**
 * Log in or sign up over the page you are on, instead of a page of its own: the sidebar's two
 * words, "log in to create" on the groups page, "log in to join" in a group, and the /login and
 * /signup links (AuthPage.tsx lands you on their `next` with this open). Mounted by the Shell;
 * it renders nothing until `openAuthDialog`. A logged in form closes it and you stay where you
 * were. The ConfirmDialog and UserModal recipe: a native <dialog>, so the browser keeps focus
 * in it, closes it on escape and hands focus back to what opened it; a click on the backdrop
 * closes it too.
 */
export function AuthDialog() {
  const mode = useAtomValue(authDialogAtom);
  return mode ? <AuthBox mode={mode} /> : null;
}

/** Mounted = shown. Switching between log in and sign up is a new `mode`, not a remount: the typed name stays. */
function AuthBox({ mode }: { mode: AuthMode }) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  /** The press that began this click was on the backdrop too: a text drag that ends outside is not a close. */
  const pressedBackdrop = useRef(false);

  // A layout effect: its cleanup runs while the node is still in the document, which is when
  // close() hands focus back to the opener. (A passive cleanup would run after the removal.)
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    dialog.showModal();
    // the name, not the first focusable (that is the close in the corner); not on a phone, whose keyboard waits for a tap
    focusOnOpen(dialog, '#auth-name');
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  // every way out goes through the element: close() restores focus, then fires `close`
  const close = () => dialogRef.current?.close();
  useSheetBack(close);
  useSheetKeyboard(dialogRef);

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
      // the dialog box is the panel: a click whose target is the dialog element landed on the backdrop
      // a phone's is a sheet up from the foot (MobileSheet.tsx)
      className={cn(
        'm-auto w-[min(420px,calc(100vw-3rem))] border border-primaryStroke bg-backgroundSecondary px-5 py-4 text-textPrimary backdrop:bg-black/60 backdrop:backdrop-blur-sm',
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
                'flex h-8 w-8 items-center justify-center border border-primaryStroke bg-backgroundSecondary text-textSecondary transition-colors duration-150 hover:border-primaryBlue hover:text-primaryBlue focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-primaryBlue',
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
