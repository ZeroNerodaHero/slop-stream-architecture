import { type FormEvent, type RefObject, useState } from 'react';

import { searchRoom } from '@/infra/atoms/chat-atoms';
import { cn } from '@/utils/cn';

/**
 * The search's filters (history.rs `parse_search`), as words beside the box: a click puts one in
 * the box, or takes it out again. One that wants a value (`from:`, the days) leaves the cursor
 * right after its colon for the name or the day.
 */
const SEARCH_FILTERS: readonly { word: string; title: string }[] = [
  { word: 'from:', title: 'lines said under a name, and by that account under any name: from:bob' },
  { word: 'has:image', title: 'lines with a picture on them' },
  { word: 'has:link', title: 'lines with a link in them' },
  { word: 'has:video', title: 'lines with a link to a video: youtube, twitch, a clip, an mp4' },
  { word: 'before:', title: 'lines said before a day (utc): before:2026-10-30' },
  { word: 'after:', title: 'lines said after a day (utc), the day itself out: after:2026-10-01' }
];

export interface ChatSearch {
  /** The words in the box. */
  query: string;
  setQuery: (query: string) => void;
  /** The form's submit: the room is asked for the words (`searchRoom`). */
  submit: (e: FormEvent) => void;
  /** A filter word is in the box: itself for `has:image`, or anything after its colon for `from:` and the days. */
  filterOn: (word: string) => boolean;
  /** A filter word into the box, or out of it again; the box takes the focus either way, and the cursor the end. */
  toggleFilter: (word: string) => void;
}

/**
 * The words of a room search, and the filters on them, for a box the caller draws: the chat
 * panel's under its header, the group room's in the page header. `input` is that box, for the
 * focus a filter word hands back to it. Submitting asks the room on screen (`searchRoom`); the
 * hits are the panel's results list either way.
 */
export function useChatSearch(input: RefObject<HTMLInputElement | null>): ChatSearch {
  const [query, setQuery] = useState('');
  /** The words in the box, as the server reads them: apart on spaces. */
  const words = query.split(/\s+/).filter(Boolean);
  const filterOn = (word: string) => (word.endsWith(':') ? words.some((w) => w.toLowerCase().startsWith(word)) : words.some((w) => w.toLowerCase() === word));

  function toggleFilter(word: string) {
    const on = filterOn(word);
    const kept = words.filter((w) => (word.endsWith(':') ? !w.toLowerCase().startsWith(word) : w.toLowerCase() !== word));
    // one that wants a value ends at its colon, the cursor right after; the others take a space, for the next word
    setQuery(on ? kept.join(' ') : [...kept, word].join(' ') + (word.endsWith(':') ? '' : ' '));
    input.current?.focus();
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    void searchRoom(query);
  }

  return { query, setQuery, submit, filterOn, toggleFilter };
}

/**
 * The filter words: blue while in the box, a click puts one in or takes it out. The press
 * leaves the focus where it is, so a box that shows these only while it has the focus (the
 * group room's) keeps them through the click; the word puts the focus in the box after.
 */
export function SearchFilters({ search, id, className }: { search: ChatSearch; id: string; className?: string }) {
  return (
    <div id={id} className={cn('flex flex-wrap gap-x-3 gap-y-0.5 text-xs', className)}>
      {SEARCH_FILTERS.map(({ word, title }) => {
        const on = search.filterOn(word);
        return (
          <button
            key={word}
            type="button"
            data-filter={word}
            aria-pressed={on}
            title={title}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => search.toggleFilter(word)}
            className={cn('transition-colors duration-150', on ? 'font-semibold text-primaryBlue' : 'text-textTertiary hover:text-textSecondary')}
          >
            {word}
          </button>
        );
      })}
    </div>
  );
}
