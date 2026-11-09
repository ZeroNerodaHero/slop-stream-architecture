import { type ChangeEvent, type FormEvent, type KeyboardEvent, type RefObject, type SyntheticEvent, useLayoutEffect, useRef, useState } from 'react';

import { searchRoom } from '@/infra/atoms/chat-atoms';
import { cn } from '@/utils/cn';

/** A filter word under a search box: the word, and what it does, as its tooltip. */
export interface Filter {
  word: string;
  title: string;
}

/**
 * The search's filters (history.rs `parse_search`), as words beside the box: a click puts one in
 * the box, or takes it out again. One that wants a value (`from:`, the days) leaves the cursor
 * right after its colon for the name or the day, and the box offers what could follow
 * (`useChatSearch`): the names for `from:`, the three kinds for `has:`.
 */
const SEARCH_FILTERS: readonly Filter[] = [
  { word: 'from:', title: 'lines said under a name, and by that account under any name: from:bob' },
  { word: 'has:image', title: 'lines with a picture on them' },
  { word: 'has:link', title: 'lines with a link in them' },
  { word: 'has:video', title: 'lines with a link to a video: youtube, twitch, a clip, an mp4' },
  { word: 'before:', title: 'lines said before a day (utc): before:2026-10-30' },
  { word: 'after:', title: 'lines said after a day (utc), the day itself out: after:2026-10-01' }
];

/** A group's one more: without it a search is every channel you see, with it one channel. Offered where there are channels. */
const CHANNEL_FILTER: Filter = { word: 'channel:', title: 'lines in one channel of the group: channel:general. without it, every channel you see is searched' };

/** What `has:` can be. */
const HAS_VALUES: readonly string[] = ['image', 'link', 'video'];

export interface SearchOptions {
  /** The names `from:` offers: a room's speakers, a roster's members, a thread's two. */
  names?: readonly string[];
  /** A group's channels, as this viewer sees them: with these the box has `channel:`, offering them. */
  channels?: readonly string[];
}

/** What the word under the caret could be completed to: a filter and one of its values, as it would stand in the box. */
export interface Suggestion {
  /** The whole word, `from:bob`. */
  text: string;
  /** The filter's key, `from`, for the picture of it. */
  key: string;
  /** The value alone, `bob`. */
  value: string;
}

export interface ChatSearch {
  /** The words in the box. */
  query: string;
  setQuery: (query: string) => void;
  /** The form's submit: the room, or the thread, is asked for the words (`ask`). */
  submit: (e: FormEvent) => void;
  /** The filter words this box offers: the six, and `channel:` where there are channels. */
  filters: readonly Filter[];
  /** A filter word is in the box: itself for `has:image`, or anything after its colon for `from:` and the days. */
  filterOn: (word: string) => boolean;
  /** A filter word into the box, or out of it again; the box takes the focus either way, and the cursor the end. */
  toggleFilter: (word: string) => void;
  /** What the word under the caret could become. Empty when the word is no filter's, or is complete already, or the list was dismissed. */
  suggestions: readonly Suggestion[];
  /** The suggestion the arrow keys rest on, an index into `suggestions`. */
  active: number;
  /** One suggestion into the box in the word's place, a space after it, the caret after that. */
  pick: (index: number) => void;
  /** The box's text and caret as they change: the `onChange` of the input. */
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
  /** The caret as it moves without the text changing: the `onSelect` of the input. */
  onSelect: (e: SyntheticEvent<HTMLInputElement>) => void;
  /**
   * The keys over the list while it is up: the arrows walk it, enter and tab take the one
   * rested on, escape dismisses it for this word. True when the key was the list's, and the
   * caller leaves it alone; false when the box's own handling (submit, its own escape) goes on.
   */
  onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => boolean;
}

/** What a search box asks on submit: the room on screen, unless the caller says otherwise. */
const askRoom = (query: string) => void searchRoom(query);

/** The word the caret is in or right after: where it starts and ends in the box, and the part of it before the caret. None on whitespace, or at a word's very start. */
function wordAt(query: string, caret: number): { start: number; end: number; typed: string } | null {
  let start = caret;
  while (start > 0 && !/\s/.test(query[start - 1] ?? ' ')) start -= 1;
  let end = caret;
  while (end < query.length && !/\s/.test(query[end] ?? ' ')) end += 1;
  if (start === caret) return null;
  return { start, end, typed: query.slice(start, caret) };
}

/**
 * The words of a search, and the filters on them, for a box the caller draws: the group room's
 * over the roster (or the chat panel's under its header, for a stranger with no roster), the
 * direct message window's under its header. `input` is that box, for the focus a filter word
 * hands back to it and the caret a pick puts in it. Submitting asks the room on screen
 * (`searchRoom`), or whatever `ask` says (the window asks its thread, `searchDm`); the hits
 * are the caller's results list.
 *
 * The box completes a filter's value as it is typed (`suggestions`, drawn by
 * `SearchSuggestions`): `from:` offers `options.names`, `has:` its three kinds, `channel:` a
 * group's channels (`options.channels`, which also puts the `channel:` word among the filters).
 * The word under the caret is what is completed, and a pick puts the whole word in its place,
 * so `from:bo` becomes `from:bob `. A word already one of the values offers nothing more.
 */
