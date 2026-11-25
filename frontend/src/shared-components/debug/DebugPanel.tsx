import { RiCloseLine } from '@remixicon/react';
import type { ReactNode } from 'react';

import type { WindowId } from '@/infra/debug/window-store';
import { useIsMobile } from '@/infra/mobile';
import { FRAME, GRIP, useDialogBox } from '@/shared-components/debug/useDialogBox';
import { SHEET_CLOSE, SheetGrab, useSheetBack } from '@/shared-components/MobileSheet';
import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

export function DebugPanel({
  id,
  label,
  lead,
  note,
  place,
  onClose,
  actions,
  children
}: {
  id: WindowId;
  label: string;
  lead?: ReactNode;
  note?: ReactNode;
  place: string;
  onClose: () => void;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const { dialogRef, box, press } = useDialogBox(id);
  const mobile = useIsMobile();
  useSheetBack(onClose);

  return (
    <dialog
      ref={dialogRef}
      id={`${id}-panel`}
      aria-label={label}
      onClose={onClose}
      data-sheet={mobile ? '' : undefined}
      style={box && !mobile ? { left: box.x, top: box.y, width: box.w, height: box.h } : undefined}
      className={cn(
        FRAME,
        'fixed m-0 flex flex-col overflow-hidden p-0 text-sm text-textPrimary open:flex',
        mobile ? 'inset-x-0 bottom-0 top-auto h-[60dvh] w-full max-w-none border-x-0 border-b-0 pb-[env(safe-area-inset-bottom)]' : !box && place
      )}
    >
      {mobile && <SheetGrab onDismiss={onClose} />}
      <header
        className={cn('flex cursor-move items-center gap-2 border-b border-primaryStroke px-3 py-2', GRIP, mobile && 'cursor-auto')}
        onPointerDown={(e) => {
          if (!mobile) press(e, 'move');
        }}
      >
        {lead}
        <span className="font-semibold">{label}</span>
        {note && <span className="min-w-0 truncate text-xs text-textTertiary">{note}</span>}
        <span className="ml-auto flex items-center gap-2">
          {actions}
          <Tooltip content="close">
            <button
              id={`${id}-close`}
              type="button"
              aria-label="close"
              onClick={onClose}
              className={cn('flex h-7 w-7 items-center justify-center border border-transparent hover:border-primaryBlue hover:text-primaryBlue', SHEET_CLOSE)}
            >
              <RiCloseLine aria-hidden size={18} />
            </button>
          </Tooltip>
        </span>
      </header>

      {children}

      {!mobile && (
        <div
          id={`${id}-resize-se`}
          aria-hidden
          onPointerDown={(e) => press(e, 'resize')}
          className={cn('absolute -bottom-px -right-px h-4 w-4 cursor-nwse-resize border-b-2 border-r-2 border-primaryBlue', GRIP)}
        />
      )}
    </dialog>
  );
}
