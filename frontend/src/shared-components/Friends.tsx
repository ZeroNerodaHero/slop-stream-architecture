import { RiBroadcastLine, RiChat3Line, RiCloseLine, RiSearchLine, RiUserFollowLine, RiUserHeartLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import type { Followed } from '@/infra/api';
import { meAtom } from '@/infra/atoms/auth-atoms';
import { dmUnreadAtom, openDm, showDms } from '@/infra/atoms/dm-atoms';
import { followNoteAtom, followingAtom, loadFollowing, search, searchBusyAtom, searchQueryAtom, searchResultsAtom, unfollow } from '@/infra/atoms/follow-atoms';
import { type Presence, PRESENCE_SQUARE, PRESENCE_TEXT, PRESENCE_WORD } from '@/infra/atoms/presence-atoms';
import { friendsShareAtom, type PanelSide, setFriendsShare } from '@/infra/atoms/settings-atoms';
import { openUserModal } from '@/infra/atoms/user-modal-atoms';
import { store } from '@/infra/store';
import { Face } from '@/shared-components/Face';
import { FollowButton } from '@/shared-components/FollowButton';
import { PersonCard, usePeek } from '@/shared-components/PersonCard';
import { Who } from '@/shared-components/PersonRow';
import { Tooltip } from '@/shared-components/Tooltip';
import { INPUT } from '@/shared-components/user-modal/parts';
import { cn } from '@/utils/cn';

const SEARCH_WAIT_MS = 200;
/** How long the pointer rests on a row before the person's card shows: past the panel's 150ms widening, so the card is measured against the open panel. */
const PEEK_MS = 200;
const ICON_BUTTON = 'shrink-0 border border-transparent p-0.5 text-textTertiary hover:border-primaryStroke focus-visible:border-primaryBlue focus-visible:outline-none';
/** A line of words where a list would be: nobody yet, loading, the pointer to an account. */
const NOTE = 'px-3 py-3 text-sm text-textSecondary';

/**
 * The column of faces: 40px squares with a 1px border around each, 19px in from the panel's
 * edge, which centers them in the closed panel and lines them up with you at the bottom. The
 * panel grows away from that edge (docs/follows.md), so on the right side each row is mirrored
 * and the faces stay put there too.
 */
const INSET: Record<PanelSide, string> = { left: 'pl-[19px] pr-2', right: 'pr-[19px] pl-2' };
/** The face column alone, for a line that has nothing beside the column: the icon, the divider. */
const COLUMN = 'px-[19px]';

/**
 * The column is a stack of blocks, each followed by the same gap, whole pixels: the box, then
 * for each list its icon line and its faces, with the line between the two lists. Their sizes,
 * and the gap nothing goes under.
 */
/** A face: 40px and its border. */
const FACE_PX = 42;
/** The search box. */
const SEARCH_PX = 40;
/** The icon line over a list: the icon, and the word in text-xs, are both 16px. The chat button at the friends line's end is 14. */
const HEAD_PX = 16;
/** The line between the lists. The room to grab it reaches into the gaps on either side. */
const LINE_PX = 1;
const MIN_GAP = 8;
/**
 * The lists scroll with no bar: a bar takes width from the box, and on the right side that
 * would move the faces, which are the column. Whole rows, so what shows is never half a face.
 */
const SCROLL = 'overflow-y-auto overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden';
const LIST = cn('flex shrink-0 snap-y snap-mandatory flex-col', SCROLL);

/** The gaps that are not between two faces, top to bottom. `headA`, `line`, `headB` only when that block is there. */
type GapName = 'top' | 'search' | 'headA' | 'line' | 'headB';
const GAP_ORDER: readonly GapName[] = ['top', 'search', 'headA', 'line', 'headB'];

/** Which blocks besides the box and the faces the column has. */
interface Parts {
  headA: boolean;
  line: boolean;
  headB: boolean;
}

/** The room, measured: how many faces fit, and the gap that spends it. */
interface Fit {
  /** The faces there is room for, both lists together. 0 until the room is measured: then nothing is cut. */
  rows: number;
  /** The gap everywhere, before the pixels that did not divide are handed out. */
  gap: number;
  /** Those pixels: fewer than there are gaps. */
  left: number;
  /** The gaps that are not between faces, the ones the column has. */
  names: GapName[];
}

/** The gaps as laid out, whole pixels each: between the faces of each list, and the rest by name. */
interface Spacing {
  listA: number;
  listB: number;
  gaps: Record<GapName, number>;
}

/**
 * The math of the column. With `rows` faces at the smallest gap the stack still fits the room;
 * the room left over is then spread over every gap, the same whole number of pixels each, and
 * what does not divide (fewer pixels than there are gaps) is `left` for `spend`. Nothing to
 * lay out (a note, nobody yet): the smallest gap, and no stretching.
 */
function measure(room: number, parts: Parts, faces: boolean): Fit {
  const names = GAP_ORDER.filter((n) => n === 'top' || n === 'search' || parts[n]);
  if (room <= 0 || !faces) return { rows: 0, gap: MIN_GAP, left: 0, names };
  const blocks = SEARCH_PX + (parts.headA ? HEAD_PX : 0) + (parts.line ? LINE_PX : 0) + (parts.headB ? HEAD_PX : 0);
  const rows = Math.floor((room - blocks - names.length * MIN_GAP) / (FACE_PX + MIN_GAP));
  // a window too short for one row: one row anyway, cut off by the panel
  if (rows < 1) return { rows: 1, gap: MIN_GAP, left: 0, names };
  const spare = room - blocks - rows * FACE_PX;
  const count = names.length + rows;
  const gap = Math.floor(spare / count);
  return { rows, gap, left: spare - gap * count, names };
}

/**
 * The pixels that did not divide, handed out a pixel a gap so that no gap is more than a pixel
 * or two from another, and the faces inside a list keep one pitch: first a pixel on every gap
 * of a whole list, the biggest that fits (both lists, then the longer, then the shorter), then
 * one each on the gaps that are not between faces, top first. Only when the two lists fill the
 * room (`rowsA + rowsB` is all the rows): with fewer, the room left is at the bottom, and
 * stretching a short column to meet the footer would spread it thin. The sum is then the room
 * exactly: the last row ends where the footer begins.
 */
function spend(fit: Fit, rowsA: number, rowsB: number): Spacing {
  const gaps = { top: 0, search: 0, headA: 0, line: 0, headB: 0 };
  for (const n of fit.names) gaps[n] = fit.gap;
  let listA = fit.gap;
  let listB = fit.gap;
  let left = fit.rows > 0 && rowsA + rowsB === fit.rows ? fit.left : 0;
  if (rowsA + rowsB > 0 && left >= rowsA + rowsB) {
    listA++;
    listB++;
    left -= rowsA + rowsB;
  } else if (rowsA >= rowsB && rowsA > 0 && left >= rowsA) {
    listA++;
    left -= rowsA;
  } else if (rowsB > 0 && left >= rowsB) {
    listB++;
    left -= rowsB;
  } else if (rowsA > 0 && left >= rowsA) {
    listA++;
    left -= rowsA;
  }
  const each = Math.floor(left / fit.names.length);
  const odd = left % fit.names.length;
  fit.names.forEach((n, i) => {
    gaps[n] += each + (i < odd ? 1 : 0);
  });
  return { listA, listB, gaps };
}

/** Enough of somebody for a row: a followed name and a search hit both have it. */
interface Person {
  name: string;
  verified: boolean;
  avatar: number | null;
  bio: string;
  presence: Presence;
}

/**
 * The picture and the presence square in its bottom right corner, the way the closed panel
 * shows everyone. Streaming, the bottom left corner gets the broadcast icon in red (the inbox's
 * mark for a go-live, Notifications.tsx): closed, the column has no words, and the icon says
 * what the blue square alone does not. The word is in the row's label; the icon's `title` says
 * it on hover.
 */
function RailFace({ name, avatar, presence }: { name: string; avatar: number | null; presence: Presence }) {
  return (
    <span className="relative block shrink-0">
      <Face name={name} version={avatar} />
      {presence === 'streaming' && (
        <span
          aria-hidden
          data-streaming
          title="streaming"
          className="absolute -bottom-1 -left-1 flex h-4 w-4 items-center justify-center border border-background bg-decrease text-background"
        >
          <RiBroadcastLine size={10} />
        </span>
      )}
      <span aria-hidden data-presence={presence} className={cn('absolute -bottom-1 -right-1 h-3.5 w-3.5 border-2 border-background', PRESENCE_SQUARE[presence])} />
    </span>
  );
}

interface RowProps {
  id: string;
  person: Person;
  side: PanelSide;
  open: boolean;
  onPick: () => void;
  /** The buttons past the name while open: chat and unfollow, or follow. */
  children?: ReactNode;
}

/**
 * One person, closed and open alike: the face is in the same place either way, and opening
 * puts the name, the word for how they are, and the buttons beside it instead of moving
 * anything. The face and the name are one link to their page. The pointer resting on the row,
 * or the focus landing in it, puts the person's card (PersonCard.tsx, the chat window's too)
 * beside the panel: the face, the name, how they are, the bio.
 */
function Row({ id, person, side, open, onPick, children }: RowProps) {
  const mirrored = side === 'right';
  const peek = usePeek(PEEK_MS);
  return (
    <li
      className={cn('flex snap-start items-center gap-1', mirrored && 'flex-row-reverse', INSET[side])}
      data-presence={person.presence}
      onPointerEnter={(e) => peek.show(e.currentTarget, e.currentTarget.closest('#friends'))}
      onPointerLeave={(e) => peek.leave(e.currentTarget)}
      onFocus={(e) => peek.show(e.currentTarget, e.currentTarget.closest('#friends'))}
      onBlur={peek.blur}
    >
      <Link
        id={id}
        to={`/watch/${encodeURIComponent(person.name)}`}
        onClick={onPick}
        // not draggable: the face must not lift off the row as a ghost link
        draggable={false}
        aria-label={`${person.name} · ${PRESENCE_WORD[person.presence]}`}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-2 border border-transparent outline-none hover:border-primaryStroke focus-visible:border-primaryBlue',
          mirrored && 'flex-row-reverse'
        )}
      >
        <RailFace name={person.name} avatar={person.avatar} presence={person.presence} />
        {open && (
          <span className={cn('flex min-w-0 flex-1 flex-col leading-tight', mirrored && 'items-end text-right')}>
            <Who name={person.name} verified={person.verified} className="max-w-full text-sm" />
            <span className={cn('text-xs', PRESENCE_TEXT[person.presence])}>{PRESENCE_WORD[person.presence]}</span>
          </span>
        )}
      </Link>
      {open && children}
      {open && peek.at && <PersonCard id={`friends-peek-${person.name}`} person={person} at={peek.at} side={side} />}
    </li>
  );
}

