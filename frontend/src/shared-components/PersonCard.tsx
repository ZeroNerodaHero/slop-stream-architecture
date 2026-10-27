import { type CSSProperties, type FocusEvent, useEffect, useRef, useState } from 'react';

import type { Presence } from '@/infra/atoms/presence-atoms';
import type { PanelSide } from '@/infra/atoms/settings-atoms';
import { Face } from '@/shared-components/Face';
import { Who, Word } from '@/shared-components/PersonRow';

/** Enough of somebody for the card. The sidebar's rows and the chat window's tabs both have it. */
export interface CardPerson {
  name: string;
  verified: boolean;
  avatar: number | null;
  bio: string;
  presence: Presence;
}

/** Where the card goes: level with the row pointed at, beside the column the row is in. */
export interface CardSpot {
  row: DOMRect;
  column: DOMRect;
}

/**
 * The hover and focus bookkeeping for the card over one row. `show` measures and shows after
 * `delay` (a panel that widens on hover has settled by then, and a pointer crossing rows does
 * not flash a card per row); the card goes when both the pointer and the focus have left the
 * row. `at` is where to put it, or null.
 */
export function usePeek(delay: number) {
  const [at, setAt] = useState<CardSpot | null>(null);
  const timer = useRef<number | null>(null);
  const clear = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  };
  // a row that goes while its timer runs: nothing shows
  useEffect(() => clear, []);
  return {
    at,
    /** The pointer or the focus arrived on `row`, which sits in `column`. */
    show(row: Element, column: Element | null) {
      if (!column) return;
      clear();
      timer.current = window.setTimeout(() => {
        timer.current = null;
        if (row.isConnected) setAt({ row: row.getBoundingClientRect(), column: column.getBoundingClientRect() });
      }, delay);
    },
    /** The pointer left `row`. The card stays while the focus is still in it. */
    leave(row: Element) {
      if (row.contains(document.activeElement)) return;
      clear();
      setAt(null);
    },
    /** The focus left `row`, and not for something in it. The card stays while the pointer is still on it. */
    blur(e: FocusEvent<HTMLElement>) {
      const row = e.currentTarget;
      if (row.contains(e.relatedTarget as Node | null) || row.matches(':hover')) return;
      clear();
      setAt(null);
    }
  };
}

interface PersonCardProps {
  id?: string;
  person: CardPerson;
  at: CardSpot;
  /** Which side of the page the sidebar is on: the card goes out the other way. */
  side: PanelSide;
}

/**
 * Somebody, beside the column their row is in, while the pointer or the focus is on the row:
 * the face, the name, how they are, the bio. The sidebar's rows and the chat window's tabs
 * both show it, from what the page already holds (the following list, a search's hits): no
 * request. Not for pressing. It goes out on the side away from the sidebar, and hangs down
 * from the row in the top half of the screen and up from it in the bottom half, so it stays
 * on screen.
 */
export function PersonCard({ id, person, at, side }: PersonCardProps) {
  const w = document.documentElement.clientWidth;
  const h = document.documentElement.clientHeight;
  const style: CSSProperties = {
    ...(side === 'right' ? { right: w - at.column.left + 4 } : { left: at.column.right + 4 }),
    ...(at.row.top < h / 2 ? { top: at.row.top } : { bottom: h - at.row.bottom })
  };
  return (
    <div
      id={id}
      role="tooltip"
      style={style}
      className="pointer-events-none fixed z-10 flex w-[260px] gap-3 border border-primaryStroke bg-backgroundSecondary p-3 text-base text-textPrimary"
    >
      <Face name={person.name} version={person.avatar} className="h-12 w-12 text-lg" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <Who name={person.name} verified={person.verified} />
        <Word presence={person.presence} />
        {person.bio && <span className="text-sm text-textSecondary [overflow-wrap:anywhere]">{person.bio}</span>}
      </span>
    </div>
  );
}
