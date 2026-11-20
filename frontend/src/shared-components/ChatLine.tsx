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
import { Face } from '@/shared-components/Face';
import type { Reaction } from '@/shared-components/reaction-list';
import { ReactionPicker } from '@/shared-components/Reactions';
import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

/** The clock of a line in full, in the browser's own words: its title. */
export function stamp(at: number): string {
  return new Date(at).toLocaleString();
}

/**
 * The clock of a line, short, where a shape shows it: `HH:MM`, the hours of the day the way a
 * log keeps them, so every time is five characters and the column at the left of the lines
 * stays one width. A line with no time on it shows none; the full stamp is the line's title.
 */
export function clock(at: number): string {
  if (!at) return '';
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

/**
 * The clock of a search hit, short: the time for a line said today, the day for an older one
 * (`8 Nov`, and the year with it when it is not this one), since hits reach back through the
 * whole room where the lines on screen are a stretch of one evening. The full stamp is the title.
 */
export function when(at: number): string {
  if (!at) return '';
  const then = new Date(at);
  const now = new Date();
  if (then.toDateString() === now.toDateString()) return clock(at);
  return then.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: then.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

/** The minute a line fell in. Lines of one person in one minute are a bucket: one time at the left for all of them. */
const minuteOf = (at: number) => Math.floor(at / 60_000);

/** Lines from one person closer together than this are a run: one head over them in `blocks`, one name on them in a room's `bubbles`. */
const RUN_MS = 5 * 60_000;

/** The gutter at the left of the lines: a face wide (`blocks` puts the face in it). */
const GUTTER = 'w-8 shrink-0';

/** Where a line stands in its run and its minute, from the line before it on screen (`placeOf`). */
export interface Place {
  /** The first of a run (`RUN_MS`): `blocks` puts the head on it, a room's `bubbles` the name. */
  first: boolean;
  /** The first of a minute bucket (the run's first, or the minute turned): the time shows at the left, and the room before it. */
  bucket: boolean;
}

/** A line's place after the line before it on screen: `prevAt` its time (none for the first on screen), `same` whether the two are one person's. */
export function placeOf(at: number, prevAt: number | undefined, same: boolean): Place {
  const first = prevAt === undefined || !same || at - prevAt > RUN_MS;
  return { first, bucket: first || prevAt === undefined || minuteOf(prevAt) !== minuteOf(at) };
}

/**
 * The time in the gutter at the left of a line, `bubbles` and `blocks`. Shown on the first line
 * of a minute (`shown`), and on the rest of that minute's lines while the line is pointed at,
 * so a burst of lines says its time once and any one line can still be asked. A reader has the
 * stamp in the title.
 */
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
  /** This browser's own line: the blue side in `bubbles`. */
  mine: boolean;
  /** Unix ms on the line, for the clock and the title. 0 is none. */
  at: number;
  /** The writer's name as words, for a reader where the shape draws no name. */
  name: string;
  /** The writer as drawn beside or over the words: a room's speaker in their colour with their marks, a thread's name (yours in blue). */
  who: ReactNode;
  /** The writer's face, a gutter wide (`h-8 w-8`), for the head of a run in `blocks`. */
  face: ReactNode;
  /** The face in every shape, not `blocks` alone: a phone's chat with a friend (FriendChat.tsx). `log` puts it before the name on every line (sized by the caller), `bubbles` in the gutter at the head of a run. */
  faced?: boolean;
  /** A room: the left side of `bubbles` is everyone else, so a box that is not yours wears the name on the first of a run. A thread's two sides say who. */
  crowd?: boolean;
  /** The words, wrapped as the caller likes; null for a line of pictures alone. */
  words: ReactNode | null;
  pictures?: ReactNode;
  /** The `<p>`'s own attributes: `data-id` and the rest the pages and the tests key on. */
  attrs?: HTMLAttributes<HTMLParagraphElement> & Record<`data-${string}`, string | number | boolean | undefined>;
  /** A mark that always shows at the line's top right: a group line's pin (ServerRoom.tsx). */
  mark?: ReactNode;
  /** The action bar (`LineActions`), floating at the line's top right with the pointer on the line or the focus in it; on a screen with no hover, after a long press on the line. */
  actions?: ReactNode;
  /** What the line answers (`ReplyQuote`), over it: the spine and the quote in `log` and `blocks`, the quote at the top of the box in `bubbles`. */
  quote?: ReactNode;
  /** The line's reaction chips (Reactions.tsx `ReactionChips`), under the words and the pictures; under the box in `bubbles`. */
  reactions?: ReactNode;
  /** The line was just jumped to (a reply's quote clicked): it lights up for a moment. */
  flash?: boolean;
}

/** The action bar while it waits: up with the pointer on the line or the keyboard in it. Not clickable while unseen, so a tap on a phone does not land on it. */
const ACTIONS_HIDDEN =
  'pointer-events-none opacity-0 transition-opacity duration-150 focus-within:pointer-events-auto focus-within:opacity-100 [@media(hover:hover)]:group-hover/line:pointer-events-auto [@media(hover:hover)]:group-hover/line:opacity-100';
/** The action bar a long press opened (a phone): up until a press somewhere else. */
const ACTIONS_SHOWN = 'pointer-events-auto opacity-100';
/** How long a finger rests on a line before its action bar comes up: the phone's way to point at a line. */
const LONG_PRESS_MS = 450;
/** A finger that moves this far is scrolling, not pressing. */
const PRESS_SLOP_PX = 10;
/** The click a lifted finger makes after a long press: it would land on the bar just come up under it (the smiley opening the picker). Swallowed for this long. */
const GHOST_CLICK_MS = 600;

/**
 * The bar a long press opened, if any: one line's at a time, so the next press closes the last.
 * Its close is held here rather than in an atom, so every line on screen does not draw again for it.
 */
let closeOpenBar: (() => void) | null = null;

/**
 * A line's touch: a finger held still on it for `LONG_PRESS_MS` opens its action bar (the phone's
 * hover), and a press anywhere outside the line (or its `more` menu) closes it again. The pointer
 * and the keyboard need none of this: the bar is the hover's and the focus's.
 */
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
      // the bar's menu is drawn into the body: a press in it is the bar's own
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
      // the finger that held the line lifts: its click is the press's, not a pick on the bar
      onClickCapture: (e: ReactMouseEvent<HTMLParagraphElement>) => {
        if (Date.now() - opened.current > GHOST_CLICK_MS) return;
        opened.current = 0;
        e.preventDefault();
        e.stopPropagation();
      },
      onPointerCancel: cancel,
      // the phone's own long press menu (copy, look up) would come up over the bar
      onContextMenu: (e: ReactMouseEvent<HTMLParagraphElement>) => {
        if (open || press.current) e.preventDefault();
      }
    }
  };
}