function Unfollow({ id, name }: { id: string; name: string }) {
  return (
    <Tooltip content="unfollow">
      <button id={id} type="button" aria-label={`stop following ${name}`} onClick={() => void unfollow(name)} className={cn(ICON_BUTTON, 'hover:text-decrease')}>
        <RiCloseLine aria-hidden size={16} />
      </button>
    </Tooltip>
  );
}

function Chat({ id, person }: { id: string; person: Person }) {
  return (
    <Tooltip content="chat">
      <button
        id={id}
        type="button"
        aria-label={`chat with ${person.name}`}
        onClick={() => openDm({ id: '', name: person.name, avatar: person.avatar, verified: person.verified, bio: person.bio, presence: person.presence })}
        className={cn(ICON_BUTTON, 'hover:text-textPrimary')}
      >
        <RiChat3Line aria-hidden size={16} />
      </button>
    </Tooltip>
  );
}

/**
 * The chat window back on screen (FriendChat.tsx): the chats as they were left, or the friends
 * to pick one from, and how many lines are new (docs/dms.md), in blue like the streaming count.
 * The far end of the friends line, open only. The footer's action (UserPanel.tsx) in size and
 * colour; leading-none, since text-sm's own 20px line would stand out of the 16px head.
 */
function ChatsOpener() {
  const unread = useAtomValue(dmUnreadAtom);
  return (
    <button
      id="chats-open"
      type="button"
      title={unread > 0 ? `your chats: ${unread} new` : 'your chats with friends'}
      onClick={showDms}
      className="inline-flex shrink-0 items-center gap-1 text-sm leading-none text-textSecondary underline-offset-2 hover:text-textPrimary hover:underline"
    >
      <RiChat3Line aria-hidden size={14} />
      chat
      {unread > 0 && (
        <span id="chats-unread" className="font-semibold text-primaryBlue">
          {unread}
        </span>
      )}
    </button>
  );
}

