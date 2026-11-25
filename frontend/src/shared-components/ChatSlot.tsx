import { RiContrastDrop2Line } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import {
  createContext,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from 'react';

import { type ChatBox as Box, keepStreamBox, keptStreamBox } from '@/infra/atoms/chat-layout-atoms';
import { chatClearAtom, type ChatSide, chatModalOpenAtom, chatSideAtom, setChatClear, setChatModalOpen } from '@/infra/atoms/settings-atoms';
import { MOBILE_QUERY, useIsMobile } from '@/infra/mobile';
import { store } from '@/infra/store';
import { raiseWindow } from '@/infra/window-stack';
import { Tooltip } from '@/shared-components/Tooltip';
import { useStackedWindow } from '@/shared-components/useStackedWindow';
import { ChatIcon, IconButton } from '@/shared-components/VideoControls';
import { cn } from '@/utils/cn';

function settingsOpen(): boolean {
  const el = document.getElementById('user-modal');
  return el instanceof HTMLDialogElement && el.open;
}

const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const WINDOW_MS = 200;
const COLUMN_MS = 300;

const GRIP = 'touch-none select-none [-webkit-touch-callout:none]';
const MIN_W = 280;
const MIN_H = 320;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const room = () => ({ w: document.documentElement.clientWidth, h: document.documentElement.clientHeight });

function moved(rect: DOMRect, dx: number, dy: number): Box {
  const r = room();
  return {
    x: clamp(rect.left + dx, 0, Math.max(0, r.w - rect.width)),
    y: clamp(rect.top + dy, 0, Math.max(0, r.h - rect.height)),
    w: rect.width,
    h: rect.height
  };
}

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

function fitted(box: Box): Box {
  const r = room();
  const w = Math.min(Math.max(box.w, MIN_W), r.w);
  const h = Math.min(Math.max(box.h, MIN_H), r.h);
  return { w, h, x: clamp(box.x, 0, Math.max(0, r.w - w)), y: clamp(box.y, 0, Math.max(0, r.h - h)) };
}

interface ChatWindowBar {
  grip: (e: ReactPointerEvent) => void;
  clear: ReactNode;
  close: ReactNode;
}

const BAR_BUTTON = '-my-1 flex h-7 w-7 shrink-0 items-center justify-center text-textSecondary hover:text-primaryBlue';

const ChatWindowContext = createContext<ChatWindowBar | null>(null);

export function useChatWindowBar(): ChatWindowBar | null {
  return useContext(ChatWindowContext);
}

export const CHAT_GRIP = GRIP;

export function useChatSide(): ChatSide {
  const side = useAtomValue(chatSideAtom);
  return useIsMobile() && side === 'modal' ? 'right' : side;
}

const windowNow = () => store.get(chatSideAtom) === 'modal' && !window.matchMedia(MOBILE_QUERY).matches;

const CORNERS = [
  { id: 'nw', sx: -1, sy: -1, className: '-left-px -top-px cursor-nwse-resize border-l-2 border-t-2' },
  { id: 'ne', sx: 1, sy: -1, className: '-right-px -top-px cursor-nesw-resize border-r-2 border-t-2' },
  { id: 'sw', sx: -1, sy: 1, className: '-bottom-px -left-px cursor-nesw-resize border-b-2 border-l-2' },
  { id: 'se', sx: 1, sy: 1, className: '-bottom-px -right-px cursor-nwse-resize border-b-2 border-r-2' }
] as const;

const OPEN_COLUMNS = {
  right: { fixed: 'beside:grid-cols-[minmax(0,1fr)_360px]', fluid: 'beside:grid-cols-[minmax(0,1fr)_340px]' },
  left: { fixed: 'beside:grid-cols-[360px_minmax(0,1fr)]', fluid: 'beside:grid-cols-[340px_minmax(0,1fr)]' }
} as const;

export function chatLayoutClass(side: ChatSide, open: boolean, fluid = false): string {
  if (side !== 'left' && side !== 'right') return '';
  return cn(
    'beside:grid beside:grid-rows-[auto_1fr] beside:items-start beside:transition-[grid-template-columns,column-gap] beside:duration-300 beside:ease-out motion-reduce:beside:transition-none',
    open ? (fluid ? 'beside:gap-x-3 bubble:beside:gap-x-1' : 'beside:gap-x-6 bubble:beside:gap-x-2') : 'beside:gap-x-0',
    open ? OPEN_COLUMNS[side][fluid ? 'fluid' : 'fixed'] : side === 'right' ? 'beside:grid-cols-[minmax(0,1fr)_0px]' : 'beside:grid-cols-[0px_minmax(0,1fr)]'
  );
}

export function ChatSlot({ tabbed = false, fluid = false, children }: { tabbed?: boolean; fluid?: boolean; children: ReactNode }) {
  const side = useChatSide();
  const open = useAtomValue(chatModalOpenAtom) || (tabbed && side !== 'modal');
  const ref = useRef<HTMLDialogElement | null>(null);
  const leaving = useRef(false);
  const stop = useRef<(() => void) | null>(null);
  const skipOpenClip = useRef(true);
  const modal = side === 'modal';
  const clear = useAtomValue(chatClearAtom) && modal;
  const [box, setBox] = useState<Box | null>(() => {
    const kept = keptStreamBox();
    return kept && fitted(kept);
  });
  const [shown, setShown] = useState(false);
  const [held, setHeld] = useState(open);
  const [clip, setClip] = useState(false);

  useStackedWindow(ref, 'chat', modal);

  useEffect(() => {
    keepStreamBox(box);
  }, [box]);

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

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!tabbed || modal || !dialog) return;
    const measure = () => dialog.style.setProperty('--chat-top', `${dialog.getBoundingClientRect().top + window.scrollY}px`);
    measure();
    const watcher = new ResizeObserver(measure);
    watcher.observe(document.body);
    window.addEventListener('resize', measure);
    return () => {
      watcher.disconnect();
      window.removeEventListener('resize', measure);
      dialog.style.removeProperty('--chat-top');
    };
  }, [tabbed, modal]);

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
    raiseWindow('chat');
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

  useEffect(() => {
    const onClose = (e: Event) => {
      if (!(e.target instanceof Element) || e.target.id !== 'user-modal') return;
      const dialog = ref.current;
      if (!dialog || dialog.open || settingsOpen()) return;
      if (!windowNow() || !store.get(chatModalOpenAtom)) return;
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

  useLayoutEffect(() => {
    const dialog = ref.current;
    return () => {
      leaving.current = true;
      stop.current?.();
      if (dialog?.open) dialog.close();
    };
  }, []);

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
  const fromLeft = box !== null && box.x + box.w / 2 < room().w / 2;
  const style: CSSProperties | undefined = modal && box ? { left: box.x, top: box.y, width: box.w, height: box.h } : undefined;

  const bar: ChatWindowBar | null = modal
    ? {
        grip: (e) => press(e, 'move'),
        clear: (
          <Tooltip content={clear ? 'see-through' : 'solid'}>
            <button
              id="chat-modal-clear"
              type="button"
              aria-label="see-through"
              aria-pressed={clear}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => setChatClear(!clear)}
              className={cn(BAR_BUTTON, clear && 'text-primaryBlue')}
            >
              <RiContrastDrop2Line aria-hidden size={16} />
            </button>
          </Tooltip>
        ),
        close: (
          <button
            id="chat-modal-close"
            ref={(el) => el?.setAttribute('autofocus', '')}
            type="button"
            aria-label="close the chat"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => {
              setChatModalOpen(false);
              document.getElementById('chat-open')?.focus();
            }}
            className={cn(BAR_BUTTON, 'text-lg leading-none')}
          >
            ×
          </button>
        )
      }
    : null;

  return (
    <dialog
      ref={ref}
      id="chat-modal"
      aria-label="chat"
      inert={!open ? true : undefined}
      role={modal ? undefined : 'presentation'}
      onClose={() => {
        if (leaving.current) return;
        if (windowNow()) setChatModalOpen(false);
      }}
      style={style}
      className={cn(
        modal
          ? cn(
      'group fixed m-0 hidden max-h-none max-w-none flex-col overflow-hidden border border-primaryStroke md:rounded-panel bg-backgroundSecondary p-0 text-base text-textPrimary open:flex',
              'origin-center transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none',
              shown ? 'translate-x-0 scale-100 opacity-100' : cn('pointer-events-none scale-[0.98] opacity-0', fromLeft ? '-translate-x-3' : 'translate-x-3'),
              clear && 'chat-clear',
              !box && 'left-auto right-6 top-20 h-[min(720px,calc(100dvh-6rem))] w-[min(420px,calc(100vw-3rem))]'
            )
          : cn(
              'static m-0 flex w-full min-h-0 min-w-0 max-w-none flex-col border-0 bg-transparent p-0 text-textPrimary [&:not([open])]:flex',
              'transition-[height,margin-top,opacity] duration-300 ease-out motion-reduce:transition-none beside:relative beside:transition-none',
              'beside:row-span-2',
              side === 'left' && 'beside:col-start-1 beside:row-start-1',
              side === 'right' && 'beside:col-start-2 beside:row-start-1',
              tabbed
                ? 'mt-4 h-[calc(100dvh-var(--chat-top,0px)-2.5rem)] min-h-60 transition-none'
                : open
                  ? 'mt-4 h-[min(50vh,560px)] opacity-100'
                  : 'mt-0 h-0 overflow-hidden opacity-0',
              tall
                ? fluid
                  ? 'beside:mt-0 beside:h-[max(420px,calc(100dvh-var(--page-top,100px)-2.5rem))] beside:opacity-100'
                  : 'beside:mt-0 beside:h-[min(720px,calc(100dvh-var(--page-top,100px)-2.5rem))] beside:max-h-[720px] beside:opacity-100'
                : 'beside:mt-0 beside:h-0 beside:max-h-0 beside:opacity-0',
              clip && 'overflow-hidden'
            )
      )}
    >
      <div
        className={cn(
          'flex min-h-0 flex-col',
          modal
            ? 'min-h-0 w-full flex-1'
            : cn(
                tabbed ? 'h-full' : 'h-[min(50vh,560px)]',
                fluid
                  ? 'w-full beside:absolute beside:top-0 beside:h-[max(420px,calc(100dvh-var(--page-top,100px)-2.5rem))] beside:w-[340px]'
                  : 'w-full beside:absolute beside:top-0 beside:h-[min(720px,calc(100dvh-var(--page-top,100px)-2.5rem))] beside:w-[360px]',
                'transition-transform duration-300 ease-out motion-reduce:transition-none',
                side === 'right' && 'beside:right-0',
                side === 'left' && 'beside:left-0',
                !open && side === 'right' && 'beside:translate-x-4',
                !open && side === 'left' && 'beside:-translate-x-4'
              )
        )}
      >
        <ChatWindowContext.Provider value={bar}>{children}</ChatWindowContext.Provider>
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

export function ChatOpenButton({ className }: { className?: string }) {
  const open = useAtomValue(chatModalOpenAtom);
  return (
    <IconButton id="chat-open" label={open ? 'close the chat' : 'chat'} active={open} tipAt="above-right" className={className} onClick={() => setChatModalOpen(!open)}>
      <ChatIcon />
    </IconButton>
  );
}
