import { RiEmotionLine, RiMoreFill, RiReplyLine } from '@remixicon/react';
import {
  type HTMLAttributes,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from 'react';
import { createPortal } from 'react-dom';

import type { ChatStyle } from '@/infra/atoms/settings-atoms';
import { plainEmotes } from '@/infra/emotes';
import { Face } from '@/shared-components/Face';
import type { Reaction } from '@/shared-components/reaction-list';
import { ReactionPicker } from '@/shared-components/Reactions';
import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

export function stamp(at: number): string {
  return new Date(at).toLocaleString();
}

export function clock(at: number): string {
  if (!at) return '';
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

export function when(at: number): string {
  if (!at) return '';
  const then = new Date(at);
  const now = new Date();
  if (then.toDateString() === now.toDateString()) return clock(at);
  return then.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: then.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

const minuteOf = (at: number) => Math.floor(at / 60_000);

const RUN_MS = 5 * 60_000;

const GUTTER = 'w-8 shrink-0';

export interface Place {
  first: boolean;
  bucket: boolean;
}

export function placeOf(at: number, prevAt: number | undefined, same: boolean): Place {
  const first = prevAt === undefined || !same || at - prevAt > RUN_MS;
  return { first, bucket: first || prevAt === undefined || minuteOf(prevAt) !== minuteOf(at) };
}

function GutterClock({ at, shown, className }: { at: number; shown: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        GUTTER,
        'text-right text-[10px] leading-none tabular-nums text-textTertiary transition-opacity duration-150',
        !shown && 'opacity-0 group-hover/line:opacity-100',
        className
      )}
    >
      {clock(at)}
    </span>
  );
}

export interface ChatLineShapeProps extends Place {
  shape: ChatStyle;
  mine: boolean;
  at: number;
  name: string;
  who: ReactNode;
  face: ReactNode;
  faced?: boolean;
  crowd?: boolean;
  words: ReactNode | null;
  pictures?: ReactNode;
  attrs?: HTMLAttributes<HTMLParagraphElement> & Record<`data-${string}`, string | number | boolean | undefined>;
  mark?: ReactNode;
  actions?: ReactNode;
  quote?: ReactNode;
  reactions?: ReactNode;
  flash?: boolean;
  side?: ReactNode;
  pending?: 'sending' | 'failed';
}

const ACTIONS_HIDDEN =
  'pointer-events-none opacity-0 transition-opacity duration-150 focus-within:pointer-events-auto focus-within:opacity-100 [@media(hover:hover)]:group-hover/line:pointer-events-auto [@media(hover:hover)]:group-hover/line:opacity-100';
const ACTIONS_SHOWN = 'pointer-events-auto opacity-100';
const LONG_PRESS_MS = 450;
const PRESS_SLOP_PX = 10;
const GHOST_CLICK_MS = 600;

let closeOpenBar: (() => void) | null = null;

function useLongPress() {
  const [open, setOpen] = useState(false);
  const line = useRef<HTMLParagraphElement | null>(null);
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  const opened = useRef(0);
  const cancel = () => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
  };
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      const at = e.target;
      if (at instanceof Element && (line.current?.contains(at) || at.closest('[data-line-menu]'))) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [open]);
  useEffect(() => cancel, []);
  return {
    open,
    ref: line,
    handlers: {
      onPointerDown: (e: ReactPointerEvent<HTMLParagraphElement>) => {
        if (e.pointerType !== 'touch') return;
        cancel();
        const { clientX: x, clientY: y } = e;
        press.current = {
          x,
          y,
          timer: setTimeout(() => {
            press.current = null;
            opened.current = Date.now();
            closeOpenBar?.();
            closeOpenBar = () => setOpen(false);
            setOpen(true);
          }, LONG_PRESS_MS)
        };
      },
      onPointerMove: (e: ReactPointerEvent<HTMLParagraphElement>) => {
        const p = press.current;
        if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > PRESS_SLOP_PX) cancel();
      },
      onPointerUp: cancel,
      onClickCapture: (e: ReactMouseEvent<HTMLParagraphElement>) => {
        if (Date.now() - opened.current > GHOST_CLICK_MS) return;
        opened.current = 0;
        e.preventDefault();
        e.stopPropagation();
      },
      onPointerCancel: cancel,
      onContextMenu: (e: ReactMouseEvent<HTMLParagraphElement>) => {
        if (open || press.current) e.preventDefault();
      }
    }
  };
}