interface ListProps {
  side: PanelSide;
  open: boolean;
  onPick: () => void;
}

/** The icon over a list, and open, the word and how many, with `action` at the far end of the line. Closed, the icon alone; no list, no icon. `below`: the gap under it. */
function Head({
  icon: Icon,
  word,
  count,
  open,
  side,
  below,
  action,
  mark
}: {
  icon: typeof RiUserHeartLine;
  word: string;
  count: number;
  open: boolean;
  side: PanelSide;
  below: number;
  /** A button at the end of the line, away from the icon. Open only, like the word. */
  action?: ReactNode;
  /** A number on the icon's corner, closed or open: the lines new in the chats (docs/dms.md). 0 for none. */
  mark?: number;
}) {
  return (
    <div
      className={cn('flex shrink-0 items-center gap-2 text-textTertiary', side === 'right' && 'flex-row-reverse', INSET[side])}
      style={{ height: HEAD_PX, marginBottom: below }}
    >
      {/* the icon and the word say what the list's own label says, so readers skip them; the button they do not */}
      <span aria-hidden className="relative flex w-[42px] shrink-0 justify-center">
        <Icon size={16} />
        {/* the number stands with the closed column too, where the chat button has no room: the one sign something came */}
        {mark !== undefined && mark > 0 && (
          <span
            id="friends-unread"
            className="absolute -top-1.5 right-1 flex h-4 min-w-4 items-center justify-center border border-background bg-primaryBlue px-0.5 text-[10px] font-semibold leading-none text-background"
          >
            {mark > 99 ? '99+' : mark}
          </span>
        )}
      </span>
      {open && (
        <>
          {/* the word takes the room, so the action sits at the far end on either side */}
          <span aria-hidden className={cn('min-w-0 flex-1 truncate text-xs font-semibold uppercase leading-none tracking-wider', side === 'right' && 'text-right')}>
            {word} {count}
          </span>
          {action}
        </>
      )}
    </div>
  );
}

