import { RiEmotionLine, RiMoreFill, RiReplyLine } from '@remixicon/react';
import {
  type CSSProperties,
  type HTMLAttributes,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState
} from 'react';

import type { ChatStyle } from '@/infra/atoms/settings-atoms';
import { bubbleCorners, type Nook, nookOf } from '@/infra/bubble-run';
import { plainEmotes } from '@/infra/emotes';
import { Face } from '@/shared-components/Face';
import { MenuButton, type MenuItem } from '@/shared-components/MenuButton';
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

function Stamp({ at, children }: { at: number; children: ReactNode }) {
  return <Tooltip content={at ? stamp(at) : null}>{children}</Tooltip>;
}

function GutterClock({ at, shown, className }: { at: number; shown: boolean; className?: string }) {
  return (
    <Stamp at={at}>
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
    </Stamp>
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
  tail?: ReactNode;
  pending?: 'sending' | 'failed';
  bare?: boolean;
  firstInList?: boolean;
  last?: boolean;
}

const ACTIONS_HIDDEN =
  'pointer-events-none opacity-0 transition-opacity duration-150 focus-within:pointer-events-auto focus-within:opacity-100 [@media(hover:hover)]:group-hover/line:pointer-events-auto [@media(hover:hover)]:group-hover/line:opacity-100 [@media(hover:hover)]:[:has([data-mention]:hover)_&]:!pointer-events-none [@media(hover:hover)]:[:has([data-mention]:hover)_&]:!opacity-0';
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

function underMention(bar: Element, x: number, y: number) {
  return document.elementsFromPoint(x, y).some((el) => !bar.contains(el) && !!el.closest('[data-mention]'));
}

function Corner({ mark, actions, open, firstInList, nook }: { mark?: ReactNode; actions?: ReactNode; open: boolean; firstInList?: boolean; nook?: Nook | null }) {
  const top = nook ? '-translate-y-1/2' : firstInList === undefined ? 'right-2 -top-3.5 group-first/line:top-0' : firstInList ? 'right-2 top-0' : 'right-2 -top-3.5';
  const at: CSSProperties | undefined = nook ? { left: nook.left, right: nook.right, top: nook.top } : undefined;
  const [yielding, setYielding] = useState(false);
  useEffect(() => {
    if (!yielding) return;
    const done = () => setYielding(false);
    const id = requestAnimationFrame(() => window.addEventListener('pointermove', done, { once: true, passive: true }));
    return () => {
      cancelAnimationFrame(id);
      window.removeEventListener('pointermove', done);
    };
  }, [yielding]);
  const yieldToMention = (e: ReactPointerEvent<HTMLSpanElement>) => {
    if (open || yielding || e.pointerType !== 'mouse') return;
    if (underMention(e.currentTarget, e.clientX, e.clientY)) setYielding(true);
  };
  return (
    <>
      {actions && (
        <span
          data-line-actions
          onPointerMove={yieldToMention}
          style={at}
          className={cn(
            'absolute z-10 flex items-center overflow-hidden rounded-control border border-primaryStroke bg-backgroundSecondary',
            top,
            open ? ACTIONS_SHOWN : ACTIONS_HIDDEN,
            yielding && '!pointer-events-none !opacity-0'
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
  'flex h-7 w-7 items-center justify-center rounded-control text-textSecondary hover:bg-primaryStroke/30 hover:text-textPrimary focus-visible:outline focus-visible:outline-1 focus-visible:outline-primaryBlue max-md:h-11 max-md:w-11';

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

export type LineMenuItem = MenuItem;

function MoreMenu({ items }: { items: LineMenuItem[] }) {
  return (
    <MenuButton label="more" items={items} className={BAR_BUTTON} buttonAttrs={{ 'data-line-action': 'more' }} menuAttrs={{ 'data-line-menu': true }}>
      <RiMoreFill aria-hidden size={16} />
    </MenuButton>
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
  audio?: boolean;
  gone?: boolean;
}

export function quoteWords(q: Pick<Quoted, 'text' | 'images' | 'video' | 'audio'>): string {
  if (q.text) return plainEmotes(q.text).replace(/\s+/g, ' ');
  if (q.video && q.images === 0) return 'a video';
  if (q.audio && q.images === 0) return 'a voice message';
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
      <span
        aria-hidden
        className={cn('ml-4 mt-2 shrink-0 border-l-2 border-t-2 border-primaryStroke soft:rounded-tl-[6px] bubble:rounded-tl-[8px]', shape === 'blocks' ? 'w-6' : 'w-5')}
      />
      <span className="ml-1 flex min-w-0 pb-0.5">{inner}</span>
    </span>
  );
}

function Side({ side }: { side?: ReactNode }) {
  if (!side) return null;
  return <span className="flex shrink-0 flex-col self-start overflow-hidden rounded-card border border-primaryStroke bg-backgroundSecondary">{side}</span>;
}

function Tail({ tail }: { tail?: ReactNode }) {
  if (!tail) return null;
  return <span className="flex shrink-0 self-start pt-0.5">{tail}</span>;
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
  tail,
  pending,
  bare = false,
  firstInList,
  last = true
}: ChatLineShapeProps) {
  const title = at ? stamp(at) : undefined;
  const press = useLongPress();
  const [nook, setNook] = useState<Nook | null>(null);
  const hug = shape === 'bubbles' && !!mark;
  const nestle = () => {
    const line = press.ref.current;
    const bubble = line?.querySelector<HTMLElement>('[data-bubble]');
    const lane = line?.querySelector<HTMLElement>('[data-bubble-lane]');
    const bar = line?.querySelector<HTMLElement>('[data-line-actions]');
    if (!line || !bubble || !lane || !bar || line.ownerDocument.documentElement.dataset.shape !== 'bubble') {
      setNook(null);
      return;
    }
    const b = bubble.getBoundingClientRect();
    const m = lane.querySelector<HTMLElement>('[data-bubble-mark]')?.getBoundingClientRect();
    const reach = m && m.width > 0 ? { left: Math.min(b.left, m.left), right: Math.max(b.right, m.right), top: b.top, bottom: b.bottom } : b;
    setNook(nookOf(line.getBoundingClientRect(), lane.getBoundingClientRect(), reach, b, bar.offsetWidth, mine));
  };
  const nestles = !!actions && shape === 'bubbles';
  const corner = <Corner mark={hug ? undefined : mark} actions={actions} open={press.open} firstInList={firstInList} nook={nestles ? nook : null} />;
  const lineBox = cn(
    'group/line relative transition-colors duration-700',
    actions && '[-webkit-touch-callout:none] [@media(hover:hover)]:hover:bg-primaryStroke/10 [@media(hover:none)]:select-none',
    mark && !hug && 'pr-8',
    pending === 'sending' && 'opacity-50',
    pending === 'failed' && 'opacity-70',
    flash ? 'bg-primaryBlue/15 duration-150' : press.open && 'bg-primaryStroke/15'
  );
  const p = (className: string, children: ReactNode) => (
    <p
      {...attrs}
      {...(actions ? press.handlers : {})}
      onPointerEnter={nestles ? nestle : undefined}
      onFocus={nestles ? nestle : undefined}
      ref={press.ref}
      aria-description={title}
      data-flash={flash || undefined}
      className={cn(lineBox, className)}
    >
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
          <Stamp at={at}>
            <span className="shrink-0 text-xs tabular-nums text-textTertiary">{clock(at)}</span>
          </Stamp>
          {faced && <span className="shrink-0 self-start">{face}</span>}
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
            <span className="mr-1.5">{who}</span>
            {words}
            {pictures}
            {reactions}
          </span>
          <Side side={side} />
          <Tail tail={tail} />
        </>
      )
    );
  }
  if (shape === 'blocks') {
    const head = first || !!quote;
    const row = 'flex gap-2';
    return p(
      cn('leading-snug', head && !bare && 'mt-1 first:mt-0', quote ? 'flex flex-col' : row),
      over(
        row,
        <>
          {head ? <span className={cn(GUTTER, 'mt-0.5')}>{face}</span> : <GutterClock at={at} shown={bucket} className="pt-0.5" />}
          <span className="flex min-w-0 flex-1 flex-col [overflow-wrap:anywhere]">
            {head && (
              <span className="flex items-baseline gap-2">
                <span className="min-w-0 truncate">{who}</span>
                <Stamp at={at}>
                  <span className="shrink-0 text-xs tabular-nums text-textTertiary">{clock(at)}</span>
                </Stamp>
              </span>
            )}
            {words}
            {pictures}
            {reactions}
          </span>
          <Side side={side} />
          <Tail tail={tail} />
        </>
      )
    );
  }
  const named = crowd && first;
  const bubble = (
    <span
      data-bubble
      className={cn(
        'relative flex flex-col rounded-bubble border px-2.5 py-[3px] [overflow-wrap:anywhere] bubble:border-0',
        hug ? 'max-w-[calc(85%-20px)] bubble:max-w-[min(calc(85%-20px),calc(100%-7.25rem))]' : 'max-w-[85%] bubble:max-w-[min(85%,calc(100%-6rem))]',
        mine ? 'border-primaryBlue bg-primaryBlue/10 bubble:bg-primaryBlue/15' : 'border-primaryStroke bg-backgroundTertiary',
        bubbleCorners(first, last, mine)
      )}
    >
      {named ? (
        <span className={cn('flex min-w-0 items-baseline text-sm leading-4', mine && 'justify-end')}>{who}</span>
      ) : (
        <span className="sr-only">{mine ? 'you' : name}: </span>
      )}
      {quote}
      {words}
      {pictures}
    </span>
  );
  return p(
    cn('flex gap-2 leading-tight', bucket && !bare && 'mt-1 first:mt-0', bucket && !bare && !first && 'bubble:mt-0'),
    <>
      {faced && first ? (
        <span className={cn(GUTTER, 'mt-0.5')}>{face}</span>
      ) : (
        <GutterClock at={at} shown={bucket} className={cn('pt-[5px]', !first && 'bubble:opacity-0 bubble:group-hover/line:opacity-100')} />
      )}
      <span data-bubble-lane className={cn('flex min-w-0 flex-1 flex-col', mine ? 'items-end' : 'items-start')}>
        {hug ? (
          <span className={cn('flex w-full items-start gap-1.5', mine ? 'justify-end' : 'justify-start')}>
            {mine && (
              <span data-bubble-mark className="flex pt-1">
                {mark}
              </span>
            )}
            {bubble}
            {!mine && (
              <span data-bubble-mark className="flex pt-1">
                {mark}
              </span>
            )}
          </span>
        ) : (
          bubble
        )}
        {reactions}
      </span>
      <Side side={side} />
      <Tail tail={tail} />
    </>
  );
}
