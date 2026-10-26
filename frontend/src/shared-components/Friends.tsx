import { RiCloseLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { useEffect, useRef } from 'react';

import { meAtom } from '@/infra/atoms/auth-atoms';
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
import { panelClassName } from '@/shared-components/Panel';
import { PersonRow } from '@/shared-components/PersonRow';
import { INPUT } from '@/shared-components/user-modal/parts';
import { cn } from '@/utils/cn';

const ROW = 'flex min-w-0 items-center gap-2.5 px-2 py-1.5';
const SEARCH_WAIT_MS = 200;

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
  return (
    <>
      <p id="friends-count" className="flex items-baseline gap-2 px-2 pb-1 text-xs font-semibold uppercase tracking-wider text-textTertiary">
        following {list.length}
        {streaming > 0 && (
          <>
            <span aria-hidden>·</span>
            <span className="text-primaryBlue">{streaming} streaming</span>
          </>
        )}
      </p>
      <ul id="friends-list" className="flex flex-col">
        {list.map((f) => (
          <li key={f.name} className={ROW} data-presence={f.presence}>
            <PersonRow id={`friend-${f.name}`} name={f.name} verified={f.verified} avatar={f.avatar} bio={f.bio} presence={f.presence} onPick={onPick} />
            <button
              id={`friend-unfollow-${f.name}`}
              type="button"
              aria-label={`stop following ${f.name}`}
              title="unfollow"
              onClick={() => void unfollow(f.name)}
              className="shrink-0 border border-transparent p-0.5 text-textTertiary hover:border-primaryStroke hover:text-decrease focus-visible:border-primaryBlue focus-visible:outline-none"
            >
              <RiCloseLine aria-hidden size={16} />
            </button>
          </li>
        ))}
      </ul>
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
 * The box over the corner panel (docs/follows.md): who you follow, streaming first, each with
 * the word beside their name, and a box to find more. Opens on hover, focus, or the `following`
 * button in the panel; it asks `GET /api/following` every time it opens, so the words are now.
 * `focusSearch`: opened by the button, not the mouse, so the box takes focus.
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
    <div
      id="friends"
      role="region"
      aria-label="following"
      className={panelClassName('absolute bottom-full left-0 mb-3 flex w-[min(360px,calc(100vw-3rem))] flex-col text-base')}
    >
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
      <div className="max-h-[50vh] overflow-y-auto p-1.5">{query.trim() ? <Results onPick={onClose} /> : <Following onPick={onClose} />}</div>
      {note && (
        <p id="friends-note" aria-live="polite" className="border-t border-primaryStroke px-3 py-1.5 text-sm text-decrease">
          {note}
        </p>
      )}
    </div>
  );
}