/** How the room is shared: rows for each list, and the rows the line may be dragged between. */
interface Rows {
  friends: number;
  rest: number;
  /** The fewest and the most rows friends may take: the line moves between them. Equal: nothing to drag. */
  lo: number;
  hi: number;
  /** The rows there are room for, both lists together. */
  n: number;
}

/**
 * Each list takes the rows it needs; the share decides only when both are longer than the
 * room, and then neither goes under one row. Room not measured yet: everything, uncut.
 */
function splitRows(friends: number, rest: number, capacity: number | null, share: number): Rows {
  if (capacity === null) return { friends, rest, lo: 0, hi: 0, n: 0 };
  if (friends === 0 || rest === 0) {
    const n = Math.max(1, capacity);
    return { friends: Math.min(friends, n), rest: Math.min(rest, n), lo: 0, hi: 0, n };
  }
  const n = Math.max(2, capacity);
  const want = Math.min(n - 1, Math.max(1, Math.round(share * n)));
  let f = Math.min(friends, want);
  const r = Math.min(rest, n - f);
  f = Math.min(friends, n - r);
  return { friends: f, rest: r, lo: Math.max(1, n - rest), hi: Math.min(n - 1, friends), n };
}

/**
 * The line between friends and the rest. Both lists longer than the room: drag it, and a row
 * moves from one list to the other, whole rows only (arrow keys do the same, one row a press).
 * The share it sets is this browser's (settings.friendsShare). One pixel in the stack; the
 * room to grab it reaches 8px into the gaps above and below. `pitch`: a row, face and gap.
 */
