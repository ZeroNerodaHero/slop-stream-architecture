import { useAtomValue } from 'jotai';
import { type CSSProperties, type FocusEvent, type KeyboardEvent, type PointerEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { api, type GroupBadge } from '@/infra/api';
import { BOT_GROUP } from '@/infra/atoms/chat-atoms';
import { homeStreamsAtom } from '@/infra/atoms/home-atoms';
import { loadPeek, peeksAtom } from '@/infra/atoms/follow-atoms';
import { type Presence, PRESENCE_WORD } from '@/infra/atoms/presence-atoms';
import { profilePopupAtom } from '@/infra/atoms/profile-popup-atoms';
import type { PanelSide } from '@/infra/atoms/settings-atoms';
import { Badge } from '@/shared-components/Badge';
import { Face } from '@/shared-components/Face';
import { Who } from '@/shared-components/PersonRow';
import { PresenceSquare } from '@/shared-components/PresenceSquare';
import { StreamStill } from '@/shared-components/StreamStill';
import { Tooltip } from '@/shared-components/Tooltip';
import { ViewerCount } from '@/shared-components/ViewerCount';
import { cn } from '@/utils/cn';

/** The card's width, and how far it stands off the column and off the window's edge. */
const CARD_W = 260;
const GAP = 4;
/** The moderator's box at the card's left (`actions`): one icon button wide, its stroke shared with the card's. */
const ACTIONS_W = 30;
/** How long the card waits after the pointer leaves its row, or itself, before it goes: time to cross the gap between them. */
const LINGER_MS = 180;
/** What on the card the keyboard can reach. */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** A button in the moderator's box on the card (GroupMod.tsx `useCardMod`): an icon, its name the tooltip, red when it removes someone. */
export interface CardAction {
  key: string;
  label: string;
  icon: ReactNode;
  danger?: boolean;
  onPick: () => void;
}

/** The card's side of `usePeek`: while the pointer or the keyboard is on it, or something on it is held, it stays. */
export interface PeekHold {
  /** The card's element, for the hover and focus checks. */
  setCard: (el: HTMLElement | null) => void;
  enter: () => void;
  leave: () => void;
  /** Something on the card is held (a slider dragged, a menu open): it stays whatever the pointer does until let go, then goes a moment later if nothing is on it. */
  pin: (on: boolean) => void;
  /** Escape closes it and hands the focus back to the row; tab off either end goes back to the row. */
  keyDown: (e: KeyboardEvent<HTMLElement>) => void;
  /** The focus left the card: it goes, unless for the row or the pointer is still on it. */
  blur: (e: FocusEvent<HTMLElement>) => void;
}

/**
 * Enough of somebody for the card. The sidebar's rows and the chat window's tabs hold all of
 * it; a chat line holds the name, the ✓ and the picture, a group's roster those and the word,
 * and the card asks the api for the rest.
 */
export interface CardPerson {
  name: string;
  verified: boolean;
  /** The verified mark (a provider linked). Not known: the card's answer says. */
  oauth_verified?: boolean;
  avatar: number | null;
  /** The status, one line about them (`bio` on the wire). Not known: the card asks. */
  bio?: string;
  /** The word for how they are. Not known: the card asks. */
  presence?: Presence;
  /** The badges a chat line carried: the group badge under the name until (or when an older api does not say) the card's answer has `badge`. */
  groups?: GroupBadge[];
}

/** Where the card goes: level with the row pointed at, beside the column the row is in. */
export interface CardSpot {
  row: DOMRect;
  column: DOMRect;
  /** Where it is drawn: the body of the row's document (the popped out player has one of its own), or the modal <dialog> the row is in, whose top layer nothing in the body reaches. */
  host: HTMLElement;
}

/**
 * What last went down: a pointer's type (`mouse`, `touch`, `pen`), or `keyboard` after a key. A
 * tap leaves the focus on the row it pressed, and that is not somebody arriving to look.
 */
let lastInput = 'mouse';
let tracking = false;
function trackInput() {
  if (tracking) return;
  tracking = true;
  // capture, on the window: before the focus the press moves, and whatever the row under it stops
  const pressed = (e: globalThis.PointerEvent) => {
    lastInput = e.pointerType;
  };
  const typed = () => {
    lastInput = 'keyboard';
  };
  window.addEventListener('pointerdown', pressed, true);
  window.addEventListener('keydown', typed, true);
}

/** A mouse's hover, or a focus that no finger or pen left: a phone's tap goes straight to the profile sheet, no card flashing up first. */
function peeking(e: PointerEvent<Element> | FocusEvent<Element>) {
  if ('pointerType' in e) return e.pointerType === 'mouse';
  return lastInput !== 'touch' && lastInput !== 'pen';
}

/** The row's own link or button, for the focus handed back from the card: the row itself when it takes the focus. */
function rowTarget(row: HTMLElement): HTMLElement {
  return row.matches(FOCUSABLE) ? row : (row.querySelector<HTMLElement>(FOCUSABLE) ?? row);
}

/**
 * The hover and focus bookkeeping for the card over one row. `show` measures and shows after
 * `delay` (a panel that widens on hover has settled by then, and a pointer crossing rows does
 * not flash a card per row). The card can be pointed at: it stays while the pointer is on the
 * row or on it, and goes `LINGER_MS` after it has left both (time to cross the gap), and stays
 * whatever the pointer does while something on it is held (`hold.pin`: a slider dragged). The
 * keyboard reaches it too: tab from the row goes into its buttons, tab off either end comes
 * back, and escape on either closes it. Only a mouse's hover or a focus that no tap left shows
 * it (`peeking`): a phone's tap opens the profile sheet, as before.
 */
export function usePeek(delay: number) {
  const [at, setAt] = useState<CardSpot | null>(null);
  const timer = useRef<number | null>(null);
  /** The card going, once the pointer has been away from the row and the card `LINGER_MS`. */
  const closing = useRef<number | null>(null);
  const row = useRef<HTMLElement | null>(null);
  const card = useRef<HTMLElement | null>(null);
  /** Something on the card is held: the card stays until it is let go. */
  const pinned = useRef(false);
  const stay = () => {
    if (closing.current !== null) {
      window.clearTimeout(closing.current);
      closing.current = null;
    }
  };
  const clear = () => {
    stay();
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  };
  const close = () => {
    clear();
    pinned.current = false;
    setAt(null);
  };
  /** The card is in use: held, the pointer on it or its row, or the keyboard in it. */
  const inUse = () => {
    const c = card.current;
    if (pinned.current || c?.matches(':hover') || row.current?.matches(':hover')) return true;
    return !!c && lastInput === 'keyboard' && c.contains(c.ownerDocument.activeElement);
  };
  const goSoon = () => {
    stay();
    closing.current = window.setTimeout(() => {
      closing.current = null;
      if (!inUse()) setAt(null);
    }, LINGER_MS);
  };
  // a row that goes while its timer runs: nothing shows
  useEffect(() => clear, []);
  useEffect(trackInput, []);
  const show = (e: PointerEvent<HTMLElement> | FocusEvent<HTMLElement>, column: Element | null) => {
    if (!column || !peeking(e)) return;
    const el = e.currentTarget;
    row.current = el;
    clear();
    timer.current = window.setTimeout(() => {
      timer.current = null;
      if (!el.isConnected) return;
      setAt({
        row: el.getBoundingClientRect(),
        column: column.getBoundingClientRect(),
        host: el.closest<HTMLElement>('dialog:modal') ?? el.ownerDocument.body
      });
    }, delay);
  };
  /** The focus back on the row, the card closed or left open. */
  const backToRow = () => {
    if (row.current?.isConnected) rowTarget(row.current).focus();
  };
  const hold: PeekHold = {
    setCard: (el) => {
      card.current = el;
    },
    enter: stay,
    leave: () => {
      if (!pinned.current) goSoon();
    },
    pin: (on) => {
      pinned.current = on;
      if (on) stay();
      else goSoon();
    },
    keyDown: (e) => {
      if (e.key === 'Escape') {
        // the card's, not a dialog's under it
        e.preventDefault();
        e.stopPropagation();
        close();
        backToRow();
        return;
      }
      if (e.key !== 'Tab' || !card.current) return;
      const list = [...card.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const edge = e.shiftKey ? list[0] : list[list.length - 1];
      if (list.length > 0 && document.activeElement !== edge) return;
      e.preventDefault();
      // forward off the end: the card is done with, and the next tab goes on down the list
      if (!e.shiftKey) close();
      backToRow();
    },
    blur: (e) => {
      const to = e.relatedTarget as Node | null;
      if (card.current?.contains(to) || row.current?.contains(to) || inUse()) return;
      close();
    }
  };
  return {
    at,
    /** The pointer or the focus arrived on the row (`e.currentTarget`), which sits in `column`. */
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
      // back from the card: it is up already
      if (at && card.current?.contains(e.relatedTarget as Node | null)) return;
      show(e, column);
    },
    /** The pointer left `row`. The card stays while the focus is still in it, and a moment for the pointer to reach the card. */
    leave(el: Element) {
      if (el.contains(document.activeElement)) return;
      // a card about to show does not: the pointer only passed
      clear();
      if (!pinned.current) goSoon();
    },
    /** The focus left `row`, and not for something in it or for the card. The card stays while the pointer is still on either. */
    blur(e: FocusEvent<HTMLElement>) {
      const el = e.currentTarget;
      const to = e.relatedTarget as Node | null;
      if (el.contains(to) || card.current?.contains(to) || inUse()) return;
      close();
    },
    /** A key on the row: tab goes into the card's buttons while it is up, escape closes it. */
    keyDown(e: KeyboardEvent<HTMLElement>) {
      if (!at) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      }
      if (e.key !== 'Tab' || e.shiftKey) return;
      const first = card.current?.querySelector<HTMLElement>(FOCUSABLE);
      if (!first) return;
      e.preventDefault();
      first.focus();
    },
    hold,
    /** The card goes now: one of its buttons was pressed, and what it opened covers the page. */
    close
  };
}

