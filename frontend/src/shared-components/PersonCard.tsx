import { useAtomValue } from 'jotai';
import { type CSSProperties, type FocusEvent, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { loadPeek, peeksAtom } from '@/infra/atoms/follow-atoms';
import { type Presence, PRESENCE_WORD } from '@/infra/atoms/presence-atoms';
import { profilePopupAtom } from '@/infra/atoms/profile-popup-atoms';
import type { PanelSide } from '@/infra/atoms/settings-atoms';
import { Face } from '@/shared-components/Face';
import { PresenceSquare, Who } from '@/shared-components/PersonRow';
import { StreamStill } from '@/shared-components/StreamStill';

/** The card's width, and how far it stands off the column and off the window's edge. */
const CARD_W = 260;
const GAP = 4;

/**
 * Enough of somebody for the card. The sidebar's rows and the chat window's tabs hold all of
 * it; a chat line holds the name, the ✓ and the picture, a group's roster those and the word,
 * and the card asks the api for the rest.
 */
export interface CardPerson {
  name: string;
  verified: boolean;
  avatar: number | null;
  /** The status, one line about them (`bio` on the wire). Not known: the card asks. */
  bio?: string;
  /** The word for how they are. Not known: the card asks. */
  presence?: Presence;
}

/** Where the card goes: level with the row pointed at, beside the column the row is in. */
export interface CardSpot {
  row: DOMRect;
  column: DOMRect;
  /** Where it is drawn: the body of the row's document (the popped out player has one of its own), or the modal <dialog> the row is in, whose top layer nothing in the body reaches. */
  host: HTMLElement;
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
  const show = (row: Element, column: Element | null) => {
    if (!column) return;
    clear();
    timer.current = window.setTimeout(() => {
      timer.current = null;
      if (!row.isConnected) return;
      setAt({
        row: row.getBoundingClientRect(),
        column: column.getBoundingClientRect(),
        host: row.closest<HTMLElement>('dialog:modal') ?? row.ownerDocument.body
      });
    }, delay);
  };
  return {
    at,
    /** The pointer or the focus arrived on `row`, which sits in `column`. */
    show,
    /**
     * The keyboard's focus arrived in `row`, for a row whose click opens the profile popup (a
     * roster's member, a chat's speaker): `show`, but not for the focus that click leaves on
     * the row, nor for the focus the popup hands back to it as it closes. Neither is somebody
     * arriving to look, and the card would stand there until the focus moved on.
     */
    focus(e: FocusEvent<HTMLElement>, column: Element | null) {
      if (!e.target.matches(':focus-visible')) return;
      // from inside the popup, not from any dialog: a watch page's chat is in one of its own (ChatSlot.tsx), and the focus moving from name to name there is an arrival
      if (e.relatedTarget instanceof Element && e.relatedTarget.closest('#profile-popup')) return;
      show(e.currentTarget, column);
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
  /** Which side of the page the column is on: the card goes out the other way. Not given (the chat, which can be anywhere): the side the column is nearer. */
  side?: PanelSide;
}

/**
 * Somebody, beside the column their row is in, while the pointer or the focus is on the row:
 * the face with the presence square on its corner, the name, then their status under the two.
 * Streaming, a frame of the stream (StreamStill.tsx, kept a few seconds old) stands between
 * the name and the status, the card's width: the preview of what they are streaming, the
 * sidebar's small one made big. The sidebar's rows, the chat window's tabs, a chat line's
 * speaker and a group's roster (ServerRoom.tsx) all show it. A row holds all of it (the
 * following list, a search's hits, the open chats), so the card is up at once; a chat line
 * holds the name, the ✓ and the picture alone, a roster's row those and the word, and what is
 * missing comes from one `GET /api/streamers/:name` asked when the card shows (follow-atoms
 * keeps the answer a while, so hovering the same name again asks nothing). Until it answers,
 * or when it does not, the face has no square and there is no status. Not for pressing. Drawn into the body
 * (no list clips it, and a window's transform does not move it), it goes out on the side away
 * from the edge, kept on screen, and hangs down from the row in the top half of the screen and
 * up from it in the bottom half.
 */
export function PersonCard({ id, person, at, side }: PersonCardProps) {
  const peek = useAtomValue(peeksAtom)[person.name]?.card;
  // the profile popup is up (a click on this row opened it, like as not): the page under it is not being pointed at, and a card left there would show through, dimmed
  const covered = useAtomValue(profilePopupAtom) !== null;
  const asks = person.bio === undefined || person.presence === undefined;
  useEffect(() => {
    if (asks) void loadPeek(person.name);
  }, [person.name, asks]);
  if (covered) return null;
  // a renamed login's old lines: the name's row is a free name's for the hold, so its word and status are not this person's
  const known = person.verified && peek && !peek.verified ? undefined : peek;
  const bio = person.bio ?? known?.bio ?? '';
  const presence = person.presence ?? known?.presence;
  const root = at.host.ownerDocument.documentElement;
  const w = root.clientWidth;
  const h = root.clientHeight;
  const edge = side ?? (at.column.left + at.column.width / 2 > w / 2 ? 'right' : 'left');
  const x = edge === 'right' ? at.column.left - GAP - CARD_W : at.column.right + GAP;
  const style: CSSProperties = {
    width: CARD_W,
    left: Math.max(GAP, Math.min(x, w - CARD_W - GAP)),
    ...(at.row.top < h / 2 ? { top: at.row.top } : { bottom: h - at.row.bottom })
  };
  return createPortal(
    <div
      id={id}
      role="tooltip"
      style={style}
      data-presence={presence}
      className="pointer-events-none fixed z-[60] flex flex-col gap-2.5 border border-primaryStroke bg-backgroundSecondary p-3 text-base text-textPrimary"
    >
      <span className="flex items-center gap-3">
        <span className="relative shrink-0">
          <Face name={person.name} version={person.avatar} className="h-12 w-12 text-lg" />
          {presence && (
            <>
              <PresenceSquare presence={presence} className="border-backgroundSecondary" />
              {/* the square says it in colour; the word, for a reader */}
              <span className="sr-only">{PRESENCE_WORD[presence]}</span>
            </>
          )}
        </span>
        <Who name={person.name} verified={person.verified} className="flex-1" />
      </span>
      {presence === 'streaming' && <StreamStill name={person.name} className="w-full" />}
      {/* the status, the width of the card: whole words, four lines at most */}
      {bio && <span className="line-clamp-4 break-words text-sm leading-snug">{bio}</span>}
    </div>,
    at.host
  );
}