/** The line's top right corner: the action bar floating over the line's top edge, and the mark (a pin) on the line itself (the `<p>` is `relative`: relative-parent.mdc). */
function Corner({ mark, actions, open }: { mark?: ReactNode; actions?: ReactNode; open: boolean }) {
  return (
    <>
      {actions && (
        // over the line before it, the way discord's floats; the first line's stays inside the list
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

/** The action bar's buttons: an icon a little box, a thumb wide on a phone. */
export const BAR_BUTTON =
  'flex h-7 w-7 items-center justify-center text-textSecondary hover:bg-primaryStroke/30 hover:text-textPrimary focus-visible:outline focus-visible:outline-1 focus-visible:outline-primaryBlue max-md:h-11 max-md:w-11';

/** One button of the action bar: an icon alone, so its name is its tooltip too (tooltips.mdc). */
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

/** A row of the action bar's `more` menu. */
export interface LineMenuItem {
  key: string;
  label: string;
  onPick: () => void;
  danger?: boolean;
}

/**
 * The `more` menu of a line's action bar: drawn into the body (the lines' list clips what hangs
 * out of it), under the button or over it when the window's foot is too near, the room page's
 * hover menus' way (ServerRoom.tsx `HoverMenu`). The arrows walk it, escape closes it.
 */
function MoreMenu({ items }: { items: LineMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement | null>(null);
  const menu = useRef<HTMLUListElement | null>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);

  // placed before paint (`left-0 top-0` until then), kept in the window, again on a scroll or a resize
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
      {/* its name is a tooltip while it is shut; open, the menu says what it is */}
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
              <li key={item.key} role="none">
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

/**
 * A line's action bar, discord's: react, reply, the caller's own buttons (`extra`: a group line's
 * pin), and `more` with the rest (reply again, `copy text`, the caller's `menu`). Up at the line's
 * top right on hover or focus, or after a long press on a phone (`ChatLineShape`'s `actions`).
 * `onReact`: the smiley opens the reaction picker (Reactions.tsx) over the line's `reactions`, `me`'s
 * lit. Absent, `reactOff` says why (a nick: `log in to react`) on a dimmed smiley, and with neither
 * there is no smiley (a pinned copy of a line). `onReply` absent: no reply (a pinned copy of a line,
 * which is not where a conversation goes on).
 */
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
  if (text) items.push({ key: 'copy', label: 'copy text', onPick: () => void navigator.clipboard?.writeText(text).catch(() => undefined) });
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

/** What a reply answers, as the line carries it (chat.rs `Reply`, dms.rs `quote_json`). `gone`: the line is not there any more. */
export interface Quoted {
  from: string;
  text: string;
  avatar: number | null;
  images: number;
  gone?: boolean;
}

/** A quote's words: the start of the line on one line, or its pictures when it had no words. */
export function quoteWords(q: Pick<Quoted, 'text' | 'images'>): string {
  if (q.text) return q.text.replace(/\s+/g, ' ');
  if (q.images > 1) return `${q.images} pictures`;
  if (q.images === 1) return 'a picture';
  return '';
}

/**
 * The line a reply answers, over the reply (discord's): in `log` and `blocks` a thin spine curling
 * from the face's column (the time's in a log) up into the quote, then the speaker's tiny face,
 * their name in bold and one line of their words, cut to fit; in `bubbles` the same quote at the
 * top of the box, a stroke at its left. A click goes to the line (`onJump`), which lights up there
 * or says it is not to be found; a line that is gone says so and goes nowhere.
 */
export function ReplyQuote({ shape, quote, onJump }: { shape: ChatStyle; quote: Quoted; onJump?: () => void }) {
  const words = quoteWords(quote);
  const body = quote.gone ? (
    <span className="truncate italic text-textTertiary">original message was deleted</span>
  ) : (
    <>
      <Face name={quote.from} version={quote.avatar} className="h-4 w-4 shrink-0 text-[9px]" />
      <span className="shrink-0 font-semibold text-textPrimary">{quote.from}</span>
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
      {/* the spine: from the middle of the column at the left, up and over into the quote. a stroke, curled at its corner */}
      <span aria-hidden className={cn('ml-4 mt-2 shrink-0 rounded-tl-md border-l-2 border-t-2 border-primaryStroke', shape === 'blocks' ? 'w-6' : 'w-5')} />
      <span className="ml-1 flex min-w-0 pb-0.5">{inner}</span>
    </span>
  );
}

/**
 * One line of any chat, in the shape this browser picked (settings.chatStyle; the chat tab's
 * cards): a stream's and a group channel's (ChatPanel.tsx) and a chat with a friend's
 * (FriendChat.tsx) are drawn by this alone, so the three shapes are the same three everywhere.
 * The time stands at the left in every shape, one column. `log`: the time, the name, the
 * words, one line; the words wrap under the name, not under the time. `bubbles`: the words in
 * a box of their own, yours on the right in the blue stroke and theirs on the left in the
 * grey one, the lines of one minute together with the time at the left once; a room's box
 * that is not yours wears the name on the first of a run (`crowd`), a thread's sides say who,
 * and the name is there for a reader whenever it is not drawn. `blocks`: the first line of a
 * run wears the writer's face, their name and the time over the words, and the lines after it
 * in the run stand under, the time at the left as the minute turns. The same `<p>` whatever
 * the shape, the caller's `attrs` on it and the full stamp as its title. The pictures stand
 * under the words in every shape (inside the box in `bubbles`). The text size is the list's:
 * `text-sm` in both, the panel and the window. A reply's quote (`quote`) stands over the line;
 * the action bar (`actions`) floats at its top right.
 */
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
  flash = false
}: ChatLineShapeProps) {
  const title = at ? stamp(at) : undefined;
  const press = useLongPress();
  const corner = <Corner mark={mark} actions={actions} open={press.open} />;
  // every line is the box its bar floats from (relative-parent.mdc); a mark sits on the line, and the words stop short of it.
  // on a phone a long press is the line's, not the text's: no selection and no callout (`copy text` is in the bar)
  const lineBox = cn(
    'group/line relative transition-colors duration-700',
    actions && '[-webkit-touch-callout:none] [@media(hover:hover)]:hover:bg-primaryStroke/10 [@media(hover:none)]:select-none',
    mark && 'pr-8',
    flash ? 'bg-primaryBlue/15 duration-150' : press.open && 'bg-primaryStroke/15'
  );
  const p = (className: string, children: ReactNode) => (
    <p {...attrs} {...(actions ? press.handlers : {})} ref={press.ref} title={title} data-flash={flash || undefined} className={cn(lineBox, className)}>
      {children}
      {corner}
    </p>
  );
  // a reply's quote (log, blocks) stands over the line's own row: the line is then a column of the two
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
        </>
      )
    );
  }
  if (shape === 'blocks') {
    // a reply heads a run of its own, discord's: the face, the name and the time under the quote
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
        </>
      )
    );
  }
  const named = crowd && !mine && first;
  return p(
    cn('flex gap-2 leading-snug', bucket && 'mt-2 first:mt-0'),
    <>
      {faced && first ? <span className={cn(GUTTER, 'mt-0.5')}>{face}</span> : <GutterClock at={at} shown={bucket} className="pt-2.5" />}
      {/* the box, and its reactions under it on its own side */}
      <span className={cn('flex min-w-0 flex-1 flex-col', mine ? 'items-end' : 'items-start')}>
        {/* the box: a stroke and a fill, no shadow (no-box-shadow.mdc). yours wears the blue. `relative`: the reader's name is `sr-only` (relative-parent.mdc) */}
        <span
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
    </>
  );
}
