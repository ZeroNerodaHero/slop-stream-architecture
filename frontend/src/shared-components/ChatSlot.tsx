import { useAtomValue } from 'jotai';
import { type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { type ChatSide, chatModalOpenAtom, chatSideAtom, setChatModalOpen } from '@/infra/atoms/settings-atoms';
import { store } from '@/infra/store';
import { ChatIcon, IconButton } from '@/shared-components/VideoControls';
import { cn } from '@/utils/cn';

/** The settings dialog, when it is open. The chat window must not cover it. */
function settingsOpen(): boolean {
  const el = document.getElementById('user-modal');
  return el instanceof HTMLDialogElement && el.open;
}

const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** How long the window fades. Matches `duration-200` on the dialog. */
const WINDOW_MS = 200;
/** How long a column slides. Matches `duration-300` on the page grid and the dialog. */
const COLUMN_MS = 300;

const GRIP = 'touch-none select-none [-webkit-touch-callout:none]';
const MIN_W = 280;
const MIN_H = 320;

/** Where the window was dragged, and how big. `null` is the default, the top right, until the first move or resize. */
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Where the window was put, for the rest of the visit. Watch and go live each mount their own
 * slot; the next one starts where the last one was left.
 */
let parked: Box | null = null;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const room = () => ({ w: document.documentElement.clientWidth, h: document.documentElement.clientHeight });

/** Slid along with the pointer, stopped at the edges. */
function moved(rect: DOMRect, dx: number, dy: number): Box {
  const r = room();
  return {
    x: clamp(rect.left + dx, 0, Math.max(0, r.w - rect.width)),
    y: clamp(rect.top + dy, 0, Math.max(0, r.h - rect.height)),
    w: rect.width,
    h: rect.height
  };
}

/** A corner pulled. The opposite corner stays put, and the box stops at the screen edge. */
function resized(rect: DOMRect, dx: number, dy: number, sx: number, sy: number): Box {
  const r = room();
  let x = rect.left;
  let y = rect.top;
  let w = rect.width;
  let h = rect.height;
  if (sx > 0) w = clamp(w + dx, MIN_W, Math.max(MIN_W, r.w - x));
  else {
    w = clamp(w - dx, MIN_W, rect.right);
    x = rect.right - w;
  }
  if (sy > 0) h = clamp(h + dy, MIN_H, Math.max(MIN_H, r.h - y));
  else {
    h = clamp(h - dy, MIN_H, rect.bottom);
    y = rect.bottom - h;
  }
  return { x, y, w, h };
}

/** The same box, back on screen: the window shrank, or it was left somewhere while hidden. */
function fitted(box: Box): Box {
  const r = room();
  const w = Math.min(box.w, r.w);
  const h = Math.min(box.h, r.h);
  return { w, h, x: clamp(box.x, 0, Math.max(0, r.w - w)), y: clamp(box.y, 0, Math.max(0, r.h - h)) };
}

/** The corner handles. `sx`/`sy`: which way the box grows when that corner is pulled outward. */
const CORNERS = [
  { id: 'nw', sx: -1, sy: -1, className: '-left-px -top-px cursor-nwse-resize border-l-2 border-t-2' },
  { id: 'ne', sx: 1, sy: -1, className: '-right-px -top-px cursor-nesw-resize border-r-2 border-t-2' },
  { id: 'sw', sx: -1, sy: 1, className: '-bottom-px -left-px cursor-nesw-resize border-b-2 border-l-2' },
  { id: 'se', sx: 1, sy: 1, className: '-bottom-px -right-px cursor-nwse-resize border-b-2 border-r-2' }
] as const;

/**
 * The page grid for a chat column. The column width and the gap ease shut when the chat is
 * closed, so the video takes the row; the dialog inside keeps its own height until that slide
 * is done, or the panel would squash instead of leaving to the side. A window is no grid: the
 * dialog floats.
 */
export function chatLayoutClass(side: ChatSide, open: boolean): string {
  if (side !== 'left' && side !== 'right') return '';
  return cn(
    'lg:grid lg:grid-rows-[auto_1fr] lg:items-start lg:transition-[grid-template-columns,column-gap] lg:duration-300 lg:ease-out motion-reduce:lg:transition-none',
    open ? 'lg:gap-x-6' : 'lg:gap-x-0',
    side === 'right' && (open ? 'lg:grid-cols-[minmax(0,1fr)_360px]' : 'lg:grid-cols-[minmax(0,1fr)_0px]'),
    side === 'left' && (open ? 'lg:grid-cols-[360px_minmax(0,1fr)]' : 'lg:grid-cols-[0px_minmax(0,1fr)]')
  );
}

/**
 * The stream's chat, in whichever place the layout setting says. One `<dialog>` for the life
 * of the page, so a change of the setting never remounts the panel inside (a remount is a
 * reconnect). Left or right, the dialog is just the column: it is not open, and it is drawn
 * in the page, sliding out to that side when the chat button closes it. In a window, `show`
 * (not `showModal`) puts that same dialog over the page without freezing it: drag the top
 * edge, pull a corner. Closing fades it and leaves the room connected; the chat button on
 * the video opens it again.
 */
export function ChatSlot({ children }: { children: ReactNode }) {
  const side = useAtomValue(chatSideAtom);
  const open = useAtomValue(chatModalOpenAtom);
  const ref = useRef<HTMLDialogElement | null>(null);
  /** Set for the close that happens because the page is going away, so that close does not count as the viewer shutting the window. */
  const leaving = useRef(false);
  /** Ends the press in progress: its window listeners go. `null` between presses. */
  const stop = useRef<(() => void) | null>(null);
  /** The first time a column is shown it is already open: clipping it would hide the shadow for no slide. */
  const skipOpenClip = useRef(true);
  const modal = side === 'modal';
  const [box, setBox] = useState<Box | null>(parked);
  /** The window has finished fading in. While false it is invisible, so the first paint is the start of the fade. */
  const [shown, setShown] = useState(false);
  /** The column keeps its height through the slide, then drops it, so the page below does not jump while the panel is still on screen. */
  const [held, setHeld] = useState(open);
  /** Clip the column while it slides, so a fixed-width panel is revealed by the growing cell. Settled, the shadow needs to spill. */
  const [clip, setClip] = useState(false);

  useEffect(() => {
    parked = box;
  }, [box]);

  // A moved window is pulled back on screen when the window shrinks.
  useEffect(() => {
    if (!modal) return;
    const fit = () =>
      setBox((b) => {
        if (!b) return b;
        const next = fitted(b);
        return next.x === b.x && next.y === b.y && next.w === b.w && next.h === b.h ? b : next;
      });
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [modal]);

  // The column's slide. Height stays until the width has gone, and the clip stays until the
  // width has come back. Not on the way into the page: it is already open, and there is nothing to slide.
  useLayoutEffect(() => {
    if (modal) return;
    if (reduceMotion()) {
      setHeld(open);
      setClip(false);
      return;
    }
    if (open) {
      setHeld(true);
      if (skipOpenClip.current) {
        skipOpenClip.current = false;
        return;
      }
      setClip(true);
      const t = window.setTimeout(() => setClip(false), COLUMN_MS);
      return () => clearTimeout(t);
    }
    skipOpenClip.current = false;
    setClip(true);
    const t = window.setTimeout(() => setHeld(false), COLUMN_MS);
    return () => clearTimeout(t);
  }, [open, modal]);

  // Opening and closing the window. Not in the cleanup: that close would run on every change
  // and the dialog's own `close` event would take the window straight back down. `show`, not
  // `showModal`: a modal would freeze the page, and the point of the window is that the stream
  // behind it still plays.
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!modal) {
      setShown(false);
      if (dialog.open) dialog.close();
      return;
    }
    if (!open) {
      setShown(false);
      if (!dialog.open) return;
      if (reduceMotion()) {
        dialog.close();
        return;
      }
      const t = window.setTimeout(() => {
        if (dialog.open) dialog.close();
      }, WINDOW_MS);
      return () => clearTimeout(t);
    }
    if (settingsOpen()) return;
    if (!dialog.open) dialog.show();
    if (reduceMotion()) {
      setShown(true);
      return;
    }
    setShown(false);
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setShown(true));
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [modal, open]);

  // The settings window was on top, so the chat window waited. When settings closes, it comes up.
  // `close` does not bubble; the capture on the document still hears it.
  useEffect(() => {
    const onClose = (e: Event) => {
      if (!(e.target instanceof Element) || e.target.id !== 'user-modal') return;
      const dialog = ref.current;
      if (!dialog || dialog.open || settingsOpen()) return;
      if (store.get(chatSideAtom) !== 'modal' || !store.get(chatModalOpenAtom)) return;
      dialog.show();
      if (reduceMotion()) {
        setShown(true);
        return;
      }
      setShown(false);
      requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)));
    };
    document.addEventListener('close', onClose, true);
    return () => document.removeEventListener('close', onClose, true);
  }, []);

  // Escape closes the window, the way the old modal did, except while typing in the page
  // (the stream behind the window is usable now, and a status box should keep the key).
  useEffect(() => {
    if (!modal || !open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || settingsOpen()) return;
      const dialog = ref.current;
      const active = document.activeElement;
      const inPage = active instanceof Element && dialog && !dialog.contains(active) && active !== document.body && active !== document.documentElement;
      if (inPage) return;
      e.preventDefault();
      setChatModalOpen(false);
      document.getElementById('chat-open')?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [modal, open]);

  // Leaving the page while the window is up: close it while the node is still here, so the
  // top layer goes with it.
  useLayoutEffect(() => {
    const dialog = ref.current;
    return () => {
      leaving.current = true;
      stop.current?.();
      if (dialog?.open) dialog.close();
    };
  }, []);

  /**
   * A press on the top edge (a move) or on a corner (a resize). Followed through window
   * listeners, so leaving the box loses nothing.
   */
  const press = (e: ReactPointerEvent, kind: 'move' | 'resize', sx = 0, sy = 0) => {
    const el = ref.current;
    if (e.button !== 0 || stop.current || !el) return;
    if ((e.target as Element).closest('button, input, textarea, a')) return;
    e.preventDefault();
    const rect = el.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const pointerId = e.pointerId;
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      setBox(kind === 'move' ? moved(rect, dx, dy) : resized(rect, dx, dy, sx, sy));
    };
    const end = (ev: PointerEvent) => {
      if (ev.pointerId === pointerId) stop.current?.();
    };
    stop.current = () => {
      stop.current = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  };

  const tall = open || held;
  // default position is the right. once dragged, the fade leaves toward whichever half it sits in.
  const fromLeft = box !== null && box.x + box.w / 2 < room().w / 2;
  const style: CSSProperties | undefined = modal && box ? { left: box.x, top: box.y, width: box.w, height: box.h } : undefined;

  return (
    <dialog
      ref={ref}
      id="chat-modal"
      aria-label="chat"
      inert={!open ? true : undefined}
      role={modal ? undefined : 'presentation'}
      onClose={() => {
        if (leaving.current) return;
        if (store.get(chatSideAtom) === 'modal') setChatModalOpen(false);
      }}
      style={style}
      className={cn(
        modal
          ? cn(
              // no offset shadow: a floating box over a page of shadowed boxes would read as one more block. the stroke marks the edge
      'group fixed z-40 m-0 hidden max-h-none max-w-none flex-col overflow-hidden border border-primaryStroke bg-backgroundSecondary p-0 text-base text-textPrimary open:flex',
              'origin-center transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none',
              shown ? 'translate-x-0 scale-100 opacity-100' : cn('pointer-events-none scale-[0.98] opacity-0', fromLeft ? '-translate-x-3' : 'translate-x-3'),
              !box && 'left-auto right-6 top-20 h-[min(720px,calc(100dvh-6rem))] w-[min(420px,calc(100vw-3rem))]'
            )
          : cn(
              'static m-0 flex w-full min-h-0 min-w-0 max-w-none flex-col border-0 bg-transparent p-0 text-textPrimary shadow-none [&:not([open])]:flex',
              'transition-[height,margin-top,opacity] duration-300 ease-out motion-reduce:transition-none lg:relative lg:transition-none',
              'lg:row-span-2',
              side === 'left' && 'lg:col-start-1 lg:row-start-1',
              open ? 'mt-4 h-[min(50vh,560px)] opacity-100' : 'mt-0 h-0 overflow-hidden opacity-0',
              tall ? 'lg:mt-0 lg:h-[calc(100vh-140px)] lg:max-h-[720px] lg:opacity-100' : 'lg:mt-0 lg:h-0 lg:max-h-0 lg:opacity-0',
              clip && 'overflow-hidden'
            )
      )}
    >
      {modal && (
        <div
          className={cn('flex h-8 shrink-0 cursor-move items-center border-b border-primaryStroke px-1', GRIP)}
          onPointerDown={(e) => press(e, 'move')}
          title="drag to move"
        >
          <button
            id="chat-modal-close"
            type="button"
            aria-label="close the chat"
            onClick={() => {
              setChatModalOpen(false);
              document.getElementById('chat-open')?.focus();
            }}
            className="ml-auto flex h-7 w-7 items-center justify-center text-lg leading-none text-textSecondary hover:text-primaryBlue"
          >
            ×
          </button>
        </div>
      )}
      {/* a fixed width, pinned to the outer edge, so the shrinking cell uncovers it from the video side instead of squashing the lines */}
      <div
        className={cn(
          'flex min-h-0 flex-col',
          modal
            ? 'min-h-0 w-full flex-1'
            : cn(
                'h-[min(50vh,560px)] w-full lg:absolute lg:top-0 lg:h-[min(720px,calc(100vh-140px))] lg:w-[360px]',
                'transition-transform duration-300 ease-out motion-reduce:transition-none',
                side === 'right' && 'lg:right-0',
                side === 'left' && 'lg:left-0',
                !open && side === 'right' && 'lg:translate-x-4',
                !open && side === 'left' && 'lg:-translate-x-4'
              )
        )}
      >
        {children}
      </div>
      {modal &&
        CORNERS.map((c) => (
          <div
            key={c.id}
            id={`chat-modal-resize-${c.id}`}
            aria-hidden
            onPointerDown={(e) => {
              e.stopPropagation();
              press(e, 'resize', c.sx, c.sy);
            }}
            className={cn('absolute z-10 h-4 w-4 border-primaryBlue opacity-0 transition-opacity duration-150 group-hover:opacity-100', GRIP, c.className)}
          />
        ))}
    </dialog>
  );
}

/** On the video: opens the chat, or closes it. A column slides out to its side; a window fades. */
export function ChatOpenButton({ className }: { className?: string }) {
  const open = useAtomValue(chatModalOpenAtom);
  return (
    <IconButton id="chat-open" label={open ? 'close the chat' : 'chat'} active={open} tipAt="above-right" className={className} onClick={() => setChatModalOpen(!open)}>
      <ChatIcon />
    </IconButton>
  );
}