interface PersonCardProps {
  id?: string;
  person: CardPerson;
  at: CardSpot;
  /** Which side of the page the column is on: the card goes out the other way. Not given (the chat, which can be anywhere): the side the column is nearer. */
  side?: PanelSide;
  /** A moderator's buttons (GroupMod.tsx `useCardMod`), in a box at the card's left. None or empty: no box. */
  actions?: CardAction[] | null;
  /** What goes at the foot of the card, under the rest: your own level for someone in your voice channel (VoiceLevel.tsx). */
  below?: ReactNode;
  /** `usePeek`'s `hold`: the card can be pointed at and tabbed into, and stays while it is. */
  hold: PeekHold;
}

/**
 * Somebody, beside the column their row is in, while the pointer or the focus is on the row:
 * the face with the presence square on its corner, and beside it, as tall as the face, the name
 * (cut short with an ellipsis) along its top and along its bottom their group's badge (the
 * primary group, else the first joined; none for no group) then, while they stream, how many
 * are watching, home's count (homeStreamsAtom; nothing until home has had the list). With
 * neither the bottom is empty and the name stays at the top. Then their status under the two.
 * Not streaming, their first home-card thumbnail stands there instead at the same size (a grey
 * box when they have none).
 * Streaming, a frame of the stream (StreamStill.tsx, kept a few seconds old) stands between
 * the name and the status, the card's width: the preview of what they are streaming, the
 * sidebar's small one made big. The sidebar's rows, the chat window's tabs, a chat line's
 * speaker and a group's roster (ServerRoom.tsx) all show it. A row holds all of it (the
 * following list, a search's hits, the open chats), so the card is up at once; a chat line
 * holds the name, the ✓ and the picture alone, a roster's row those and the word, and what is
 * missing comes from one `GET /api/streamers/:name` asked when the card shows (follow-atoms
 * keeps the answer a while, so hovering the same name again asks nothing). Until it answers,
 * or when it does not, the face has no square and there is no status. The pointer can cross onto
 * it and the keyboard tab into it (usePeek), for a moderator's box and `below`. Drawn into the body
 * (no list clips it, and a window's transform does not move it), it goes out on the side away
 * from the edge, kept on screen, and hangs down from the row in the top half of the screen and
 * up from it in the bottom half.
 */