function Corner({ mark, actions, open }: { mark?: ReactNode; actions?: ReactNode; open: boolean }) {
  return (
    <>
      {actions && (
        <span
          data-line-actions
          className={cn(
            'absolute -top-3.5 right-2 z-10 flex items-center border border-primaryStroke bg-backgroundSecondary group-first/line:top-0',
            open ? ACTIONS_SHOWN : ACTIONS_HIDDEN
          )}
        >
          {actions}
        </span>
      )}
      {mark && <span className="absolute right-1 top-0 flex items-center">{mark}</span>}
    </>
  );
}

export const BAR_BUTTON =
  'flex h-7 w-7 items-center justify-center text-textSecondary hover:bg-primaryStroke/30 hover:text-textPrimary focus-visible:outline focus-visible:outline-1 focus-visible:outline-primaryBlue max-md:h-11 max-md:w-11';

function BarButton({ label, onClick, disabled, id, children }: { label: string; onClick?: () => void; disabled?: boolean; id: string; children: ReactNode }) {
  return (
    <Tooltip content={label}>
      <button
        type="button"
        aria-label={label}
        aria-disabled={disabled || undefined}
        data-line-action={id}
        onClick={disabled ? undefined : onClick}
        className={cn(BAR_BUTTON, disabled && 'cursor-default opacity-50 hover:bg-transparent hover:text-textSecondary')}
      >
        {children}
      </button>
    </Tooltip>
  );
}

export interface LineMenuItem {
  key: string;
  label: string;
  onPick: () => void;
  danger?: boolean;
  divider?: boolean;
}

function MoreMenu({ items }: { items: LineMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement | null>(null);
  const menu = useRef<HTMLUListElement | null>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);

  useLayoutEffect(() => {
    const el = menu.current;
    if (!open || !el) return;
    const place = () => {
      const a = button.current?.getBoundingClientRect();
      if (!a) return;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      el.style.left = `${Math.max(4, Math.min(a.right - w, document.documentElement.clientWidth - w - 4))}px`;
      el.style.top = `${a.bottom + h <= document.documentElement.clientHeight - 4 ? a.bottom : Math.max(4, a.top - h)}px`;
    };
    place();
    el.querySelector<HTMLButtonElement>('button')?.focus();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    const outside = (e: PointerEvent) => {
      if (e.target instanceof Node && (menu.current?.contains(e.target) || button.current?.contains(e.target))) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', outside, true);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
      document.removeEventListener('pointerdown', outside, true);
    };
  }, [open]);

  function walk(e: KeyboardEvent<HTMLUListElement>) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      button.current?.focus();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const rows = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
    const i = rows.indexOf(document.activeElement as HTMLButtonElement);
    rows[(i + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length]?.focus();
  }

  if (items.length === 0) return null;
  return (
    <>
      <Tooltip content={open ? null : 'more'}>
        <button
          ref={button}
          type="button"
          aria-label="more"
          aria-haspopup="menu"
          aria-expanded={open}
          data-line-action="more"
          onClick={() => {
            setHost(button.current?.closest<HTMLElement>('dialog:modal') ?? document.body);
            setOpen((was) => !was);
          }}
          className={BAR_BUTTON}
        >
          <RiMoreFill aria-hidden size={16} />
        </button>
      </Tooltip>
      {open &&
        host &&
        createPortal(
          <ul
            ref={menu}
            role="menu"
            aria-label="more"
            data-line-menu
            onKeyDown={walk}
            onBlur={(e) => {
              const to = e.relatedTarget;
              if (to instanceof Node && (menu.current?.contains(to) || button.current === to)) return;
              setOpen(false);
            }}
            className="fixed left-0 top-0 z-[60] flex min-w-32 flex-col border border-primaryStroke bg-backgroundSecondary py-1 text-sm"
          >
            {items.map((item) => (
              <li key={item.key} role="none" className={item.divider ? 'mt-1 border-t border-primaryStroke pt-1' : undefined}>
                <button
                  role="menuitem"
                  type="button"
                  data-pick={item.key}
                  className={cn(
                    'flex w-full items-center px-3 py-1 text-left hover:bg-primaryStroke/20 focus-visible:bg-primaryStroke/20 focus-visible:outline-none max-md:min-h-11',
                    item.danger ? 'text-decrease' : 'text-textPrimary'
                  )}
                  onClick={() => {
                    setOpen(false);
                    item.onPick();
                  }}
                >
                  {item.label}
                </button>
              </li>
            ))}
          </ul>,
          host
        )}
    </>
  );
}

