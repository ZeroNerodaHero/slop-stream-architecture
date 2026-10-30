import { RiChat3Line, RiCloseLine, RiGroupLine, RiSearchLine, RiUserFollowLine, RiUserHeartLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { Fragment, type ReactNode, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { type Followed, groupWords, type Server } from '@/infra/api';
import { meAtom } from '@/infra/atoms/auth-atoms';
import { dmUnreadAtom, openDm, showDms } from '@/infra/atoms/dm-atoms';
import { followNoteAtom, followingAtom, loadFollowing, search, searchBusyAtom, searchQueryAtom, searchResultsAtom, unfollow } from '@/infra/atoms/follow-atoms';
import { loadMyServers, myServersAtom } from '@/infra/atoms/groups-atoms';
import { type Presence, PRESENCE_SQUARE, PRESENCE_TEXT, PRESENCE_WORD } from '@/infra/atoms/presence-atoms';
import { type PanelSide, setSidebarShares, type SidebarList, sidebarListsAtom, type SidebarShares, sidebarSharesAtom } from '@/infra/atoms/settings-atoms';
import { openUserModal } from '@/infra/atoms/user-modal-atoms';
import { store } from '@/infra/store';
import { Face } from '@/shared-components/Face';
import { FollowButton } from '@/shared-components/FollowButton';
import { GroupMark } from '@/shared-components/GroupMark';
import { LiveMark } from '@/shared-components/LiveMark';
import { PersonCard, usePeek } from '@/shared-components/PersonCard';
import { Who } from '@/shared-components/PersonRow';
import { Bone, Skeleton } from '@/shared-components/Skeleton';
import { Tooltip } from '@/shared-components/Tooltip';
import { INPUT } from '@/shared-components/user-modal/parts';
import { cn } from '@/utils/cn';

const SEARCH_WAIT_MS = 200;
/** How long the pointer rests on a row before the person's card shows: past the panel's 150ms widening, so the card is measured against the open panel. */
const PEEK_MS = 200;
const ICON_BUTTON = 'shrink-0 border border-transparent p-0.5 text-textTertiary hover:border-primaryStroke focus-visible:border-primaryBlue focus-visible:outline-none';
/** A line of words where a list would be: nobody yet, the pointer to an account. */
const NOTE = 'px-3 py-3 text-sm text-textSecondary';
/** How many grey squares stand in the face column before the list has answered. */
const FACES_GUESS = 4;

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
 * for each list its icon line and its faces, with a line between one list and the next. Their
 * sizes, and the gap nothing goes under.
 */
/** A face: 40px and its border. A group's square is the same. */
const FACE_PX = 42;
/** The search box. */
const SEARCH_PX = 40;
/** The icon line over a list: the icon, and the word in text-xs, are both 16px. The chat button at the friends line's end is 14. */
const HEAD_PX = 16;
/** The line between two lists. The room to grab it reaches into the gaps on either side. */
const LINE_PX = 1;
const MIN_GAP = 8;
/**
 * The lists scroll with no bar: a bar takes width from the box, and on the right side that
 * would move the faces, which are the column. Whole rows, so what shows is never half a face.
 */
const SCROLL = 'overflow-y-auto overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden';
const LIST = cn('flex shrink-0 snap-y snap-mandatory flex-col', SCROLL);

/**
 * The gaps that are not between two faces, top to bottom: `top` and `search` around the box,
 * then `head-<i>` under each list's icon line and `line-<i>` under the line before list i+1,
 * only the ones the column has (`gapNames`).
 */
type GapName = string;

/** The room, measured: how many faces fit, and the gap that spends it. */
interface Fit {
  /** The faces there is room for, every list together. 0 until the room is measured: then nothing is cut. */
  rows: number;
  /** The gap everywhere, before the pixels that did not divide are handed out. */
  gap: number;
  /** Those pixels: fewer than there are gaps. */
  left: number;
  /** The gaps that are not between faces, the ones the column has, in stack order. */
  names: GapName[];
}

/** The gaps as laid out, whole pixels each: between the faces of each list, by its place in the stack, and the rest by name. */
interface Spacing {
  lists: number[];
  gaps: Record<GapName, number>;
}

/** The gaps a column of `lists` lists has, in stack order: the box's two, then a head for each list and a line before each but the first. */
function gapNames(lists: number): GapName[] {
  const names: GapName[] = ['top', 'search'];
  for (let i = 0; i < lists; i++) {
    if (i > 0) names.push(`line-${i - 1}`);
    names.push(`head-${i}`);
  }
  return names;
}

/**
 * The math of the column. With `rows` faces at the smallest gap the stack still fits the room;
 * the room left over is then spread over every gap, the same whole number of pixels each, and
 * what does not divide (fewer pixels than there are gaps) is `left` for `spend`. Nothing to
 * lay out (a note, nobody yet): the smallest gap, and no stretching. `lists`: how many lists
 * the stack has, each with its icon line; a search has none, its hits are one list with no line.
 */
function measure(room: number, lists: number, faces: boolean): Fit {
  const names = gapNames(lists);
  if (room <= 0 || !faces) return { rows: 0, gap: MIN_GAP, left: 0, names };
  const blocks = SEARCH_PX + lists * HEAD_PX + Math.max(0, lists - 1) * LINE_PX;
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
 * of a whole list, the longest lists first, each that still fits, then one each on the gaps
 * that are not between faces, top first. Only when the lists fill the room (`rows` sums to all
 * the rows): with fewer, the room left is at the bottom, and stretching a short column to meet
 * the footer would spread it thin. The sum is then the room exactly: the last row ends where
 * the footer begins.
 */
function spend(fit: Fit, rows: number[]): Spacing {
  const gaps: Record<GapName, number> = {};
  const lists = rows.map(() => fit.gap);
  const all = rows.reduce((sum, r) => sum + r, 0);
  let left = fit.rows > 0 && all === fit.rows ? fit.left : 0;
  const longest = rows
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r > 0)
    .sort((a, b) => b.r - a.r);
  for (const { r, i } of longest) {
    if (left >= r) {
      lists[i] = fit.gap + 1;
      left -= r;
    }
  }
  const each = Math.floor(left / fit.names.length);
  const odd = left % fit.names.length;
  fit.names.forEach((n, i) => {
    gaps[n] = fit.gap + each + (i < odd ? 1 : 0);
  });
  return { lists, gaps };
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
 * shows everyone. Streaming, the bottom left corner gets the red broadcast mark (LiveMark.tsx,
 * the one the chat puts beside the streamer's name): closed, the column has no words, and the
 * mark says what the blue square alone does not. The word is in the row's label; the mark's
 * `title` says it on hover.
 */
function RailFace({ name, avatar, presence }: { name: string; avatar: number | null; presence: Presence }) {
  return (
    <span className="relative block shrink-0">
      <Face name={name} version={avatar} />
      {presence === 'streaming' && <LiveMark aria-hidden data-streaming title="streaming" className="absolute -bottom-1 -left-1 border border-background" />}
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
        // streaming: the page holds the player's box from its first paint (WatchPage.tsx)
        state={person.presence === 'streaming' ? { live: true } : undefined}
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

/**
 * How the room is shared: the rows each list gets, in stack order. Each list takes the rows it
 * needs; the weights decide only when together they are longer than the room, and then no list
 * goes under one row. A list shorter than its share takes what it has, and the rows it leaves
 * go to the others by the same weights (settled one at a time: each list settled changes the
 * others' shares), whole rows by largest remainder. Room not measured yet: everything, uncut.
 */
function splitRows(lengths: number[], weights: number[], capacity: number | null): number[] {
  if (capacity === null) return [...lengths];
  const n = Math.max(lengths.length, capacity);
  if (lengths.reduce((sum, l) => sum + l, 0) <= n) return [...lengths];
  /** A list still to be shared out: its place, its length, its weight. */
  type Open = { i: number; len: number; w: number };
  const rows = lengths.map(() => 0);
  let open: Open[] = lengths.map((len, i) => ({ i, len, w: weights[i] ?? 1 }));
  let left = n;
  for (;;) {
    const total = open.reduce((sum, o) => sum + o.w, 0);
    const short = open.find((o) => o.len <= (o.w / total) * left);
    if (!short) break;
    rows[short.i] = short.len;
    left -= short.len;
    open = open.filter((o) => o !== short);
  }
  const total = open.reduce((sum, o) => sum + o.w, 0);
  const shares = open.map((o) => {
    const want = (o.w / total) * left;
    return { i: o.i, whole: Math.floor(want), part: want - Math.floor(want) };
  });
  let spare = left - shares.reduce((sum, s) => sum + s.whole, 0);
  for (const s of [...shares].sort((a, b) => b.part - a.part)) {
    if (spare <= 0) break;
    s.whole++;
    spare--;
  }
  for (const s of shares) rows[s.i] = s.whole;
  // one row at least: a list given none takes one from the list with the most (the room has a row a list: n is at least the count)
  for (const s of shares) {
    if ((rows[s.i] ?? 0) > 0) continue;
    const most = rows.reduce((best, r, j) => (r > (rows[best] ?? 0) ? j : best), 0);
    if ((rows[most] ?? 0) > 1) {
      rows[most] = (rows[most] ?? 0) - 1;
      rows[s.i] = 1;
    }
  }
  return rows;
}

interface DividerProps {
  /** The rows the list above has, and the fewest and the most it may take: the line moves between them. Equal: nothing to drag. */
  value: number;
  min: number;
  max: number;
  /** The words of the two lists, for the label. */
  above: string;
  below: string;
  /** Dragged or stepped to `want` rows for the list above; the one below gets what the pair has left. */
  onMove: (want: number) => void;
  /** A row, face and gap: the two lists' averaged. */
  pitch: number;
  /** The gap under the line. */
  gap: number;
  open: boolean;
  side: PanelSide;
}

/**
 * The line between one list and the next. Both longer than the room: drag it, and a row moves
 * from one list to the other, whole rows only (arrow keys do the same, one row a press). The
 * shares it sets are this browser's (settings.sidebarShares). One pixel in the stack; the room
 * to grab it reaches 8px into the gaps above and below.
 */
function Divider({ value, min, max, above, below, onMove, pitch, gap, open, side }: DividerProps) {
  const drag = useRef<{ y: number; from: number } | null>(null);
  const draggable = min < max;
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label={`rows for ${above}, the rest for ${below}`}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      tabIndex={draggable ? 0 : -1}
      title={draggable ? 'drag: a row more for one list, one fewer for the other' : undefined}
      onPointerDown={(e) => {
        if (!draggable) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { y: e.clientY, from: value };
      }}
      onPointerMove={(e) => {
        if (drag.current) onMove(drag.current.from + Math.round((e.clientY - drag.current.y) / pitch));
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
        onMove(value + (e.key === 'ArrowUp' ? -1 : 1));
      }}
      className={cn(
        "group relative flex shrink-0 touch-none select-none outline-none before:absolute before:inset-x-0 before:-inset-y-2 before:content-['']",
        draggable && 'cursor-row-resize',
        open ? INSET[side] : COLUMN
      )}
      style={{ height: LINE_PX, marginBottom: gap }}
    >
      <span
        className={cn('h-px bg-primaryStroke transition-colors group-hover:bg-secondaryStroke group-focus-visible:bg-primaryBlue', open ? 'w-full' : 'mx-auto w-6')}
      />
    </div>
  );
}

/**
 * One group you are in (docs/groups.md), the shape of a person's row: its square where the face
 * goes (the picture, or its letter on its colour, the size of a face), and open, the title with
 * its four digits and how many in it are live, else how many are in it. Live members are the
 * number on the square's corner, closed or open, in the blue of the streaming count. The whole
 * row is the way to the group's page. No card: the page is a click away and says it all.
 */
function GroupRow({ server, side, open, onPick }: { server: Server; side: PanelSide; open: boolean; onPick: () => void }) {
  const mirrored = side === 'right';
  const words = groupWords(server);
  const live = server.live?.length ?? 0;
  const count = live > 0 ? `${live} live` : `${server.members} ${server.members === 1 ? 'member' : 'members'}`;
  return (
    <li className={cn('flex snap-start items-center gap-1', mirrored && 'flex-row-reverse', INSET[side])} data-live={live}>
      <Link
        id={`sidebar-group-${server.name}`}
        to={`/groups/${encodeURIComponent(server.name)}`}
        onClick={onPick}
        draggable={false}
        aria-label={`${words.title}${words.tag ? ` #${words.tag}` : ''} · ${count}`}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-2 border border-transparent outline-none hover:border-primaryStroke focus-visible:border-primaryBlue',
          mirrored && 'flex-row-reverse'
        )}
      >
        <span className="relative block shrink-0">
          <GroupMark name={server.name} color={server.color} icon={server.icon} className="h-10 w-10 border border-primaryStroke text-lg" />
          {live > 0 && (
            <span
              aria-hidden
              className="absolute -bottom-1 -right-1 flex h-4 min-w-4 items-center justify-center border-2 border-background bg-primaryBlue px-0.5 text-[10px] font-semibold leading-none text-background"
            >
              {live}
            </span>
          )}
        </span>
        {open && (
          <span className={cn('flex min-w-0 flex-1 flex-col leading-tight', mirrored && 'items-end text-right')}>
            <span className={cn('flex min-w-0 max-w-full items-baseline gap-1 text-sm', mirrored && 'flex-row-reverse')}>
              <span className="truncate font-semibold">{words.title}</span>
              {words.tag && <span className="shrink-0 text-xs text-textTertiary">#{words.tag}</span>}
            </span>
            <span className={cn('text-xs', live > 0 ? 'text-primaryBlue' : 'text-textSecondary')}>{count}</span>
          </span>
        )}
      </Link>
    </li>
  );
}

/** One of the column's lists with what it holds: people (friends, the rest you follow) or the groups you are in. */
type Block = { kind: 'friends' | 'following'; people: Followed[] } | { kind: 'groups'; servers: Server[] };

function lengthOf(block: Block): number {
  return block.kind === 'groups' ? block.servers.length : block.people.length;
}

/** The icon over each list, its word, and its id. The tests read `#mutual-list` (friends) and `#friends-list` (the rest). */
const LIST_WORDS: Record<SidebarList, { icon: typeof RiUserHeartLine; word: string; id: string }> = {
  friends: { icon: RiUserHeartLine, word: 'friends', id: 'mutual-list' },
  following: { icon: RiUserFollowLine, word: 'following', id: 'friends-list' },
  groups: { icon: RiGroupLine, word: 'groups', id: 'groups-list' }
};

interface ListsProps extends ListProps {
  /** The lists shown, top to bottom: the ones settings switched on that hold something, in the order it put them. */
  stack: Block[];
  /** The rows each has, in the same order. */
  rows: number[];
  spacing: Spacing;
  /** The weights the rows were shared by, which the lines between the lists move. */
  shares: SidebarShares;
}

/**
 * The lists under their icons, a line between one and the next: friends (they follow you back),
 * everyone else you follow, each streaming first as the api sent them, and the groups you are
 * in, in the order settings put them (settings.sidebarLists). A friend gets a chat button as
 * well as unfollow, and the friends line ends with `chat`, which brings the chat window back; a
 * group's row is the way to its page. Each list is cut at whole rows (`rows`) and scrolls inside,
 * at the pitch `spacing` worked out for the room; the line between two lists says how the rows
 * are shared, and dragging it trades a row between them, keeping every list's weight as the rows
 * then stand (as fractions of the room, so a taller window keeps the proportion). A list nobody
 * is in has no icon either. Closed, the words have no room: only the faces.
 */
function Lists({ side, open, onPick, stack, rows, spacing, shares }: ListsProps) {
  const unread = useAtomValue(dmUnreadAtom);
  const { gaps } = spacing;
  const all = rows.reduce((sum, r) => sum + r, 0);
  // each list with its numbers, so a place in the stack is read once
  const laid = stack.map((block, i) => ({ block, length: lengthOf(block), rows: rows[i] ?? 0, gap: spacing.lists[i] ?? MIN_GAP }));

  // the line under list i dragged to `want` rows for it: the pair trades rows, the others keep theirs
  const moveLine = (i: number, want: number) => {
    const upper = laid[i];
    const lower = laid[i + 1];
    if (!upper || !lower || all === 0) return;
    const pair = upper.rows + lower.rows;
    // the list above keeps one row at least and takes no more than it has; the one below likewise, from what the pair has
    const lo = Math.max(1, pair - lower.length);
    const hi = Math.min(upper.length, pair - 1);
    const a = Math.min(hi, Math.max(lo, want));
    if (a === upper.rows) return;
    const next = laid.map((l, j) => (j === i ? a : j === i + 1 ? pair - a : l.rows));
    const weight = laid.reduce((sum, l) => sum + shares[l.block.kind], 0);
    setSidebarShares(Object.fromEntries(laid.map((l, j) => [l.block.kind, ((next[j] ?? 0) / all) * weight])) as Partial<SidebarShares>);
  };

  return (
    <>
      {laid.map(({ block, length, rows: count, gap }, i) => {
        const { icon, word, id } = LIST_WORDS[block.kind];
        const pitch = FACE_PX + gap;
        const before = laid[i - 1];
        const pair = before ? before.rows + count : 0;
        return (
          <Fragment key={block.kind}>
            {before && (
              <Divider
                value={before.rows}
                min={Math.max(1, pair - length)}
                max={Math.min(before.length, pair - 1)}
                above={LIST_WORDS[before.block.kind].word}
                below={word}
                onMove={(want) => moveLine(i - 1, want)}
                pitch={(FACE_PX + before.gap + pitch) / 2}
                gap={gaps[`line-${i - 1}`] ?? MIN_GAP}
                open={open}
                side={side}
              />
            )}
            <Head
              icon={icon}
              word={word}
              count={length}
              open={open}
              side={side}
              below={gaps[`head-${i}`] ?? MIN_GAP}
              action={block.kind === 'friends' ? <ChatsOpener /> : undefined}
              mark={block.kind === 'friends' ? unread : undefined}
            />
            <ul id={id} aria-label={word} className={LIST} style={{ height: count * pitch, gap }}>
              {block.kind === 'groups'
                ? block.servers.map((server) => <GroupRow key={server.name} server={server} side={side} open={open} onPick={onPick} />)
                : block.people.map((f) => (
                    <Row key={f.name} id={`friend-${f.name}`} person={f} side={side} open={open} onPick={onPick}>
                      {block.kind === 'friends' && <Chat id={`friend-chat-${f.name}`} person={f} />}
                      <Unfollow id={`friend-unfollow-${f.name}`} name={f.name} />
                    </Row>
                  ))}
            </ul>
          </Fragment>
        );
      })}
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

/**
 * The column before the list has answered: a face's worth of grey where each face goes, in the
 * face column, with a name's worth beside it while the panel is open. The smallest gap, like a
 * column with nothing to stretch; the faces land on the squares.
 */
function FollowingSkeleton({ side, open }: { side: PanelSide; open: boolean }) {
  const mirrored = side === 'right';
  return (
    <Skeleton id="friends-loading" className="flex flex-col gap-2">
      {Array.from({ length: FACES_GUESS }, (_, i) => (
        <div key={i} className={cn('flex items-center gap-2', mirrored && 'flex-row-reverse', INSET[side])}>
          {/* FACE_PX square */}
          <Bone className="h-[42px] w-[42px] shrink-0" />
          {open && <Bone className="h-3.5 w-24" />}
        </div>
      ))}
    </Skeleton>
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
 * The body of the sidebar (docs/follows.md), in both of its states: the search box, then the
 * lists, each under its icon with a line between one and the next: friends, the rest of who you
 * follow, the groups you are in, in the order settings put them and only the ones it switched
 * on (settings.sidebarLists). Closed, each is a square in one column (the box is its icon, the
 * icons stand alone); open, the same squares stay where they are and the words and buttons
 * come out beside them, so what you were pointing at is still under the pointer. The whole
 * column is one stack with one gap between everything, sized (`measure`) so that the lists,
 * cut at whole rows, spend the room exactly; the lines between them, which drag, say how the
 * rows are shared. The site's one search: letters in the box put what they find where the
 * lists were, each row with the buttons its list would give it, a follow button for a name you
 * do not follow; closing the panel empties it. Every open asks `GET /api/following` again, and
 * `GET /api/explore` for the groups while they are shown, so the words are now.
 */
export function Friends({ open, side, onPick }: FriendsProps) {
  const me = useAtomValue(meAtom);
  const all = useAtomValue(followingAtom);
  const servers = useAtomValue(myServersAtom);
  const choices = useAtomValue(sidebarListsAtom);
  const shares = useAtomValue(sidebarSharesAtom);
  const query = useAtomValue(searchQueryAtom);
  const note = useAtomValue(followNoteAtom);
  const stack = useRef<HTMLDivElement | null>(null);
  // the room for the stack, box included. 0 until measured: then nothing is cut
  const [room, setRoom] = useState(0);
  const mirrored = side === 'right';
  const groupsOn = choices.some((c) => c.list === 'groups' && c.on);

  // the room follows the window (and the note under the lists, when there is one)
  useEffect(() => {
    const el = stack.current;
    if (!el) return;
    const watch = new ResizeObserver(() => setRoom(el.clientHeight));
    watch.observe(el);
    return () => watch.disconnect();
  }, []);

  // every open: the lists again, fresh words (the groups only while the column shows them). every close: the box
  // empty, so the column is who you follow and not the last search
  useEffect(() => {
    if (open) {
      void loadFollowing();
      if (groupsOn) void loadMyServers();
    } else store.set(searchQueryAtom, '');
  }, [open, groupsOn]);

  // the search, a beat after the last keystroke
  useEffect(() => {
    const t = window.setTimeout(() => void search(query), SEARCH_WAIT_MS);
    return () => window.clearTimeout(t);
  }, [query]);

  const searching = query.trim() !== '';
  const list = me ? all : undefined;
  const friends = list?.filter((f) => f.mutual) ?? [];
  const rest = list?.filter((f) => !f.mutual) ?? [];
  const groups = me ? (servers ?? []) : [];
  const holds: Record<SidebarList, number> = { friends: friends.length, following: rest.length, groups: groups.length };
  // the lists in the stack: the ones switched on that hold something, in the order settings put them
  const blocks: Block[] = choices
    .filter((c) => c.on && holds[c.list] > 0)
    .map((c): Block => (c.list === 'groups' ? { kind: 'groups', servers: groups } : { kind: c.list, people: c.list === 'friends' ? friends : rest }));
  const faces = searching || blocks.length > 0;
  const fit = measure(room, searching ? 0 : blocks.length, faces);
  const rows = splitRows(
    blocks.map(lengthOf),
    blocks.map((block) => shares[block.kind]),
    room > 0 ? fit.rows : null
  );
  const spacing = spend(fit, searching ? [] : rows);

  // a login whose lists have not answered (the groups only while shown): grey squares where the faces go, closed and open alike
  const loading = !!me && (list === undefined || (groupsOn && servers === undefined));
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
  } else if (!loading && blocks.length === 0) {
    // everyone is in a list that is switched off; or nobody yet, and the way to someone (or to a group, when the people lists are off)
    if (choices.some((c) => !c.on && holds[c.list] > 0)) {
      words = (
        <p className={NOTE}>
          what you have is in a list that is off.{' '}
          <button type="button" onClick={() => openUserModal('settings')} className="text-primaryBlue underline-offset-2 hover:underline">
            settings
          </button>
        </p>
      );
    } else if (choices.some((c) => c.on && c.list !== 'groups')) {
      words = <p className={NOTE}>nobody yet. find someone above.</p>;
    } else {
      words = (
        <p className={NOTE}>
          no groups yet.{' '}
          <button type="button" onClick={() => openUserModal('groups')} className="text-primaryBlue underline-offset-2 hover:underline">
            join one
          </button>
        </p>
      );
    }
  }

  return (
    <div id="friends" role="region" aria-label="following and groups" className="flex min-h-0 flex-1 flex-col">
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
        ) : loading ? (
          <FollowingSkeleton side={side} open={open} />
        ) : words ? (
          open && words
        ) : (
          <Lists side={side} open={open} onPick={onPick} stack={blocks} rows={rows} spacing={spacing} shares={shares} />
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
