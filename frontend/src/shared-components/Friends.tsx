import { RiArrowDownSLine, RiChat3Line, RiCloseLine, RiGroupLine, RiSearchLine, RiUserFollowLine, RiUserHeartLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { Fragment, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { type Followed, groupMatches, groupWords, type Server } from '@/infra/api';
import { meAtom } from '@/infra/atoms/auth-atoms';
import { dmsAtom, openDm } from '@/infra/atoms/dm-atoms';
import { followNoteAtom, followingAtom, loadFollowing, searchQueryAtom, searchResultsAtom, setSearchQuery, unfollow } from '@/infra/atoms/follow-atoms';
import { loadMyServers, loadServers, myServersAtom, publicServersAtom, SERVERS_FRESH_MS } from '@/infra/atoms/groups-atoms';
import { type Presence, PRESENCE_WORD } from '@/infra/atoms/presence-atoms';
import {
  type PanelSide,
  setSidebarFolded,
  setSidebarShares,
  type SidebarFolds,
  sidebarFoldsAtom,
  type SidebarList,
  sidebarListsAtom,
  type SidebarShares,
  sidebarSharesAtom,
  textSizeAtom
} from '@/infra/atoms/settings-atoms';
import { openUserModal } from '@/infra/atoms/user-modal-atoms';
import { useIsMobile } from '@/infra/mobile';
import { Face } from '@/shared-components/Face';
import { FollowButton } from '@/shared-components/FollowButton';
import { FACE_COLUMN_W, FollowingSkeleton, INSET, MIN_GAP, RAIL_FACE, TOP_EXTRA_PX } from '@/shared-components/FriendsSkeleton';
import { GroupMark } from '@/shared-components/GroupMark';
import { PersonCard } from '@/shared-components/PersonCard';
import { usePeek } from '@/shared-components/peek';
import { Who } from '@/shared-components/PersonRow';
import { PresenceSquare } from '@/shared-components/PresenceSquare';
import { StreamStill } from '@/shared-components/StreamStill';
import { INPUT } from '@/shared-components/input';
import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

const PEEK_MS = 200;
const ICON_BUTTON = 'shrink-0 border border-transparent p-0.5 text-textTertiary hover:border-primaryStroke focus-visible:border-primaryBlue focus-visible:outline-none';
const NOTE = 'px-3 py-3 text-sm text-textSecondary';
const COLUMN = 'px-[calc(0.75rem-1px)] max-md:px-[calc(1.25rem-1px)]';

const FACE_REM = 2;
const MOBILE_FACE_REM = 2.5;
const ROW_BORDER_PX = 2;
const ROW_TAP_PX = 2;
const ROW_TAP = 'max-md:py-px';
const ROW_H = 'relative h-[calc(2rem+2px)] max-md:h-[calc(2.5rem+4px)]';
const HEAD_PX = 16;
const LINE_PX = 1;

interface Sizes {
  face: number;
  search: number;
}

function rootPx(): number {
  const px = parseFloat(getComputedStyle(document.documentElement).fontSize);
  return Number.isFinite(px) && px > 0 ? px : 16;
}

function sizesOf(rem: number, mobile: boolean): Sizes {
  const faceRem = mobile ? MOBILE_FACE_REM : FACE_REM;
  return { face: faceRem * rem + ROW_BORDER_PX + (mobile ? ROW_TAP_PX : 0), search: faceRem * rem };
}

const SCROLL = 'overflow-y-auto overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden';
const SLIDE = 'duration-150 ease-out motion-reduce:transition-none';
const LIST = cn('flex shrink-0 snap-y snap-mandatory flex-col transition-[height,gap]', SLIDE, SCROLL);

type GapName = string;

interface Fit {
  rows: number;
  gap: number;
  left: number;
  names: GapName[];
}

interface Spacing {
  lists: number[];
  gaps: Record<GapName, number>;
}

function gapNames(lists: number): GapName[] {
  const names: GapName[] = ['top', 'search'];
  for (let i = 0; i < lists; i++) {
    if (i > 0) names.push(`line-${i - 1}`);
    names.push(`head-${i}`);
  }
  return names;
}

function measure(room: number, lists: number, faces: boolean, { face, search }: Sizes): Fit {
  const names = gapNames(lists);
  if (room <= 0 || !faces) return { rows: 0, gap: MIN_GAP, left: 0, names };
  const blocks = TOP_EXTRA_PX + search + lists * HEAD_PX + Math.max(0, lists - 1) * LINE_PX;
  const rows = Math.floor((room - blocks - names.length * MIN_GAP) / (face + MIN_GAP));
  if (rows < 1) return { rows: 1, gap: MIN_GAP, left: 0, names };
  const spare = room - blocks - rows * face;
  const count = names.length + rows;
  const gap = Math.floor(spare / count);
  return { rows, gap, left: spare - gap * count, names };
}

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

interface Person {
  name: string;
  verified: boolean;
  oauth_verified?: boolean;
  avatar: number | null;
  bio: string;
  presence: Presence;
}

export function RailFace({ name, avatar, presence }: { name: string; avatar: number | null; presence: Presence }) {
  return (
    <span className="relative block shrink-0">
      <Face name={name} version={avatar} className={RAIL_FACE} />
      <Tooltip content={PRESENCE_WORD[presence]}>
        <PresenceSquare status={presence} className="border-background" />
      </Tooltip>
    </span>
  );
}

interface RowProps {
  id: string;
  person: Person;
  side: PanelSide;
  open: boolean;
  folded?: boolean;
  onPick: () => void;
  children?: ReactNode;
}

function Row({ id, person, side, open, folded = false, onPick, children }: RowProps) {
  const mirrored = side === 'right';
  const peek = usePeek(PEEK_MS);
  return (
    <li
      className={cn('flex snap-start items-center gap-1', mirrored && 'flex-row-reverse', INSET[side])}
      data-presence={person.presence}
      onPointerEnter={(e) => peek.show(e, e.currentTarget.closest('#friends'))}
      onPointerLeave={(e) => peek.leave(e.currentTarget)}
      onFocus={(e) => peek.show(e, e.currentTarget.closest('#friends'))}
      onBlur={peek.blur}
      onKeyDown={peek.keyDown}
    >
      <Link
        id={id}
        to={`/watch/${encodeURIComponent(person.name)}`}
        state={person.presence === 'streaming' ? { live: true } : undefined}
        onClick={onPick}
        draggable={false}
        aria-label={`${person.name} · ${PRESENCE_WORD[person.presence]}`}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-2 border border-transparent outline-none hover:border-primaryStroke focus-visible:border-primaryBlue',
          ROW_TAP,
          ROW_H,
          mirrored && 'flex-row-reverse'
        )}
      >
        <RailFace name={person.name} avatar={person.avatar} presence={person.presence} />
        <span className="sr-only">{PRESENCE_WORD[person.presence]}</span>
        {open && (
          <span className={cn('flex min-w-0 flex-1 leading-tight', mirrored && 'justify-end')}>
            <Who name={person.name} verified={person.verified} oauthVerified={person.oauth_verified} className="max-w-full text-sm" />
          </span>
        )}
        {open && !folded && person.presence === 'streaming' && <StreamStill name={person.name} className="h-8 max-md:h-10" />}
      </Link>
      {open && children}
      {open && peek.at && <PersonCard id={`friends-peek-${person.name}`} person={person} at={peek.at} side={side} hold={peek.hold} />}
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
  const unread = useAtomValue(dmsAtom).find((d) => d.name === person.name)?.unread ?? 0;
  return (
    <Tooltip content={unread > 0 ? `chat, ${unread} new` : 'chat'}>
      <button
        id={id}
        type="button"
        aria-label={unread > 0 ? `chat with ${person.name}, ${unread} new` : `chat with ${person.name}`}
        onClick={() => openDm({ id: '', name: person.name, avatar: person.avatar, verified: person.verified, bio: person.bio, presence: person.presence })}
        className={cn(ICON_BUTTON, 'relative hover:text-textPrimary')}
      >
        <RiChat3Line aria-hidden size={16} />
        {unread > 0 && (
          <span aria-hidden className="absolute -right-1.5 -top-1.5 bg-background px-px text-xs font-semibold leading-none tabular-nums text-primaryBlue">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
    </Tooltip>
  );
}

interface ListProps {
  side: PanelSide;
  open: boolean;
  onPick: () => void;
}

const CARET_ROOM: Record<PanelSide, string> = {
  left: '-ml-[9px] pl-[9px] max-md:-ml-[5px] max-md:pl-[5px]',
  right: '-mr-[9px] pr-[9px] max-md:-mr-[5px] max-md:pr-[5px]'
};
const FOLD = 'relative flex min-w-0 flex-1 items-center gap-2 outline-none transition-colors duration-150 hover:text-textPrimary focus-visible:text-primaryBlue';

interface HeadProps {
  icon: typeof RiUserHeartLine;
  word: string;
  count: number;
  listId: string;
  kind: SidebarList;
  open: boolean;
  side: PanelSide;
  below: number;
  folded: boolean;
  action?: ReactNode;
}

function Head({ icon: Icon, word, count, listId, kind, open, side, below, folded, action }: HeadProps) {
  const mirrored = side === 'right';
  const icon = (
    <span aria-hidden className={cn('flex shrink-0 justify-center', FACE_COLUMN_W)}>
      <Icon size={16} />
    </span>
  );
  return (
    <div
      className={cn('flex shrink-0 items-center gap-2 text-textTertiary transition-[margin-bottom]', SLIDE, mirrored && 'flex-row-reverse', INSET[side])}
      style={{ height: HEAD_PX, marginBottom: below }}
    >
      {open ? (
        <>
          <button
            id={`sidebar-fold-${kind}`}
            type="button"
            aria-expanded={!folded}
            aria-controls={listId}
            title={folded ? `unfold ${word}` : `fold ${word}`}
            onClick={() => setSidebarFolded(kind, !folded)}
            className={cn(FOLD, CARET_ROOM[side], mirrored && 'flex-row-reverse')}
          >
            <RiArrowDownSLine
              aria-hidden
              size={16}
              className={cn('absolute top-0 transition-transform', SLIDE, folded && '-rotate-90', mirrored ? 'right-0' : 'left-0')}
            />
            {icon}
            <span className={cn('min-w-0 flex-1 truncate text-xs font-semibold uppercase leading-none tracking-wider', mirrored && 'text-right')}>
              {word} {count}
            </span>
          </button>
          {action}
        </>
      ) : (
        icon
      )}
    </div>
  );
}

function splitRows(lengths: number[], weights: number[], capacity: number | null): number[] {
  if (capacity === null) return [...lengths];
  const n = Math.max(lengths.length, capacity);
  if (lengths.reduce((sum, l) => sum + l, 0) <= n) return [...lengths];
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
  value: number;
  min: number;
  max: number;
  above: string;
  below: string;
  onMove: (want: number) => void;
  pitch: number;
  gap: number;
  open: boolean;
  side: PanelSide;
}

function Divider({ value, min, max, above, below, onMove, pitch, gap, open, side }: DividerProps) {
  const drag = useRef<{ y: number; from: number } | null>(null);
  const draggable = min < max;
  return (
    <Tooltip content={draggable ? 'drag: a row more for one list, one fewer for the other' : null}>
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label={`rows for ${above}, the rest for ${below}`}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        tabIndex={draggable ? 0 : -1}
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
          "group relative flex shrink-0 touch-none select-none outline-none transition-[margin-bottom] before:absolute before:inset-x-0 before:-inset-y-2 before:content-['']",
          SLIDE,
          draggable && 'cursor-row-resize',
          open ? INSET[side] : COLUMN
        )}
        style={{ height: LINE_PX, marginBottom: gap }}
      >
        <span
          className={cn('h-px bg-primaryStroke transition-colors group-hover:bg-secondaryStroke group-focus-visible:bg-primaryBlue', open ? 'w-full' : 'mx-auto w-6')}
        />
      </div>
    </Tooltip>
  );
}

function GroupRow({ id, server, side, open, onPick }: { id: string; server: Server; side: PanelSide; open: boolean; onPick: () => void }) {
  const mirrored = side === 'right';
  const words = groupWords(server);
  const live = server.live?.length ?? 0;
  const count = live > 0 ? `${live} live` : `${server.members} ${server.members === 1 ? 'member' : 'members'}`;
  return (
    <li className={cn('flex snap-start items-center gap-1', mirrored && 'flex-row-reverse', INSET[side])} data-live={live}>
      <Link
        id={id}
        to={`/groups/${encodeURIComponent(server.name)}`}
        onClick={onPick}
        draggable={false}
        aria-label={`${words.title}${words.tag ? ` #${words.tag}` : ''} · ${count}`}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-2 border border-transparent outline-none hover:border-primaryStroke focus-visible:border-primaryBlue',
          ROW_TAP,
          ROW_H,
          mirrored && 'flex-row-reverse'
        )}
      >
        <span className="relative block shrink-0">
          <GroupMark
            name={server.name}
            color={server.color}
            icon={server.icon}
            className="h-8 w-8 border border-primaryStroke text-base max-md:h-10 max-md:w-10 max-md:text-lg"
          />
          {live > 0 && (
            <span
              aria-hidden
              className="absolute -bottom-1 -right-1 flex h-4 min-w-4 items-center justify-center border-2 border-background bg-primaryBlue px-0.5 text-[10px] font-semibold leading-none text-background"
            >
              {live}
            </span>
          )}
        </span>
        <span className="sr-only">{count}</span>
        {open && (
          <span className={cn('flex min-w-0 flex-1 items-baseline gap-1 text-sm leading-tight', mirrored && 'flex-row-reverse')}>
            <span className="truncate font-semibold">{words.title}</span>
            {words.tag && <span className="shrink-0 text-xs text-textTertiary">#{words.tag}</span>}
          </span>
        )}
      </Link>
    </li>
  );
}

type Block = { kind: 'friends' | 'following'; people: Followed[] } | { kind: 'groups'; servers: Server[] };

function lengthOf(block: Block): number {
  return block.kind === 'groups' ? block.servers.length : block.people.length;
}

const LIST_WORDS: Record<SidebarList, { icon: typeof RiUserHeartLine; word: string; id: string }> = {
  friends: { icon: RiUserHeartLine, word: 'friends', id: 'mutual-list' },
  following: { icon: RiUserFollowLine, word: 'following', id: 'friends-list' },
  groups: { icon: RiGroupLine, word: 'groups', id: 'groups-list' }
};

interface ListsProps extends ListProps {
  stack: Block[];
  rows: number[];
  face: number;
  spacing: Spacing;
  shares: SidebarShares;
  folds: SidebarFolds;
}

function Lists({ side, open, onPick, stack, rows, face, spacing, shares, folds }: ListsProps) {
  const { gaps } = spacing;
  const all = rows.reduce((sum, r) => sum + r, 0);
  const laid = stack.map((block, i) => {
    const folded = folds[block.kind];
    const held = lengthOf(block);
    return { block, folded, held, length: folded ? 0 : held, rows: rows[i] ?? 0, gap: spacing.lists[i] ?? MIN_GAP };
  });

  const moveLine = (i: number, want: number) => {
    const upper = laid[i];
    const lower = laid[i + 1];
    if (!upper || !lower || all === 0) return;
    const pair = upper.rows + lower.rows;
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
      {laid.map(({ block, folded, held, length, rows: count, gap }, i) => {
        const { icon, word, id } = LIST_WORDS[block.kind];
        const pitch = face + gap;
        const before = laid[i - 1];
        const pair = before ? before.rows + count : 0;
        const fixed = before !== undefined && (before.folded || folded);
        return (
          <Fragment key={block.kind}>
            {before && (
              <Divider
                value={before.rows}
                min={fixed ? before.rows : Math.max(1, pair - length)}
                max={fixed ? before.rows : Math.min(before.length, pair - 1)}
                above={LIST_WORDS[before.block.kind].word}
                below={word}
                onMove={(want) => moveLine(i - 1, want)}
                pitch={(face + before.gap + pitch) / 2}
                gap={gaps[`line-${i - 1}`] ?? MIN_GAP}
                open={open}
                side={side}
              />
            )}
            <Head
              icon={icon}
              word={word}
              count={held}
              listId={id}
              kind={block.kind}
              open={open}
              side={side}
              below={gaps[`head-${i}`] ?? MIN_GAP}
              folded={folded}
            />
            <ul id={id} aria-label={word} inert={folded ? true : undefined} className={LIST} style={{ height: count * pitch, gap }}>
              {block.kind === 'groups'
                ? block.servers.map((server) => (
                    <GroupRow key={server.name} id={`sidebar-group-${server.name}`} server={server} side={side} open={open} onPick={onPick} />
                  ))
                : block.people.map((f) => (
                    <Row key={f.name} id={`friend-${f.name}`} person={f} side={side} open={open} folded={folded} onPick={onPick}>
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

function groupRank(server: Server, query: string): number {
  const { title, tag } = groupWords(server);
  const t = title.toLowerCase();
  if (t === query || server.name === query || (tag !== null && (`${t} #${tag}` === query || `${t}#${tag}` === query))) return 0;
  return t.startsWith(query) ? 1 : 2;
}

function groupHits(mine: Server[], others: Server[], query: string): Server[] {
  return [mine, others].flatMap((list) =>
    list
      .filter((server) => groupMatches(server, query))
      .map((server, i) => ({ server, i, rank: groupRank(server, query) }))
      .sort((a, b) => a.rank - b.rank || a.i - b.i)
      .map(({ server }) => server)
  );
}

function Results({ side, open, onPick, gap }: ListProps & { gap: number }) {
  const query = useAtomValue(searchQueryAtom);
  const { hits, settled } = useAtomValue(searchResultsAtom);
  const following = useAtomValue(followingAtom);
  const mine = useAtomValue(myServersAtom);
  const others = useAtomValue(publicServersAtom);
  const letters = query.trim().toLowerCase();
  const groups = useMemo(() => groupHits(mine ?? [], others ?? [], letters), [mine, others, letters]);
  if (groups.length === 0 && hits.length === 0) {
    return <p className={cn(NOTE, 'text-textTertiary')}>{settled ? 'nothing called that' : 'searching'}</p>;
  }
  const known = new Map((following ?? []).map((f) => [f.name, f] as const));
  return (
    <ul id="friends-results" className={cn('flex min-h-0 flex-1 flex-col', SCROLL)} style={{ gap, paddingBottom: gap }}>
      {groups.map((server) => (
        <GroupRow key={`group ${server.name}`} id={`result-group-${server.name}`} server={server} side={side} open={open} onPick={onPick} />
      ))}
      {hits.map((h) => {
        const f = known.get(h.name);
        return (
          <Row key={`person ${h.name}`} id={`result-${h.name}`} person={h} side={side} open={open} onPick={onPick}>
            {f?.mutual && <Chat id={`result-chat-${h.name}`} person={h} />}
            {f ? <Unfollow id={`result-unfollow-${h.name}`} name={h.name} /> : <FollowButton id={`result-follow-${h.name}`} name={h.name} small />}
          </Row>
        );
      })}
    </ul>
  );
}

interface FriendsProps {
  open: boolean;
  side: PanelSide;
  onPick: () => void;
}

export function Friends({ open, side, onPick }: FriendsProps) {
  const me = useAtomValue(meAtom);
  const all = useAtomValue(followingAtom);
  const servers = useAtomValue(myServersAtom);
  const choices = useAtomValue(sidebarListsAtom);
  const shares = useAtomValue(sidebarSharesAtom);
  const folds = useAtomValue(sidebarFoldsAtom);
  const query = useAtomValue(searchQueryAtom);
  const note = useAtomValue(followNoteAtom);
  const textSize = useAtomValue(textSizeAtom);
  const stack = useRef<HTMLDivElement | null>(null);
  const [room, setRoom] = useState(0);
  const mirrored = side === 'right';
  const groupsOn = choices.some((c) => c.list === 'groups' && c.on);
  const searching = query.trim() !== '';

  const mobile = useIsMobile();
  const sizes = useMemo(() => sizesOf(rootPx(), mobile), [textSize, mobile]);

  useEffect(() => {
    const el = stack.current;
    if (!el) return;
    const watch = new ResizeObserver(() => setRoom(el.clientHeight));
    watch.observe(el);
    return () => watch.disconnect();
  }, []);

  useEffect(() => {
    if (open) {
      void loadFollowing();
      if (groupsOn) void loadMyServers();
    } else setSearchQuery('');
  }, [open, groupsOn]);

  useEffect(() => {
    if (searching) void loadServers(SERVERS_FRESH_MS);
  }, [searching]);

  const friends = all?.filter((f) => f.mutual) ?? [];
  const rest = all?.filter((f) => !f.mutual) ?? [];
  const groups = me ? (servers ?? []) : [];
  const holds: Record<SidebarList, number> = { friends: friends.length, following: rest.length, groups: groups.length };
  const blocks: Block[] = choices
    .filter((c) => c.on && holds[c.list] > 0)
    .map((c): Block => (c.list === 'groups' ? { kind: 'groups', servers: groups } : { kind: c.list, people: c.list === 'friends' ? friends : rest }));
  const faces = searching || blocks.length > 0;
  const fit = measure(room, searching ? 0 : blocks.length, faces, sizes);
  const rows = splitRows(
    blocks.map((block) => (folds[block.kind] ? 0 : lengthOf(block))),
    blocks.map((block) => shares[block.kind]),
    room > 0 ? fit.rows : null
  );
  const spacing = spend(fit, searching ? [] : rows);

  const loading = all === undefined || (!!me && groupsOn && servers === undefined);
  let words: ReactNode = null;
  if (!loading && blocks.length === 0) {
    if (choices.some((c) => !c.on && holds[c.list] > 0)) {
      words = (
        <p className={NOTE}>
          what you have is in a list that is off.{' '}
          <button type="button" onClick={() => openUserModal('sidebar')} className="text-primaryBlue underline-offset-2 hover:underline">
            settings
          </button>
        </p>
      );
    } else if (!me || choices.some((c) => c.on && c.list !== 'groups')) {
      words = <p className={NOTE}>nobody yet. find someone above.{!me && ' who you follow is kept in this browser.'}</p>;
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
        <div className={cn('shrink-0 transition-[padding]', SLIDE, INSET[side])} style={{ paddingTop: (spacing.gaps.top ?? MIN_GAP) + TOP_EXTRA_PX, paddingBottom: spacing.gaps.search }}>
          <label htmlFor="friends-search" className="sr-only">
            find someone or a group
          </label>
          <div className={cn('relative', open ? 'w-full' : FACE_COLUMN_W, mirrored && 'ml-auto')}>
            <RiSearchLine
              aria-hidden
              size={18}
              className={cn('pointer-events-none absolute top-1/2 -translate-y-1/2 text-textTertiary', mirrored ? 'right-2 max-md:right-3' : 'left-2 max-md:left-3')}
            />
            <input
              id="friends-search"
              type="search"
              value={query}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="search"
              maxLength={32}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              className={cn(
                INPUT,
                'h-8 text-sm max-md:h-10',
                open ? (mirrored ? 'pl-3 pr-10 max-md:pr-12' : 'pl-10 pr-3 max-md:pl-12') : 'px-0 text-transparent placeholder:text-transparent'
              )}
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
          <Lists side={side} open={open} onPick={onPick} stack={blocks} rows={rows} face={sizes.face} spacing={spacing} shares={shares} folds={folds} />
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