export function LineActions({
  onReact,
  reactions = [],
  me,
  reactOff,
  onReply,
  extra,
  text,
  menu = []
}: {
  onReact?: (emoji: string) => void;
  reactions?: readonly Reaction[];
  me?: string | null;
  reactOff?: string;
  onReply?: () => void;
  extra?: ReactNode;
  text?: string;
  menu?: LineMenuItem[];
}) {
  const items: LineMenuItem[] = [];
  if (onReply) items.push({ key: 'reply', label: 'reply', onPick: onReply });
  if (text) items.push({ key: 'copy', label: 'copy text', onPick: () => void navigator.clipboard?.writeText(plainEmotes(text)).catch(() => undefined) });
  items.push(...menu);
  return (
    <>
      {onReact ? (
        <ReactionPicker id="react" reactions={reactions} me={me} onPick={onReact} className={BAR_BUTTON} />
      ) : (
        reactOff && (
          <BarButton id="react" label={reactOff} disabled>
            <RiEmotionLine aria-hidden size={16} />
          </BarButton>
        )
      )}
      {onReply && (
        <BarButton id="reply" label="reply" onClick={onReply}>
          <RiReplyLine aria-hidden size={16} />
        </BarButton>
      )}
      {extra}
      <MoreMenu items={items} />
    </>
  );
}

export interface Quoted {
  from: string;
  text: string;
  avatar: number | null;
  images: number;
  video?: boolean;
  gone?: boolean;
}

export function quoteWords(q: Pick<Quoted, 'text' | 'images' | 'video'>): string {
  if (q.text) return plainEmotes(q.text).replace(/\s+/g, ' ');
  if (q.video && q.images === 0) return 'a video';
  if (q.images > 1) return `${q.images} pictures`;
  if (q.images === 1) return 'a picture';
  return '';
}

export function ReplyQuote({ shape, quote, onJump, color }: { shape: ChatStyle; quote: Quoted; onJump?: () => void; color?: string }) {
  const words = quoteWords(quote);
  const body = quote.gone ? (
    <span className="truncate italic text-textTertiary">original message was deleted</span>
  ) : (
    <>
      <Face name={quote.from} version={quote.avatar} className="h-4 w-4 shrink-0 text-[9px]" />
      <span className={cn('shrink-0 font-semibold', !color && 'text-textPrimary')} style={color ? { color } : undefined}>
        {quote.from}
      </span>
      <span className="min-w-0 truncate text-textSecondary">{words}</span>
    </>
  );
  const inner =
    onJump && !quote.gone ? (
      <button
        type="button"
        aria-label={`go to ${quote.from}'s line: ${words}`}
        onClick={onJump}
        className="flex min-w-0 items-center gap-1 text-left focus-visible:outline focus-visible:outline-1 focus-visible:outline-primaryBlue [&:hover>span:last-child]:text-textPrimary"
      >
        {body}
      </button>
    ) : (
      <span className="flex min-w-0 items-center gap-1">{body}</span>
    );
  if (shape === 'bubbles') {
    return (
      <span data-reply-quote className="mb-1 flex min-w-0 border-l-2 border-primaryStroke pl-1.5 text-xs leading-4">
        {inner}
      </span>
    );
  }
  return (
    <span data-reply-quote className="flex min-w-0 items-stretch text-xs leading-4">
      <span aria-hidden className={cn('ml-4 mt-2 shrink-0 rounded-tl-md border-l-2 border-t-2 border-primaryStroke', shape === 'blocks' ? 'w-6' : 'w-5')} />
      <span className="ml-1 flex min-w-0 pb-0.5">{inner}</span>
    </span>
  );
}

