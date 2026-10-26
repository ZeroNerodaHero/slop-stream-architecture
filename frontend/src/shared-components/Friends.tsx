import { RiChat3Line, RiCloseLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { useEffect, useRef } from 'react';

import { type Followed } from '@/infra/api';
import { meAtom } from '@/infra/atoms/auth-atoms';
import { openDm } from '@/infra/atoms/dm-atoms';
import {
  followNoteAtom,
  followingAtom,
  loadFollowing,
  search,
  searchBusyAtom,
  searchQueryAtom,
  searchResultsAtom,
  streamingFriendsAtom,
  unfollow
} from '@/infra/atoms/follow-atoms';
import { openUserModal } from '@/infra/atoms/user-modal-atoms';
import { store } from '@/infra/store';
import { FollowButton } from '@/shared-components/FollowButton';
import { PersonRow } from '@/shared-components/PersonRow';
import { INPUT } from '@/shared-components/user-modal/parts';
import { cn } from '@/utils/cn';

const ROW = 'flex min-w-0 items-center gap-2.5 px-2 py-1.5';
const SEARCH_WAIT_MS = 200;
const ICON_BUTTON = 'shrink-0 border border-transparent p-0.5 text-textTertiary hover:border-primaryStroke focus-visible:border-primaryBlue focus-visible:outline-none';
const SECTION = 'px-2 pb-1 pt-2 text-xs font-semibold uppercase tracking-wider text-textTertiary';

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

function Rows({ people, onPick, chat, listId }: { people: Followed[]; onPick: () => void; chat?: boolean; listId: string }) {
  return (
    <ul id={listId} className="flex flex-col">
      {people.map((f) => (
        <li key={f.name} className={ROW} data-presence={f.presence} data-mutual={f.mutual ? 'true' : 'false'}>
          <PersonRow id={`friend-${f.name}`} name={f.name} verified={f.verified} avatar={f.avatar} bio={f.bio} presence={f.presence} onPick={onPick} />
          {chat && (
            <button
              id={`friend-chat-${f.name}`}
              type="button"
              aria-label={`chat with ${f.name}`}
              title="chat"
              onClick={() => openDm({ name: f.name, avatar: f.avatar, verified: f.verified })}
              className={cn(ICON_BUTTON, 'hover:text-textPrimary')}
            >
              <RiChat3Line aria-hidden size={16} />
            </button>
          )}
          <Unfollow name={f.name} />
        </li>
      ))}
    </ul>
  );
}

/**
 * Two groups, the way the explorer splits yours and discover: friends (they follow you back)
 * and everyone else you follow. A friend gets a chat button as well as unfollow. The one list
 * the tests read (`#friends-list`) is the second group, streaming first, as the api sent them.
 */
function Following({ onPick }: { onPick: () => void }) {
  const me = useAtomValue(meAtom);
  const list = useAtomValue(followingAtom);
  const streaming = useAtomValue(streamingFriendsAtom);

  if (!me) {
    return (
      <p className="px-2 py-3 text-sm text-textSecondary">
        following is for accounts: who is streaming, right here, every time you look.{' '}
        <button type="button" onClick={() => openUserModal('security')} className="text-primaryBlue underline-offset-2 hover:underline">
          sign up or log in
        </button>
        . searching works anyway.
      </p>
    );
  }
  if (list === undefined) return <p className="px-2 py-3 text-sm text-textTertiary">loading</p>;
  if (list.length === 0) return <p className="px-2 py-3 text-sm text-textSecondary">nobody yet. find someone above.</p>;
  const friends = list.filter((f) => f.mutual);
  const following = list.filter((f) => !f.mutual);
  return (
    <>
      <p id="friends-count" className={cn(SECTION, 'flex items-baseline gap-2 pt-1')}>
        following {list.length}
        {streaming > 0 && (
          <>
            <span aria-hidden>·</span>
            <span className="text-primaryBlue">{streaming} streaming</span>
          </>
        )}
      </p>
      <section aria-label="friends">
        <h3 id="mutual-count" className={SECTION}>
          friends {friends.length}
        </h3>
        {friends.length === 0 ? (
          <p className="px-2 pb-2 text-sm text-textSecondary">nobody follows you back yet.</p>
        ) : (
          <Rows people={friends} onPick={onPick} chat listId="mutual-list" />
        )}
      </section>
      {following.length > 0 && (
        <section aria-label="following">
          {friends.length > 0 && <h3 className={SECTION}>following {following.length}</h3>}
          <Rows people={following} onPick={onPick} listId="friends-list" />
        </section>
      )}
    </>
  );
}

function Results({ onPick }: { onPick: () => void }) {
  const hits = useAtomValue(searchResultsAtom);
  const busy = useAtomValue(searchBusyAtom);
  if (hits.length === 0) {
    return <p className="px-2 py-3 text-sm text-textTertiary">{busy ? 'searching' : 'nobody called that'}</p>;
  }
  return (
    <ul id="friends-results" className="flex flex-col">
      {hits.map((h) => (
        <li key={h.name} className={ROW} data-presence={h.presence}>
          <PersonRow id={`result-${h.name}`} name={h.name} verified={h.verified} avatar={h.avatar} bio={h.bio} presence={h.presence} onPick={onPick} />
          <FollowButton id={`result-follow-${h.name}`} name={h.name} small />
        </li>
      ))}
    </ul>
  );
}

/**
 * The body of the sidebar (docs/follows.md): who you follow, friends first among them, and a
 * box to find more. The sidebar opens this on hover, focus, or its `following` button, and
 * asks `GET /api/following` every time, so the words are now. `focusSearch`: opened by the
 * button, not the mouse, so the box takes focus.
 */
export function Friends({ onClose, focusSearch }: { onClose: () => void; focusSearch: boolean }) {
  const query = useAtomValue(searchQueryAtom);
  const note = useAtomValue(followNoteAtom);
  const input = useRef<HTMLInputElement | null>(null);

  // every open: the list again, fresh words. and the box, when a key opened this
  useEffect(() => {
    void loadFollowing();
    if (focusSearch) input.current?.focus();
  }, []);

  // the search, a beat after the last keystroke
  useEffect(() => {
    const t = window.setTimeout(() => void search(query), SEARCH_WAIT_MS);
    return () => window.clearTimeout(t);
  }, [query]);

  return (
    <div id="friends" role="region" aria-label="following" className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-primaryStroke p-2.5">
        <label htmlFor="friends-search" className="sr-only">
          find someone
        </label>
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
          className={cn(INPUT, 'py-1.5 text-sm')}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">{query.trim() ? <Results onPick={onClose} /> : <Following onPick={onClose} />}</div>
      {note && (
        <p id="friends-note" aria-live="polite" className="border-t border-primaryStroke px-3 py-1.5 text-sm text-decrease">
          {note}
        </p>
      )}
    </div>
  );
}
