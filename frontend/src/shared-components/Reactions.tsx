import { RiEmotionLine } from '@remixicon/react';
import { type KeyboardEvent, type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { Button, buttonClassName } from '@/shared-components/Button';
import { EMOJI_NAMES, EMOJIS, MAX_KINDS, QUICK, type Reaction, reacted, whoReacted } from '@/shared-components/reaction-list';
import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

/** An emoji's name, for its label and its tooltip (the glyph itself when the list has none). */
const nameOf = (emoji: string) => EMOJI_NAMES[emoji] ?? emoji;

/**
 * The button that opens the reaction picker, and the picker: a quick row of the first `QUICK`
 * emoji, then the whole grid (reaction-list.ts `EMOJIS`, the api's list). Drawn into the body (or the
 * open `<dialog>`), under the button or over it when the window's foot is too near, the `more`
 * menu's way (ChatLine.tsx `MoreMenu`). The arrows walk the grid, escape closes it, a pick closes
 * it. An emoji already yours is lit, and picking it takes it off; with `MAX_KINDS` different on the
 * line, the ones not there yet are out of reach and the picker says why. `trigger` is the button's
 * look: the action bar's icon (`className`) or the chip row's add chip.
 */
export function ReactionPicker({
  reactions,
  me,
  onPick,
  label = 'add reaction',
  className,
  id,
  children
}: {
  reactions: readonly Reaction[];
  me: string | null | undefined;
  onPick: (emoji: string) => void;
  label?: string;
  className: string;
  /** `data-line-action` on the button, for the tests and the pages. */
  id?: string;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const full = reactions.length >= MAX_KINDS;
  const there = new Set(reactions.map((r) => r.emoji));
  const mine = new Set(reactions.filter((r) => reacted(r, me)).map((r) => r.emoji));

  // placed before paint (`left-0 top-0` until then), kept in the window, again on a scroll or a resize
  useLayoutEffect(() => {
    const el = panel.current;
    if (!open || !el) return;
    const place = () => {
      const a = button.current?.getBoundingClientRect();
      if (!a) return;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      el.style.left = `${Math.max(4, Math.min(a.right - w, document.documentElement.clientWidth - w - 4))}px`;
      el.style.top = `${a.bottom + h <= document.documentElement.clientHeight - 4 ? a.bottom + 2 : Math.max(4, a.top - h - 2)}px`;
    };
    place();
    el.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    const outside = (e: PointerEvent) => {
      if (e.target instanceof Node && (panel.current?.contains(e.target) || button.current?.contains(e.target))) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', outside, true);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
      document.removeEventListener('pointerdown', outside, true);
    };
  }, [open]);

  function walk(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      button.current?.focus();
      return;
    }
    const cells = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>('[data-emoji]:not([disabled])') ?? []);
    const i = cells.indexOf(document.activeElement as HTMLButtonElement);
    const at = cells[i];
    if (!at) return;
    let to: number | undefined;
    if (e.key === 'ArrowLeft') to = i - 1;
    else if (e.key === 'ArrowRight') to = i + 1;
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      // a row is the cells at one height: the nearest in the next row up or down, by where they stand
      const here = at.getBoundingClientRect();
      const down = e.key === 'ArrowDown';
      const rows = cells.map((c) => c.getBoundingClientRect()).map((r, j) => ({ j, top: r.top, x: Math.abs(r.left - here.left) }));
      const next = rows.filter((r) => (down ? r.top > here.top + 1 : r.top < here.top - 1));
      const top = down ? Math.min(...next.map((r) => r.top)) : Math.max(...next.map((r) => r.top));
      to = next.filter((r) => r.top === top).sort((a, b) => a.x - b.x)[0]?.j;
    }
    if (to === undefined) return;
    e.preventDefault();
    cells[(to + cells.length) % cells.length]?.focus();
  }

  const cell = (emoji: string, big: boolean) => {
    const name = nameOf(emoji);
    const yours = mine.has(emoji);
    const blocked = full && !there.has(emoji);
    return (
      <Tooltip key={emoji} content={blocked ? null : yours ? `${name}: yours, pick to take it off` : name}>
        <button
          type="button"
          aria-label={yours ? `${name}, yours: take it off` : name}
          aria-pressed={yours}
          disabled={blocked}
          data-emoji={emoji}
          onClick={() => {
            setOpen(false);
            onPick(emoji);
          }}
          className={cn(
            'flex items-center justify-center border border-transparent leading-none hover:bg-primaryStroke/30 focus-visible:outline focus-visible:outline-1 focus-visible:outline-primaryBlue disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent max-md:h-11 max-md:w-11',
            big ? 'h-9 w-9 text-xl' : 'h-8 w-8 text-lg',
            yours && 'border-primaryBlue bg-primaryBlue/10'
          )}
        >
          {emoji}
        </button>
      </Tooltip>
    );
  };

  return (
    <>
      {/* its name is a tooltip while it is shut; open, the picker says what it is */}
      <Tooltip content={open ? null : label}>
        <button
          ref={button}
          type="button"
          aria-label={label}
          aria-haspopup="dialog"
          aria-expanded={open}
          data-line-action={id}
          onClick={() => {
            setHost(button.current?.closest<HTMLElement>('dialog:modal') ?? document.body);
            setOpen((was) => !was);
          }}
          className={className}
        >
          {children ?? <RiEmotionLine aria-hidden size={16} />}
        </button>
      </Tooltip>
      {open &&
        host &&
        createPortal(
          // `data-line-menu`: a press in here is the line's own, and leaves a long press's bar up (ChatLine.tsx)
          <div
            ref={panel}
            role="dialog"
            aria-label="pick a reaction"
            data-line-menu
            data-reaction-picker
            onKeyDown={walk}
            className="fixed left-0 top-0 z-[60] flex flex-col gap-1 border border-primaryStroke bg-backgroundSecondary p-1.5"
          >
            <div role="group" aria-label="quick" className="flex gap-0.5 border-b border-primaryStroke pb-1">
              {EMOJIS.slice(0, QUICK).map((e) => cell(e, true))}
            </div>
            <div role="group" aria-label="every reaction" className="grid grid-cols-8 gap-0.5 max-md:grid-cols-6">
              {EMOJIS.map((e) => cell(e, false))}
            </div>
            {full && <p className="max-w-64 px-1 text-xs text-textTertiary">{MAX_KINDS} different is the most a line holds: add to one that is there</p>}
          </div>,
          host
        )}
    </>
  );
}