function Divider({ rows, pitch, below, open, side }: { rows: Rows; pitch: number; below: number; open: boolean; side: PanelSide }) {
  const drag = useRef<{ y: number; from: number } | null>(null);
  const draggable = rows.lo < rows.hi;
  const moveTo = (want: number) => setFriendsShare(Math.min(rows.hi, Math.max(rows.lo, want)) / rows.n);
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="rows for friends, the rest for following"
      aria-valuemin={rows.lo}
      aria-valuemax={rows.hi}
      aria-valuenow={rows.friends}
      tabIndex={draggable ? 0 : -1}
      title={draggable ? 'drag: a row more for one list, one fewer for the other' : undefined}
      onPointerDown={(e) => {
        if (!draggable) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { y: e.clientY, from: rows.friends };
      }}
      onPointerMove={(e) => {
        if (drag.current) moveTo(drag.current.from + Math.round((e.clientY - drag.current.y) / pitch));
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
      onKeyDown={(e) => {
        if (!draggable || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
        e.preventDefault();
        moveTo(rows.friends + (e.key === 'ArrowUp' ? -1 : 1));
      }}
      className={cn(
        "group relative flex shrink-0 touch-none select-none outline-none before:absolute before:inset-x-0 before:-inset-y-2 before:content-['']",
        draggable && 'cursor-row-resize',
        open ? INSET[side] : COLUMN
      )}
      style={{ height: LINE_PX, marginBottom: below }}
    >
      <span
        className={cn('h-px bg-primaryStroke transition-colors group-hover:bg-secondaryStroke group-focus-visible:bg-primaryBlue', open ? 'w-full' : 'mx-auto w-6')}
      />
    </div>
  );
}

interface FollowingProps extends ListProps {
  friends: Followed[];
  rest: Followed[];
  rows: Rows;
  spacing: Spacing;
}

/**
 * Friends (they follow you back) under their icon, a line, then everyone else you follow under
 * theirs, each group streaming first, as the api sent them. A friend gets a chat button as well
 * as unfollow, and the friends line ends with `chat`, which brings the chat window back. The one
 * list the tests read (`#friends-list`) is the second group. Each list is cut at whole rows
 * (`rows`) and scrolls inside, at the pitch `spacing` worked out for the room; the line between
 * them says how the rows are shared. A group nobody is in has no icon either. Closed, the words
 * have no room: only the faces.
 */
function Following({ side, open, onPick, friends, rest, rows, spacing }: FollowingProps) {
  const unread = useAtomValue(dmUnreadAtom);
  const { gaps } = spacing;
  const pitchA = FACE_PX + spacing.listA;
  const pitchB = FACE_PX + spacing.listB;
  return (
    <>
      {friends.length > 0 && (
        <>
          <Head icon={RiUserHeartLine} word="friends" count={friends.length} open={open} side={side} below={gaps.headA} action={<ChatsOpener />} mark={unread} />
          <ul id="mutual-list" aria-label="friends" className={LIST} style={{ height: rows.friends * pitchA, gap: spacing.listA }}>
            {friends.map((f) => (
              <Row key={f.name} id={`friend-${f.name}`} person={f} side={side} open={open} onPick={onPick}>
                <Chat id={`friend-chat-${f.name}`} person={f} />
                <Unfollow id={`friend-unfollow-${f.name}`} name={f.name} />
              </Row>
            ))}
          </ul>
        </>
      )}
      {friends.length > 0 && rest.length > 0 && <Divider rows={rows} pitch={(pitchA + pitchB) / 2} below={gaps.line} open={open} side={side} />}
      {rest.length > 0 && (
        <>
          <Head icon={RiUserFollowLine} word="following" count={rest.length} open={open} side={side} below={gaps.headB} />
          <ul id="friends-list" aria-label="following" className={LIST} style={{ height: rows.rest * pitchB, gap: spacing.listB }}>
            {rest.map((f) => (
              <Row key={f.name} id={`friend-${f.name}`} person={f} side={side} open={open} onPick={onPick}>
                <Unfollow id={`friend-unfollow-${f.name}`} name={f.name} />
              </Row>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

/**
 * What the box found, in place of the lists while it holds letters: the same rows, each with the
 * buttons its list would give it. A friend has chat and the ×, someone else you follow the ×
 * alone, and a name you do not follow the follow button. Who you follow is `followingAtom`, the
 * same answer the lists and the follow button read, so a click moves a row from one shape to
 * the next in place.
 */
function Results({ side, open, onPick, gap }: ListProps & { gap: number }) {
  const hits = useAtomValue(searchResultsAtom);
  const busy = useAtomValue(searchBusyAtom);
  const following = useAtomValue(followingAtom);
  if (hits.length === 0) {
    return <p className={cn(NOTE, 'text-textTertiary')}>{busy ? 'searching' : 'nobody called that'}</p>;
  }
  const known = new Map((following ?? []).map((f) => [f.name, f] as const));
  return (
    <ul id="friends-results" className={cn('flex min-h-0 flex-1 flex-col', SCROLL)} style={{ gap, paddingBottom: gap }}>
      {hits.map((h) => {
        const f = known.get(h.name);
        return (
          <Row key={h.name} id={`result-${h.name}`} person={h} side={side} open={open} onPick={onPick}>
            {f?.mutual && <Chat id={`result-chat-${h.name}`} person={h} />}
            {f ? <Unfollow id={`result-unfollow-${h.name}`} name={h.name} /> : <FollowButton id={`result-follow-${h.name}`} name={h.name} small />}
          </Row>
        );
      })}
    </ul>
  );
}

interface FriendsProps {
  /** Widened over the page (hover or focus), or the column of faces. */
  open: boolean;
  side: PanelSide;
  /** A click on a name: the panel closes. */
  onPick: () => void;
}

/**
 * The body of the sidebar (docs/follows.md), in both of its states: the search box, then
 * friends under their icon, a line, then the rest of who you follow under theirs. Closed, each
 * is a square in one column (the box is its icon, the icons stand alone); open, the same
 * squares stay where they are and the words and buttons come out beside them, so what you were
 * pointing at is still under the pointer. The whole column is one stack with one gap between
 * everything, sized (`measure`) so that the lists, cut at whole rows, spend the room exactly;
 * the line between them, which drags, says how the rows are shared. The site's one search:
 * letters in the box put what they find where the lists were, each row with the buttons its
 * list would give it, a follow button for a name you do not follow; closing the panel empties
 * it. Every open asks `GET /api/following` again, so the words are now.
 */
export function Friends({ open, side, onPick }: FriendsProps) {
  const me = useAtomValue(meAtom);
  const all = useAtomValue(followingAtom);
  const share = useAtomValue(friendsShareAtom);
  const query = useAtomValue(searchQueryAtom);
  const note = useAtomValue(followNoteAtom);
  const stack = useRef<HTMLDivElement | null>(null);
  // the room for the stack, box included. 0 until measured: then nothing is cut
  const [room, setRoom] = useState(0);
  const mirrored = side === 'right';

  // the room follows the window (and the note under the lists, when there is one)
  useEffect(() => {
    const el = stack.current;
    if (!el) return;
    const watch = new ResizeObserver(() => setRoom(el.clientHeight));
    watch.observe(el);
    return () => watch.disconnect();
  }, []);

  // every open: the list again, fresh words. every close: the box empty, so the column is who you follow and not the last search
  useEffect(() => {
    if (open) void loadFollowing();
    else store.set(searchQueryAtom, '');
  }, [open]);

  // the search, a beat after the last keystroke
  useEffect(() => {
    const t = window.setTimeout(() => void search(query), SEARCH_WAIT_MS);
    return () => window.clearTimeout(t);
  }, [query]);

  const searching = query.trim() !== '';
  const list = me ? all : undefined;
  const friends = list?.filter((f) => f.mutual) ?? [];
  const rest = list?.filter((f) => !f.mutual) ?? [];
  const faces = searching || friends.length > 0 || rest.length > 0;
  const fit = measure(
    room,
    searching ? { headA: false, line: false, headB: false } : { headA: friends.length > 0, line: friends.length > 0 && rest.length > 0, headB: rest.length > 0 },
    faces
  );
  const rows = splitRows(friends.length, rest.length, room > 0 ? fit.rows : null, share);
  const spacing = spend(fit, searching ? 0 : rows.friends, searching ? 0 : rows.rest);

  // where the lists would be, when there are none to show: words, open only
  let words: ReactNode = null;
  if (!me) {
    words = (
      <p className={NOTE}>
        following is for accounts: who is streaming, right here, every time you look.{' '}
        <button type="button" onClick={() => openUserModal('security')} className="text-primaryBlue underline-offset-2 hover:underline">
          sign up or log in
        </button>
        . searching works anyway.
      </p>
    );
  } else if (list === undefined) words = <p className={cn(NOTE, 'text-textTertiary')}>loading</p>;
  else if (list.length === 0) words = <p className={NOTE}>nobody yet. find someone above.</p>;

  return (
    <div id="friends" role="region" aria-label="following" className="flex min-h-0 flex-1 flex-col">
      <div ref={stack} className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className={cn('shrink-0', INSET[side])} style={{ paddingTop: spacing.gaps.top, paddingBottom: spacing.gaps.search }}>
          <label htmlFor="friends-search" className="sr-only">
            find someone
          </label>
          {/* closed, the box is a square the size of a face with the icon in it; open, it runs the width of the panel and the icon stays where it was */}
          <div className={cn('relative', open ? 'w-full' : 'w-[42px]', mirrored && 'ml-auto')}>
            <RiSearchLine
              aria-hidden
              size={18}
              className={cn('pointer-events-none absolute top-1/2 -translate-y-1/2 text-textTertiary', mirrored ? 'right-3' : 'left-3')}
            />
            <input
              id="friends-search"
              type="search"
              value={query}
              onChange={(e) => store.set(searchQueryAtom, e.target.value)}
              placeholder="find someone to follow"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              className={cn(INPUT, 'h-10 text-sm', open ? (mirrored ? 'pl-3 pr-12' : 'pl-12 pr-3') : 'px-0 text-transparent placeholder:text-transparent')}
            />
          </div>
        </div>
        {searching ? (
          <Results side={side} open={open} onPick={onPick} gap={fit.gap} />
        ) : words ? (
          open && words
        ) : (
          <Following side={side} open={open} onPick={onPick} friends={friends} rest={rest} rows={rows} spacing={spacing} />
        )}
      </div>
      {open && note && (
        <p id="friends-note" aria-live="polite" className="border-t border-primaryStroke px-3 py-1.5 text-sm text-decrease">
          {note}
        </p>
      )}
    </div>
  );
}
