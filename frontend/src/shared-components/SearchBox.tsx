import { RiSearchLine } from '@remixicon/react';
import { useEffect, useRef, useState } from 'react';

import { api, type SearchHit } from '@/infra/api';
import { PRESENCE_RANK } from '@/infra/atoms/presence-atoms';
import { FollowButton } from '@/shared-components/FollowButton';
import { panelClassName } from '@/shared-components/Panel';
import { PersonRow } from '@/shared-components/PersonRow';
import { INPUT } from '@/shared-components/user-modal/parts';
import { cn } from '@/utils/cn';

const WAIT_MS = 200;

/** The exact name first, then whoever is here (streaming, online, do not disturb, offline), then as the api ranked them. */
function order(hits: SearchHit[], query: string): SearchHit[] {
  return hits
    .map((hit, i) => ({ hit, i }))
    .sort((a, b) => Number(b.hit.name === query) - Number(a.hit.name === query) || PRESENCE_RANK[a.hit.presence] - PRESENCE_RANK[b.hit.presence] || a.i - b.i)
    .map(({ hit }) => hit);
}

/**
 * The box at the top of home (docs/follows.md): a few letters of a name, and the people who
 * have them drop down under it, the ones here first, each a link to their page with a follow
 * button beside it. Its own state, not the corner box's: the two can be open at once.
 */
export function SearchBox({ className }: { className?: string }) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const seq = useRef(0);
  const box = useRef<HTMLDivElement | null>(null);
  const q = query.trim().toLowerCase();

  // the search, a beat after the last keystroke. the newest answer wins; an empty box was
  // emptied by the keystroke itself (below), so there is nothing to ask
  useEffect(() => {
    const mine = ++seq.current;
    if (!q) return;
    const t = window.setTimeout(() => {
      api
        .search(q)
        .then((list) => {
          if (mine === seq.current) setHits(order(list, q));
        })
        .catch(() => {
          if (mine === seq.current) setHits([]);
        })
        .finally(() => {
          if (mine === seq.current) setBusy(false);
        });
    }, WAIT_MS);
    return () => window.clearTimeout(t);
  }, [q]);

  return (
    <div
      ref={box}
      className={cn('relative', className)}
      onFocusCapture={() => setOpen(true)}
      onBlurCapture={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          setOpen(false);
          (e.target as HTMLElement).blur();
        }
      }}
    >
      <label htmlFor="search" className="sr-only">
        find a streamer or a person
      </label>
      <RiSearchLine aria-hidden size={18} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-textTertiary" />
      <input
        id="search"
        type="search"
        value={query}
        onChange={(e) => {
          const next = e.target.value;
          setQuery(next);
          setOpen(true);
          // the box tells the list what to expect: empty is empty now, letters are a search under way
          if (next.trim()) setBusy(true);
          else {
            setHits([]);
            setBusy(false);
          }
        }}
        placeholder="find a streamer or a person"
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        role="combobox"
        aria-expanded={open && !!q}
        aria-controls="search-results"
        aria-autocomplete="list"
        className={cn(INPUT, 'pl-10')}
      />
      {open && q && (
        <ul id="search-results" role="listbox" className={panelClassName('absolute left-0 right-0 top-full z-30 mt-2 max-h-[60vh] overflow-y-auto p-1.5')}>
          {hits.length === 0 ? (
            <li className="px-2 py-3 text-sm text-textTertiary">{busy ? 'searching' : 'nobody called that'}</li>
          ) : (
            hits.map((h) => (
              <li key={h.name} role="option" aria-selected={false} className="flex min-w-0 items-center gap-2.5 px-2 py-1.5" data-presence={h.presence}>
                <PersonRow id={`search-${h.name}`} name={h.name} verified={h.verified} avatar={h.avatar} bio={h.bio} presence={h.presence} onPick={() => setOpen(false)} />
                <FollowButton id={`search-follow-${h.name}`} name={h.name} small />
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
