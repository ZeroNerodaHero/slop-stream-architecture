import type { HTMLAttributes, ReactNode } from 'react';

import type { ChatStyle } from '@/infra/atoms/settings-atoms';
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
  /** A room: the left side of `bubbles` is everyone else, so a box that is not yours wears the name on the first of a run. A thread's two sides say who. */
  crowd?: boolean;
  /** The words, wrapped as the caller likes; null for a line of pictures alone. */
  words: ReactNode | null;
  pictures?: ReactNode;
  /** The `<p>`'s own attributes: `data-id` and the rest the pages and the tests key on. */
  attrs?: HTMLAttributes<HTMLParagraphElement> & Record<`data-${string}`, string | number | boolean | undefined>;
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
 * the panel's `text-base`, the window's `text-sm`.
 */
export function ChatLineShape({ shape, mine, at, name, who, face, crowd = false, first, bucket, words, pictures, attrs }: ChatLineShapeProps) {
  const title = at ? stamp(at) : undefined;
  if (shape === 'log') {
    return (
      <p {...attrs} title={title} className="flex items-baseline gap-2 leading-snug">
        <span className="shrink-0 text-xs tabular-nums text-textTertiary">{clock(at)}</span>
        <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
          <span className="mr-1.5">{who}</span>
          {words}
          {pictures}
        </span>
      </p>
    );
  }
  if (shape === 'blocks') {
    return (
      <p {...attrs} title={title} className={cn('group/line flex gap-2.5 leading-snug', first && 'mt-2 first:mt-0')}>
        {first ? <span className={cn(GUTTER, 'mt-0.5')}>{face}</span> : <GutterClock at={at} shown={bucket} className="pt-1" />}
        <span className="flex min-w-0 flex-1 flex-col [overflow-wrap:anywhere]">
          {first && (
            <span className="flex items-baseline gap-2">
              <span className="min-w-0 truncate">{who}</span>
              <span className="shrink-0 text-xs tabular-nums text-textTertiary">{clock(at)}</span>
            </span>
          )}
          {words}
          {pictures}
        </span>
      </p>
    );
  }
  const named = crowd && !mine && first;
  return (
    <p {...attrs} title={title} className={cn('group/line flex gap-2.5 leading-snug', bucket && 'mt-2 first:mt-0')}>
      <GutterClock at={at} shown={bucket} className="pt-2.5" />
      <span className={cn('flex min-w-0 flex-1', mine ? 'justify-end' : 'justify-start')}>
        {/* the box: a stroke and a fill, no shadow (no-box-shadow.mdc). yours wears the blue. `relative`: the reader's name is `sr-only` (relative-parent.mdc) */}
        <span
          className={cn(
            'relative flex max-w-[85%] flex-col border px-2.5 py-1.5 [overflow-wrap:anywhere]',
            mine ? 'border-primaryBlue bg-primaryBlue/10' : 'border-primaryStroke bg-backgroundTertiary'
          )}
        >
          {named ? <span className="mb-0.5 flex min-w-0 items-baseline text-sm">{who}</span> : <span className="sr-only">{mine ? 'you' : name}: </span>}
          {words}
          {pictures}
        </span>
      </span>
    </p>
  );
}
