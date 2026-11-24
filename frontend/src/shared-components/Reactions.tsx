import { RiEmotionLine } from '@remixicon/react';
import { type KeyboardEvent, type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { type Emote, emoteSrc, isEmoteId, useEmotes, useMyEmotes } from '@/infra/emotes';
import { Button, buttonClassName } from '@/shared-components/Button';
import { EMOJI_NAMES, EMOJIS, MAX_KINDS, QUICK, type Reaction, reacted, whoReacted } from '@/shared-components/reaction-list';
import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

function nameOf(emoji: string, emotes?: Map<string, Emote | null>): string {
  if (!isEmoteId(emoji)) return EMOJI_NAMES[emoji] ?? emoji;
  const emote = emotes?.get(emoji.toLowerCase());
  return emote ? `:${emote.name}:` : emote === null ? 'a deleted emote' : 'an emote';
}

function Glyph({ emoji, emote, size }: { emoji: string; emote: Emote | null | undefined; size: number }) {
  if (!isEmoteId(emoji)) return <>{emoji}</>;
  if (emote === null) return <>?</>;
  return <img src={emoteSrc(emoji)} alt="" draggable={false} className="inline-block object-contain" style={{ width: size, height: size }} />;
}

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
  const myEmotes = useMyEmotes();
  const byGroup = new Map<string, Emote[]>();
  for (const e of myEmotes) byGroup.set(e.group, [...(byGroup.get(e.group) ?? []), e]);

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

  const cell = (emoji: string, big: boolean, emote?: Emote) => {
    const name = emote ? `:${emote.name}:` : nameOf(emoji);
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
          {emote ? <Glyph emoji={emoji} emote={emote} size={big ? 24 : 22} /> : emoji}
        </button>
      </Tooltip>
    );
  };

  return (
    <>
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
            <div className={cn('flex flex-col gap-1', byGroup.size > 0 && 'max-h-[min(50dvh,360px)] overflow-y-auto overscroll-contain')}>
              <div role="group" aria-label="every reaction" className="grid grid-cols-8 gap-0.5 max-md:grid-cols-6">
                {EMOJIS.map((e) => cell(e, false))}
              </div>
              {[...byGroup].map(([group, list]) => (
                <div
                  key={group}
                  role="group"
                  aria-label={`${group}'s emotes`}
                  data-emote-group={group}
                  className="flex flex-col gap-0.5 border-t border-primaryStroke pt-1"
                >
                  <p aria-hidden className="truncate px-1 text-xs text-textTertiary">
                    {group}
                  </p>
                  <div className="grid grid-cols-8 gap-0.5 max-md:grid-cols-6">{list.map((e) => cell(e.id, false, e))}</div>
                </div>
              ))}
            </div>
            {full && <p className="max-w-64 px-1 text-xs text-textTertiary">{MAX_KINDS} different is the most a line holds: add to one that is there</p>}
          </div>,
          host
        )}
    </>
  );
}

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
  const emotes = useEmotes(reactions.flatMap((r) => (isEmoteId(r.emoji) ? [r.emoji] : [])));
  if (reactions.length === 0) return null;
  return (
    <span data-reactions className="mt-1 flex flex-wrap items-center gap-1">
      {reactions.map((r) => {
        const yours = reacted(r, me);
        const name = nameOf(r.emoji, emotes);
        const who = whoReacted(r, me, isEmoteId(r.emoji) ? name : r.emoji);
        return (
          <Tooltip key={r.emoji} content={who}>
            <Button
              size="sm"
              variant={yours ? 'outline' : 'secondary'}
              aria-label={`${name}, ${r.count}: ${who}${onReact ? (yours ? '. take yours off' : '. add yours') : ''}`}
              aria-pressed={yours}
              data-reaction={r.emoji}
              data-count={r.count}
              data-mine={yours || undefined}
              onClick={() => (onReact ? onReact(r.emoji) : onBlocked?.())}
              className={cn('gap-1 px-1.5 py-0.5 text-xs font-normal leading-4 tabular-nums', !yours && 'text-textSecondary')}
            >
              <span aria-hidden className="flex text-sm leading-4">
                <Glyph emoji={r.emoji} emote={emotes.get(r.emoji.toLowerCase())} size={16} />
              </span>
              <span aria-hidden>{r.count}</span>
            </Button>
          </Tooltip>
        );
      })}
      {onReact && (
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