export function useChatSearch(input: RefObject<HTMLInputElement | null>, ask: (query: string) => void = askRoom, options: SearchOptions = {}): ChatSearch {
  const [query, setQueryState] = useState('');
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  /** The word the list was dismissed for (escape): it stays down until the word changes. */
  const [dismissed, setDismissed] = useState<string | null>(null);
  /** Where the caret goes once the box shows the text a pick made: the input is controlled, so after the render. */
  const caretAfter = useRef<number | null>(null);
  const filters: readonly Filter[] = options.channels ? [...SEARCH_FILTERS, CHANNEL_FILTER] : SEARCH_FILTERS;

  useLayoutEffect(() => {
    const at = caretAfter.current;
    if (at === null) return;
    caretAfter.current = null;
    input.current?.setSelectionRange(at, at);
  }, [query]);

  function setQuery(next: string) {
    setQueryState(next);
    setCaret(next.length);
    setActive(0);
    setDismissed(null);
  }

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
    ask(query);
  }

  // the word under the caret, when it is a filter with a value to complete
  const word = wordAt(query, caret);
  const asked = word ? /^([a-z]+):(.*)$/i.exec(word.typed) : null;
  let suggestions: Suggestion[] = [];
  if (word && asked && dismissed !== word.typed) {
    const key = (asked[1] ?? '').toLowerCase();
    const prefix = (asked[2] ?? '').toLowerCase();
    const values = key === 'from' ? (options.names ?? []) : key === 'has' ? HAS_VALUES : (key === 'channel' || key === 'in') && options.channels ? options.channels : [];
    const seen = new Set<string>();
    const fitting = values.filter((value) => {
      const low = value.toLowerCase();
      if (!low.startsWith(prefix) || seen.has(low)) return false;
      seen.add(low);
      return true;
    });
    // the word is one of them already: nothing to add
    if (!(fitting.length === 1 && fitting[0]?.toLowerCase() === prefix)) suggestions = fitting.map((value) => ({ text: `${key}:${value}`, key, value }));
  }
  const shown = Math.min(active, Math.max(0, suggestions.length - 1));

  function pick(index: number) {
    const chosen = suggestions[index];
    if (!word || !chosen) return;
    const next = `${query.slice(0, word.start)}${chosen.text} ${query.slice(word.end).replace(/^\s+/, '')}`;
    const at = word.start + chosen.text.length + 1;
    setQueryState(next);
    setCaret(at);
    setActive(0);
    setDismissed(null);
    // the text as it was (the word was whole already): no render is coming to place the caret, so it is placed now
    if (next === query) input.current?.setSelectionRange(at, at);
    else caretAfter.current = at;
    input.current?.focus();
  }

  function onChange(e: ChangeEvent<HTMLInputElement>) {
    setQueryState(e.target.value);
    setCaret(e.target.selectionStart ?? e.target.value.length);
    setActive(0);
    setDismissed(null);
  }

  function onSelect(e: SyntheticEvent<HTMLInputElement>) {
    setCaret(e.currentTarget.selectionStart ?? e.currentTarget.value.length);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>): boolean {
    if (suggestions.length === 0 || e.nativeEvent.isComposing) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((shown + (e.key === 'ArrowDown' ? 1 : suggestions.length - 1)) % suggestions.length);
      return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      pick(shown);
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (word) setDismissed(word.typed);
      return true;
    }
    return false;
  }

  return { query, setQuery, submit, filters, filterOn, toggleFilter, suggestions, active: shown, pick, onChange, onSelect, onKeyDown };
}

/**
 * The input's half of the list (`SearchSuggestions` is the other, under the box with `listId`):
 * its words and caret into the hook, and the combobox words for a reader. The caller adds its
 * own `onKeyDown`, asking `search.onKeyDown` first.
 */
export function comboProps(search: ChatSearch, listId: string) {
  const up = search.suggestions.length > 0;
  return {
    role: 'combobox' as const,
    'aria-autocomplete': 'list' as const,
    'aria-expanded': up,
    'aria-controls': listId,
    'aria-activedescendant': up ? `${listId}-${search.active}` : undefined,
    autoComplete: 'off' as const,
    value: search.query,
    onChange: search.onChange,
    onSelect: search.onSelect
  };
}

/**
 * The filter words: blue while in the box, a click puts one in or takes it out. The press
 * leaves the focus where it is, so a box that shows these only while it has the focus (the
 * group room's) keeps them through the click; the word puts the focus in the box after. The
 * same words under every box, and `channel:` under a group's: a thread's `from:` is one of
 * its two names.
 */
export function SearchFilters({ search, id, className }: { search: ChatSearch; id: string; className?: string }) {
  return (
    <div id={id} className={cn('flex flex-wrap gap-x-3 gap-y-0.5 text-xs', className)}>
      {search.filters.map(({ word, title }) => {
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

/**
 * What the word under the caret could become, under the box: a list in a box of its own (a
 * stroke, no shadow), one row a suggestion, the one the arrow keys rest on in blue. A press on
 * a row leaves the focus in the box; the click puts the word in. Nothing while there is nothing
 * to offer. The box that owns it is `relative`, and names it by `id` (`comboProps`).
 */
export function SearchSuggestions({ search, id, className }: { search: ChatSearch; id: string; className?: string }) {
  if (search.suggestions.length === 0) return null;
  return (
    <ul id={id} role="listbox" aria-label="what the word could be" className={cn('absolute left-0 right-0 top-full z-20 mt-1 max-h-48 overflow-y-auto border border-primaryStroke bg-backgroundSecondary py-1 text-sm', className)}>
      {search.suggestions.map((suggestion, i) => (
        <li key={suggestion.text} id={`${id}-${i}`} role="option" aria-selected={i === search.active}>
          <button
            type="button"
            tabIndex={-1}
            data-suggestion={suggestion.text}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => search.pick(i)}
            className={cn('block w-full truncate px-2 py-1 text-left', i === search.active ? 'bg-primaryBlue/10 text-primaryBlue' : 'text-textPrimary hover:bg-backgroundTertiary')}
          >
            <span className="text-textTertiary">{suggestion.key}:</span>
            {suggestion.value}
          </button>
        </li>
      ))}
    </ul>
  );
}
