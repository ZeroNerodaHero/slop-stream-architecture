import { useAtomValue } from 'jotai';
import { type ReactNode, useLayoutEffect, useRef } from 'react';

import { chatModalOpenAtom, chatSideAtom, setChatModalOpen } from '@/infra/atoms/settings-atoms';
import { store } from '@/infra/store';
import { ChatIcon, IconButton } from '@/shared-components/VideoControls';
import { cn } from '@/utils/cn';

/** The settings dialog, when it is open. The chat window must not cover it. */
function settingsOpen(): boolean {
  const el = document.getElementById('user-modal');
  return el instanceof HTMLDialogElement && el.open;
}

/**
 * The stream's chat, in whichever place the layout setting says. One `<dialog>` for the life
 * of the page, so a change of the setting never remounts the panel inside (a remount is a
 * reconnect). Left or right, the dialog is just the column: it is not open, and it is drawn
 * in the page. In a window, `showModal` puts that same dialog over the page. Closing the
 * window hides it and leaves the room connected; the chat button on the video opens it again.
 */
export function ChatSlot({ children }: { children: ReactNode }) {
  const side = useAtomValue(chatSideAtom);
  const open = useAtomValue(chatModalOpenAtom);
  const ref = useRef<HTMLDialogElement | null>(null);
  /** The press that began this click was on the backdrop too: a text drag that ends outside is not a close. */
  const pressedBackdrop = useRef(false);
  /** Set for the close that happens because the page is going away, so that close does not count as the viewer shutting the window. */
  const leaving = useRef(false);
  const modal = side === 'modal';

  // Opening and closing. Not in the cleanup: that close would run on every change and the
  // dialog's own `close` event would take the window straight back down.
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const want = modal && open && !settingsOpen();
    if (want) {
      if (!dialog.open) dialog.showModal();
    } else if (dialog.open && (!modal || !open)) {
      dialog.close();
    }
  }, [modal, open]);

  // The settings window was on top, so the chat window waited. When settings closes, it comes up.
  useLayoutEffect(() => {
    const el = document.getElementById('user-modal');
    if (!el) return;
    const onClose = () => {
      const dialog = ref.current;
      if (!dialog || dialog.open) return;
      if (store.get(chatSideAtom) === 'modal' && store.get(chatModalOpenAtom) && !settingsOpen()) dialog.showModal();
    };
    el.addEventListener('close', onClose);
    return () => el.removeEventListener('close', onClose);
  }, [modal, open]);

  // Leaving the page while the window is up: close it while the node is still here, so the
  // top layer goes with it.
  useLayoutEffect(() => {
    const dialog = ref.current;
    return () => {
      leaving.current = true;
      if (dialog?.open) dialog.close();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      id="chat-modal"
      aria-label="chat"
      role={modal ? undefined : 'presentation'}
      onPointerDown={(e) => {
        pressedBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (modal && pressedBackdrop.current && e.target === e.currentTarget) setChatModalOpen(false);
      }}
      onClose={() => {
        if (leaving.current) return;
        if (store.get(chatSideAtom) === 'modal') setChatModalOpen(false);
      }}
      className={cn(
        modal
          ? 'm-auto hidden h-[min(720px,calc(100dvh-3rem))] w-[min(420px,calc(100vw-3rem))] max-w-none flex-col overflow-hidden border border-primaryStroke bg-backgroundSecondary p-0 text-base text-textPrimary shadow-hard-lg backdrop:bg-black/60 open:flex'
          : cn(
              'static m-0 mt-4 flex h-[min(50vh,560px)] w-full min-w-0 max-w-none flex-col border-0 bg-transparent p-0 text-textPrimary shadow-none',
              '[&:not([open])]:flex lg:row-span-2 lg:mt-0 lg:h-[calc(100vh-140px)] lg:max-h-[720px]',
              side === 'left' && 'lg:col-start-1 lg:row-start-1'
            )
      )}
    >
      {modal && (
        <div className="flex shrink-0 justify-end border-b border-primaryStroke">
          <button
            id="chat-modal-close"
            type="button"
            aria-label="close the chat"
            onClick={() => setChatModalOpen(false)}
            className="px-3 py-1 text-lg leading-none text-textSecondary hover:text-primaryBlue"
          >
            ×
          </button>
        </div>
      )}
      {children}
    </dialog>
  );
}

/** On the video, and only while the chat is a window: opens it, or closes it. Nothing otherwise, so the picture-in-picture chip keeps the right edge. */
export function ChatOpenButton({ className }: { className?: string }) {
  const side = useAtomValue(chatSideAtom);
  const open = useAtomValue(chatModalOpenAtom);
  if (side !== 'modal') return null;
  return (
    <IconButton id="chat-open" label={open ? 'close the chat' : 'chat'} active={open} tipAt="above-right" className={className} onClick={() => setChatModalOpen(!open)}>
      <ChatIcon />
    </IconButton>
  );
}