/**
 * The reactions under a line, discord's chips: the emoji and how many, lit (`outline`, the blue)
 * where one is yours. A click puts yours on or takes it off; the tooltip says who reacted. `onReact`
 * absent (a nick in a stream's chat): the chips still say who, and a click asks to log in through
 * `onBlocked`. The last chip is the picker again, there while the line is pointed at (always on a
 * screen with no hover).
 */
export function ReactionChips({
  reactions,
  me,
  onReact,
  onBlocked
}: {
  reactions: readonly Reaction[];
  me: string | null | undefined;
  onReact?: (emoji: string) => void;
  onBlocked?: () => void;
}) {
  if (reactions.length === 0) return null;
  return (
    <span data-reactions className="mt-1 flex flex-wrap items-center gap-1">
      {reactions.map((r) => {
        const yours = reacted(r, me);
        const who = whoReacted(r, me);
        return (
          <Tooltip key={r.emoji} content={who}>
            <Button
              size="sm"
              variant={yours ? 'outline' : 'secondary'}
              aria-label={`${nameOf(r.emoji)}, ${r.count}: ${who}${onReact ? (yours ? '. take yours off' : '. add yours') : ''}`}
              aria-pressed={yours}
              data-reaction={r.emoji}
              data-count={r.count}
              data-mine={yours || undefined}
              onClick={() => (onReact ? onReact(r.emoji) : onBlocked?.())}
              className={cn('gap-1 px-1.5 py-0.5 text-xs font-normal leading-4 tabular-nums', !yours && 'text-textSecondary')}
            >
              <span aria-hidden className="text-sm leading-4">
                {r.emoji}
              </span>
              <span aria-hidden>{r.count}</span>
            </Button>
          </Tooltip>
        );
      })}
      {onReact && (
        // up while the line is pointed at, or the picker is open, or it has the keyboard; always on a screen with no hover
        <ReactionPicker
          reactions={reactions}
          me={me}
          onPick={onReact}
          id="react-more"
          className={buttonClassName(
            'secondary',
            'px-1.5 py-0.5 text-textSecondary leading-4 transition-opacity [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/line:opacity-100 [@media(hover:hover)]:focus-visible:opacity-100 [@media(hover:hover)]:aria-expanded:opacity-100',
            'sm'
          )}
        >
          <RiEmotionLine aria-hidden size={16} />
        </ReactionPicker>
      )}
    </span>
  );
}