export function PersonCard({ id, person, at, side, actions, below, hold }: PersonCardProps) {
  const { setCard } = hold;
  const peek = useAtomValue(peeksAtom)[person.name]?.card;
  // the profile popup is up (a click on this row opened it, like as not): the page under it is not being pointed at, and a card left there would show through, dimmed
  const covered = useAtomValue(profilePopupAtom) !== null;
  // not streaming, the card shows their thumbnail, which only the api's card has: so it asks then too (kept a while, follow-atoms)
  const asks = person.bio === undefined || person.presence === undefined || person.presence !== 'streaming';
  useEffect(() => {
    if (asks) void loadPeek(person.name);
  }, [person.name, asks]);
  // home's list, the count its cards show: null while it has not come, or did not say. Above the early return: every hook runs on every render (React #300 when the popup opens over a shown card)
  const viewers = useAtomValue(homeStreamsAtom)?.find((s) => s.name === person.name)?.viewers ?? null;
  if (covered) return null;
  // a renamed login's old lines: the name's row is a free name's for the hold, so its word and status are not this person's
  const known = person.verified && peek && !peek.verified ? undefined : peek;
  const bio = person.bio ?? known?.bio ?? '';
  const presence = person.presence ?? known?.presence;
  // their primary group's badge, else the first group their chat lines wear (the api's `badge`); an older api's answer has none, so the line's own
  const badge = known?.badge !== undefined ? known.badge : (person.groups?.find((g) => g.name !== BOT_GROUP) ?? null);
  const root = at.host.ownerDocument.documentElement;
  const w = root.clientWidth;
  const h = root.clientHeight;
  const edge = side ?? (at.column.left + at.column.width / 2 > w / 2 ? 'right' : 'left');
  const x = edge === 'right' ? at.column.left - GAP - CARD_W : at.column.right + GAP;
  const pressable = !!actions && actions.length > 0;
  // the box at its left stays in the window too
  const least = GAP + (pressable ? ACTIONS_W : 0);
  const style: CSSProperties = {
    width: CARD_W,
    left: Math.max(least, Math.min(x, w - CARD_W - GAP)),
    ...(at.row.top < h / 2 ? { top: at.row.top } : { bottom: h - at.row.bottom })
  };
  return createPortal(
    // the pointer can cross onto it from the row and stay; tab from the row comes in here (usePeek)
    <div
      ref={setCard}
      style={style}
      data-peek-hold
      onPointerEnter={hold.enter}
      onPointerLeave={hold.leave}
      onKeyDown={hold.keyDown}
      onBlur={hold.blur}
      className="pointer-events-auto fixed z-[60]"
    >
      {pressable && (
        // a column of icon buttons against the card's left side, its top level with the card's: one stroke between them
        <div
          id={id ? `${id}-mod` : undefined}
          role="toolbar"
          aria-orientation="vertical"
          aria-label={`moderate ${person.name}`}
          className="absolute right-full top-0 -mr-px flex flex-col border border-primaryStroke bg-backgroundSecondary"
        >
          {actions.map((a) => (
            <Tooltip key={a.key} content={a.label} at="left">
              <button
                type="button"
                aria-label={a.label}
                data-card-action={a.key}
                onClick={a.onPick}
                className={cn(
                  'flex h-7 w-7 items-center justify-center border border-transparent hover:border-primaryStroke focus-visible:border-primaryBlue focus-visible:outline-none',
                  a.danger ? 'text-decrease' : 'text-textSecondary hover:text-textPrimary'
                )}
              >
                {a.icon}
              </button>
            </Tooltip>
          ))}
        </div>
      )}
      <div
        id={id}
        // with something to press it is a little dialog of its own; without, it only says who they are
        role={pressable || below ? 'dialog' : 'tooltip'}
        aria-label={pressable || below ? person.name : undefined}
        data-presence={presence}
        className="flex flex-col gap-2.5 border border-primaryStroke bg-backgroundSecondary p-3 text-sm text-textPrimary"
      >
        {/* beside the face and as tall as it: the name along its top (leading-4, so its cap sits level with the face's top), the badge and the count along its bottom */}
        <span className="flex items-center gap-2.5">
          <span className="relative shrink-0">
            <Face name={person.name} version={person.avatar} className="h-10 w-10 text-base" />
            {presence && (
              <>
                <PresenceSquare status={presence} className="border-backgroundSecondary" />
                {/* the square says it in colour; the word, for a reader */}
                <span className="sr-only">{PRESENCE_WORD[presence]}</span>
              </>
            )}
          </span>
          <span className="flex h-10 min-w-0 flex-1 flex-col items-start justify-between">
            <Who
              name={person.name}
              verified={person.verified}
              oauthVerified={person.oauth_verified ?? known?.oauth_verified}
              className="max-w-full text-sm font-semibold leading-4"
            />
            <span className="flex min-w-0 max-w-full items-center gap-2 text-xs leading-4">
              {badge && <Badge group={badge} className="min-w-0" />}
              {presence === 'streaming' && <ViewerCount count={viewers} className="shrink-0 whitespace-nowrap text-textSecondary" />}
            </span>
          </span>
        </span>
        {presence === 'streaming' ? (
          <StreamStill name={person.name} className="w-full" />
        ) : (
          // not streaming: their first home-card thumbnail at the still's size, or, when they have none, their face blown up and
          // blurred behind the word offline (the blur kept inside by overflow-hidden)
          <span
            id={id ? `${id}-thumb` : undefined}
            className="relative flex aspect-video w-full shrink-0 items-center justify-center overflow-hidden border border-primaryStroke bg-backgroundTertiary"
          >
            {known?.thumbs?.[0] !== undefined ? (
              <img src={api.streamThumbUrl(person.name, known.thumbs[0])} alt="" draggable={false} className="absolute inset-0 h-full w-full object-cover" />
            ) : (
              <>
                <span aria-hidden className="absolute inset-0">
                  <Face name={person.name} version={person.avatar} className="absolute inset-0 h-full w-full scale-125 object-cover text-6xl blur-xl" />
                </span>
                <span aria-hidden className="absolute inset-0 bg-black/40" />
                <span className="relative text-sm font-semibold uppercase tracking-wider text-white">offline</span>
              </>
            )}
          </span>
        )}
        {/* the status, the width of the card: whole words, four lines at most */}
        {bio && <span className="line-clamp-4 break-words text-sm leading-snug">{bio}</span>}
        {below}
      </div>
    </div>,
    at.host
  );
}
