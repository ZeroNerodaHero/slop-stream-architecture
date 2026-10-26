import { RiChat3Line, RiCloseLine, RiSearchLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { type ReactNode, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';

import { meAtom } from '@/infra/atoms/auth-atoms';
import { openDm } from '@/infra/atoms/dm-atoms';
import { followNoteAtom, followingAtom, loadFollowing, search, searchBusyAtom, searchQueryAtom, searchResultsAtom, unfollow } from '@/infra/atoms/follow-atoms';
import { type Presence, PRESENCE_SQUARE, PRESENCE_TEXT, PRESENCE_WORD } from '@/infra/atoms/presence-atoms';
import type { PanelSide } from '@/infra/atoms/settings-atoms';
import { openUserModal } from '@/infra/atoms/user-modal-atoms';
import { store } from '@/infra/store';
import { Face } from '@/shared-components/Face';
import { FollowButton } from '@/shared-components/FollowButton';
import { Who } from '@/shared-components/PersonRow';
import { INPUT } from '@/shared-components/user-modal/parts';
import { cn } from '@/utils/cn';

const SEARCH_WAIT_MS = 200;
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
const INSET_MARGIN: Record<PanelSide, string> = { left: 'ml-[19px] mr-2', right: 'mr-[19px] ml-2' };

/** Enough of somebody for a row: a followed name and a search hit both have it. */
interface Person {
  name: string;
  verified: boolean;
  avatar: number | null;
  bio: string;
  presence: Presence;
}

/** The picture and the presence square in its corner, the way the closed panel shows everyone. */
function RailFace({ name, avatar, presence }: { name: string; avatar: number | null; presence: Presence }) {
  return (
    <span className="relative block shrink-0">
      <Face name={name} version={avatar} />
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
 * anything. The face and the name are one link to their page.
 */
function Row({ id, person, side, open, onPick, children }: RowProps) {
  const mirrored = side === 'right';
  return (
    <li className={cn('flex items-center gap-1', mirrored && 'flex-row-reverse', INSET[side])} data-presence={person.presence}>
      <Link
        id={id}
        to={`/watch/${encodeURIComponent(person.name)}`}
        onClick={onPick}
        title={person.bio || person.name}
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
    </li>
  );
}

function Unfollow({ name }: { name: string }) {
  return (
    <button
      id={`friend-unfollow-${name}`}
      type="button"
      aria-label={`stop following ${name}`}
      title="unfollow"
      onClick={() => void unfollow(name)}
      className={cn(ICON_BUTTON, 'hover:text-decrease')}
    >
      <RiCloseLine aria-hidden size={16} />
    </button>
  );
}

function Chat({ person }: { person: Person }) {
  return (
    <button
      id={`friend-chat-${person.name}`}
      type="button"
      aria-label={`chat with ${person.name}`}
      title="chat"
      onClick={() => openDm({ name: person.name, avatar: person.avatar, verified: person.verified })}
      className={cn(ICON_BUTTON, 'hover:text-textPrimary')}
    >
      <RiChat3Line aria-hidden size={16} />
    </button>
  );
}

interface ListProps {
  side: PanelSide;
  open: boolean;
  onPick: () => void;
}

/**
 * Friends (they follow you back) above a line, everyone else you follow under it, each group
 * streaming first, as the api sent them. A friend gets a chat button as well as unfollow. The
 * one list the tests read (`#friends-list`) is the second group. Closed, the words have no
 * room: only the faces, and nothing where a note would be.
 */
function Following({ side, open, onPick }: ListProps) {
  const me = useAtomValue(meAtom);
  const list = useAtomValue(followingAtom);

  if (!me) {
    return open ? (
      <p className={NOTE}>
        following is for accounts: who is streaming, right here, every time you look.{' '}
        <button type="button" onClick={() => openUserModal('security')} className="text-primaryBlue underline-offset-2 hover:underline">
          sign up or log in
        </button>
        . searching works anyway.
      </p>
    ) : null;
  }
  if (list === undefined) return open ? <p className={cn(NOTE, 'text-textTertiary')}>loading</p> : null;
  if (list.length === 0) return open ? <p className={NOTE}>nobody yet. find someone above.</p> : null;
  const friends = list.filter((f) => f.mutual);
  const following = list.filter((f) => !f.mutual);
  return (
    <>
      {friends.length > 0 && (
        <ul id="mutual-list" aria-label="friends" className="flex flex-col gap-2">
          {friends.map((f) => (
            <Row key={f.name} id={`friend-${f.name}`} person={f} side={side} open={open} onPick={onPick}>
              <Chat person={f} />
              <Unfollow name={f.name} />
            </Row>
          ))}
        </ul>
      )}
      {friends.length > 0 && following.length > 0 && (
        <div aria-hidden className={cn('my-2 h-px shrink-0 bg-primaryStroke', open ? INSET_MARGIN[side] : 'mx-auto w-6')} />
      )}
      {following.length > 0 && (
        <ul id="friends-list" aria-label="following" className="flex flex-col gap-2">
          {following.map((f) => (
            <Row key={f.name} id={`friend-${f.name}`} person={f} side={side} open={open} onPick={onPick}>
              <Unfollow name={f.name} />
            </Row>
          ))}
        </ul>
      )}
    </>
  );
}

/** What the box found, in place of the lists while it holds letters: the same rows, a follow button on each. */
function Results({ side, open, onPick }: ListProps) {
  const hits = useAtomValue(searchResultsAtom);
  const busy = useAtomValue(searchBusyAtom);
  if (hits.length === 0) {
    return <p className={cn(NOTE, 'text-textTertiary')}>{busy ? 'searching' : 'nobody called that'}</p>;
  }
  return (
    <ul id="friends-results" className="flex flex-col gap-2">
      {hits.map((h) => (
        <Row key={h.name} id={`result-${h.name}`} person={h} side={side} open={open} onPick={onPick}>
          <FollowButton id={`result-follow-${h.name}`} name={h.name} small />
        </Row>
      ))}
    </ul>
  );
}

interface FriendsProps {
  /** Widened over the page (hover, focus, or the `following` button), or the column of faces. */
  open: boolean;
  side: PanelSide;
  /** Opened by the button, not the mouse, so the box takes focus. */
  focusSearch: boolean;
  /** A click on a name: the panel closes. */
  onPick: () => void;
}

/**
 * The body of the sidebar (docs/follows.md), in both of its states: the search box, then
 * friends, a line, then the rest of who you follow. Closed, each is a square in one column
 * (the box is its icon); open, the same squares stay where they are and the words and buttons
 * come out beside them, so what you were pointing at is still under the pointer. The site's
 * one search: letters in the box put what they find where the lists were, with a follow
 * button each; closing the panel empties it. Every open asks `GET /api/following` again, so
 * the words are now.
 */
export function Friends({ open, side, focusSearch, onPick }: FriendsProps) {
  const query = useAtomValue(searchQueryAtom);
  const note = useAtomValue(followNoteAtom);
  const input = useRef<HTMLInputElement | null>(null);
  const mirrored = side === 'right';

  // every open: the list again, fresh words. every close: the box empty, so the column is who you follow and not the last search
  useEffect(() => {
    if (open) void loadFollowing();
    else store.set(searchQueryAtom, '');
  }, [open]);

  // the box takes focus when a key opened this
  useEffect(() => {
    if (open && focusSearch) input.current?.focus();
  }, [open, focusSearch]);

  // the search, a beat after the last keystroke
  useEffect(() => {
    const t = window.setTimeout(() => void search(query), SEARCH_WAIT_MS);
    return () => window.clearTimeout(t);
  }, [query]);

  return (
    <div id="friends" role="region" aria-label="following" className="flex min-h-0 flex-1 flex-col">
      <div className={cn('shrink-0 py-2.5', INSET[side])}>
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
            ref={input}
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
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {query.trim() ? <Results side={side} open={open} onPick={onPick} /> : <Following side={side} open={open} onPick={onPick} />}
      </div>
      {open && note && (
        <p id="friends-note" aria-live="polite" className="border-t border-primaryStroke px-3 py-1.5 text-sm text-decrease">
          {note}
        </p>
      )}
    </div>
  );
}