function Side({ side }: { side?: ReactNode }) {
  if (!side) return null;
  return <span className="flex shrink-0 flex-col self-start border border-primaryStroke bg-backgroundSecondary">{side}</span>;
}

export function ChatLineShape({
  shape,
  mine,
  at,
  name,
  who,
  face,
  faced = false,
  crowd = false,
  first,
  bucket,
  words,
  pictures,
  attrs,
  mark,
  actions,
  quote,
  reactions,
  flash = false,
  side,
  pending
}: ChatLineShapeProps) {
  const title = at ? stamp(at) : undefined;
  const press = useLongPress();
  const corner = <Corner mark={mark} actions={actions} open={press.open} />;
  const lineBox = cn(
    'group/line relative transition-colors duration-700',
    actions && '[-webkit-touch-callout:none] [@media(hover:hover)]:hover:bg-primaryStroke/10 [@media(hover:none)]:select-none',
    mark && 'pr-8',
    pending === 'sending' && 'opacity-50',
    pending === 'failed' && 'opacity-70',
    flash ? 'bg-primaryBlue/15 duration-150' : press.open && 'bg-primaryStroke/15'
  );
  const p = (className: string, children: ReactNode) => (
    <p {...attrs} {...(actions ? press.handlers : {})} ref={press.ref} title={title} data-flash={flash || undefined} className={cn(lineBox, className)}>
      {children}
      {corner}
    </p>
  );
  const over = (row: string, children: ReactNode) =>
    quote ? (
      <>
        {quote}
        <span className={row}>{children}</span>
      </>
    ) : (
      children
    );
  if (shape === 'log') {
    const row = 'flex items-baseline gap-2';
    return p(
      cn('leading-snug', quote ? 'flex flex-col' : row),
      over(
        row,
        <>
          <span className="shrink-0 text-xs tabular-nums text-textTertiary">{clock(at)}</span>
          {faced && <span className="shrink-0 self-start">{face}</span>}
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
            <span className="mr-1.5">{who}</span>
            {words}
            {pictures}
            {reactions}
          </span>
          <Side side={side} />
        </>
      )
    );
  }
  if (shape === 'blocks') {
    const head = first || !!quote;
    const row = 'flex gap-2';
    return p(
      cn('leading-snug', head && 'mt-1 first:mt-0', quote ? 'flex flex-col' : row),
      over(
        row,
        <>
          {head ? <span className={cn(GUTTER, 'mt-0.5')}>{face}</span> : <GutterClock at={at} shown={bucket} className="pt-0.5" />}
          <span className="flex min-w-0 flex-1 flex-col [overflow-wrap:anywhere]">
            {head && (
              <span className="flex items-baseline gap-2">
                <span className="min-w-0 truncate">{who}</span>
                <span className="shrink-0 text-xs tabular-nums text-textTertiary">{clock(at)}</span>
              </span>
            )}
            {words}
            {pictures}
            {reactions}
          </span>
          <Side side={side} />
        </>
      )
    );
  }
  const named = crowd && !mine && first;
  return p(
    cn('flex gap-2 leading-snug', bucket && 'mt-2 first:mt-0'),
    <>
      {faced && first ? <span className={cn(GUTTER, 'mt-0.5')}>{face}</span> : <GutterClock at={at} shown={bucket} className="pt-2.5" />}
      <span className={cn('flex min-w-0 flex-1 flex-col', mine ? 'items-end' : 'items-start')}>
        <span
          data-bubble
          className={cn(
            'relative flex max-w-[85%] flex-col border px-2.5 py-1.5 [overflow-wrap:anywhere]',
            mine ? 'border-primaryBlue bg-primaryBlue/10' : 'border-primaryStroke bg-backgroundTertiary'
          )}
        >
          {named ? <span className="mb-0.5 flex min-w-0 items-baseline text-sm">{who}</span> : <span className="sr-only">{mine ? 'you' : name}: </span>}
          {quote}
          {words}
          {pictures}
        </span>
        {reactions}
      </span>
      <Side side={side} />
    </>
  );
}
