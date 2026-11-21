import { type RemixiconComponentType, RiAttachment2, RiCalendarLine, RiCloseLine, RiFilmLine, RiHashtag, RiImageLine, RiLink, RiUserLine, RiVideoLine } from '@remixicon/react';
import {
  type ChangeEvent,
  type FormEvent,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  type SyntheticEvent,
  useLayoutEffect,
  useRef,
  useState
} from 'react';

import { searchRoom } from '@/infra/atoms/chat-atoms';
import { plainEmotes } from '@/infra/emotes';
import { Button } from '@/shared-components/Button';
import { stamp, when } from '@/shared-components/ChatLine';
import { Face } from '@/shared-components/Face';
import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

/** A filter's key, as it stands before the colon in the query (`channel` is also read as `in`). */
export type FilterKey = 'from' | 'has' | 'before' | 'after' | 'channel';

/** A filter button under a search box: the key, its glyph, and what it does, as its tooltip. */
export interface Filter {
  key: FilterKey;
  icon: RemixiconComponentType;
  title: string;
}

/**
 * The search's filters (history.rs `parse_search`), as buttons under the box: a click starts
 * one in the box (`startFilter`), and the box offers what could follow: the people for `from:`,
 * each with their face, the three kinds for `has:`, a day for `before:` and `after:`.
 */
const SEARCH_FILTERS: readonly Filter[] = [
  { key: 'from', icon: RiUserLine, title: 'lines said under a name, and by that account under any name' },
  { key: 'has', icon: RiAttachment2, title: 'lines with a picture, a video or a link' },
  { key: 'before', icon: RiCalendarLine, title: 'lines said before a day (utc)' },
  { key: 'after', icon: RiCalendarLine, title: 'lines said after a day (utc), the day itself out' }
];

/** A group's one more: without it a search is every channel you see, with it one channel. Offered where there are channels. */
const CHANNEL_FILTER: Filter = { key: 'channel', icon: RiHashtag, title: 'lines in one channel of the group. without it, every channel you see is searched' };

/** What `has:` can be, in the order the list offers them, each with its glyph and its name. */
type HasKind = 'image' | 'video' | 'link';
const HAS: Record<HasKind, { icon: RemixiconComponentType; title: string }> = {
  image: { icon: RiImageLine, title: 'has an image' },
  video: { icon: RiVideoLine, title: 'has a video: an uploaded one, youtube, twitch, a clip, an mp4' },
  link: { icon: RiLink, title: 'has a link' }
};
const HAS_KINDS = Object.keys(HAS) as HasKind[];
/** The words the server reads as each kind (`picture` is `image`, and so on). */
const HAS_WORDS: Record<string, HasKind> = { image: 'image', picture: 'image', video: 'video', clip: 'video', link: 'link', url: 'link' };

/** A day as the server reads it: `2026-10-30`, 1970 at the earliest. */
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (value: string) => DAY.test(value) && value >= '1970-01-01';

/** Somebody `from:` can offer: the name, and their picture's version (null for the letter their name makes). */
export interface SearchPerson {
  name: string;
  avatar: number | null;
}

export interface SearchOptions {
  /** Who `from:` offers, each with their picture: a roster's members, a thread's two. */
  people?: readonly SearchPerson[];
  /** A group's channels, as this viewer sees them: with these the box has `channel:`, offering them. */
  channels?: readonly string[];
}

/** A filter taken out of the words into a chip in the box: `from:bob` as bob's face and name. */
export interface Chip {
  key: FilterKey;
  value: string;
  /** A `from:` chip's face: the person's picture version, null for the letter. */
  avatar?: number | null;
}

/** What the word under the caret could be completed to: a filter and one of its values. */
export interface Suggestion {
  /** The whole word, `from:bob`. */
  text: string;
  /** The filter's key, for the picture of it. */
  key: FilterKey;
  /** The value alone, `bob`. */
  value: string;
  /** A `from:` suggestion's face: the person's picture version, null for the letter. Absent on the other filters' words. */
  avatar?: number | null;
}

export interface ChatSearch {
  /** The query as the server reads it: the chips as words (`from:bob has:image`), then the typed words. */
  query: string;
  /** The box to these words: its filters become chips, the rest stays typed. `''` empties it. */
  setQuery: (query: string) => void;
  /** The form's submit: the room, or the thread, is asked for the query (`ask`). */
  submit: (e: FormEvent) => void;
  /** The filter buttons this box offers: the four, and `channel` where there are channels. */
  filters: readonly Filter[];
  /** A filter has a chip in the box. */
  filterOn: (key: FilterKey) => boolean;
  /** A filter's word at the end of the box, the caret after its colon, so its list (or its day) comes up. */
  startFilter: (key: FilterKey) => void;
  /** The filters in the box, as chips before the typed words. */
  chips: readonly Chip[];
  removeChip: (index: number) => void;
  /** The typed words, the input's value. */
  text: string;
  /** What the word under the caret could become. Empty when the word is no filter's (or a day's), or the list was dismissed. */
  suggestions: readonly Suggestion[];
  /** The suggestion the arrow keys rest on, an index into `suggestions`. */
  active: number;
  /** One suggestion out of the words into a chip. */
  pick: (index: number) => void;
  /** The word under the caret is `before:` or `after:`: the day picker is up, with what was typed after the colon. */
  day: { key: 'before' | 'after'; typed: string } | null;
  /** A day out of the words into a chip, for the word under the caret; the focus back in the box. */
  pickDay: (value: string) => void;
  /** The list or the day picker down for this word, the focus back in the box. */
  dismiss: () => void;
  /** The box's text and caret as they change: the `onChange` of the input. */
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
  /** The caret as it moves without the text changing: the `onSelect` of the input. */
  onSelect: (e: SyntheticEvent<HTMLInputElement>) => void;
  /**
   * The keys of the box: backspace at its start takes the last chip off; while the list is up
   * the arrows walk it, enter and tab take the one rested on; escape dismisses the list or the
   * day picker (whose own keys are `SearchField`'s, which holds its input). True when
   * the key was the box's, and the caller leaves it alone; false when the caller's own handling
   * (submit, its own escape) goes on.
   */
  onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => boolean;
}

/** What a search box asks on submit: the room on screen, unless the caller says otherwise. */
const askRoom = (query: string) => void searchRoom(query);

/** The box, in characters: the api's (history.rs `SEARCH_CHARS`), which refuses a longer one. */
export const SEARCH_MAX_CHARS = 200;

const chipWord = (chip: Chip) => `${chip.key}:${chip.value}`;

/** The word the caret is in or right after: where it starts and ends in the box, and the part of it before the caret. None on whitespace, or at a word's very start. */
function wordAt(text: string, caret: number): { start: number; end: number; typed: string } | null {
  let start = caret;
  while (start > 0 && !/\s/.test(text[start - 1] ?? ' ')) start -= 1;
  let end = caret;
  while (end < text.length && !/\s/.test(text[end] ?? ' ')) end += 1;
  if (start === caret) return null;
  return { start, end, typed: text.slice(start, caret) };
}

/** A filter word as a chip, when the server would read it: a known `has:` kind, a whole day, any name. Null for a word that is no filter's, or not yet one. */
function chipOf(key: string, value: string, people: readonly SearchPerson[]): Chip | null {
  const k = key.toLowerCase();
  if (k === 'from' && value) {
    const person = people.find((p) => p.name.toLowerCase() === value.toLowerCase());
    return { key: 'from', value: person?.name ?? value, avatar: person?.avatar ?? null };
  }
  if (k === 'channel' || k === 'in') {
    const name = value.replace(/^#/, '');
    return name ? { key: 'channel', value: name } : null;
  }
  if (k === 'has') {
    const kind = HAS_WORDS[value.toLowerCase()];
    return kind ? { key: 'has', value: kind } : null;
  }
  if ((k === 'before' || k === 'after') && isDay(value)) return { key: k, value };
  return null;
}

/** A chip in among the others: the server keeps one of each filter but `has` (the last), so a second `from:` takes the first one's place; `has:` keeps one a kind. */
function withChip(chips: readonly Chip[], chip: Chip): Chip[] {
  const at = chips.findIndex((c) => c.key === chip.key && (chip.key !== 'has' || c.value === chip.value));
  return at < 0 ? [...chips, chip] : chips.map((c, i) => (i === at ? chip : c));
}

/**
 * The filter words in the typed text that are done, out into chips: a word the caret has moved
 * past (a space typed after it), or every one (`all`, for words handed in whole). A word inside
 * a quoted phrase stays a word, as the server reads it. The caret keeps its place in what is left.
 */
function lift(text: string, caret: number, chips: readonly Chip[], people: readonly SearchPerson[], all: boolean) {
  let out = '';
  let at = caret;
  let last = 0;
  let quoted = false;
  let next = chips;
  for (const m of text.matchAll(/\S+/g)) {
    const token = m[0];
    const start = m.index;
    const end = start + token.length;
    if (quoted || token.startsWith('"')) {
      if ((token.match(/"/g)?.length ?? 0) % 2 === 1) quoted = !quoted;
      continue;
    }
    const colon = token.indexOf(':');
    const chip = colon > 0 ? chipOf(token.slice(0, colon), token.slice(colon + 1), people) : null;
    if (!chip || !(all || end < caret)) continue;
    // the word and the spaces after it
    let cut = end;
    while (cut < text.length && /\s/.test(text[cut] ?? '')) cut += 1;
    out += text.slice(last, start);
    last = cut;
    if (caret > start) at -= Math.min(cut, caret) - start;
    next = withChip(next, chip);
  }
  out += text.slice(last);
  return { text: out, caret: at, chips: next };
}

/**
 * The words of a search, and the filters on them, for a box the caller draws (`SearchField`):
 * the group room's over the roster (for a member and a guest alike), the direct message
 * window's under its header. `input` is that box, for the focus a filter hands back to it and
 * the caret a pick puts in it. Submitting asks the room on screen (`searchRoom`), or whatever
 * `ask` says (the window asks its thread, `searchDm`); the hits are the caller's
 * `SearchResults` pane, laid over its lines (the chat panel's, for a group).
 *
 * The filters are chips in the box, not words (Discord's way): `from:` as the person's face and
 * name, `has:` as its kind's glyph, the days as a calendar and the day. A filter word typed out
 * becomes a chip once a space follows it, or when one of its values is picked from what the box
 * offers under the word: `options.people` for `from:`, each with their face, the three kinds for
 * `has:`, a group's channels for `channel:` (`options.channels`, which also puts `channel` among
 * the filters), a day picker for `before:` and `after:`. The query sent is the same words as
 * ever, the chips first (`from:bob has:image hello`).
 */
export function useChatSearch(input: RefObject<HTMLInputElement | null>, ask: (query: string) => void = askRoom, options: SearchOptions = {}): ChatSearch {
  const [chips, setChips] = useState<readonly Chip[]>([]);
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  /** The word the list was dismissed for (escape): it stays down until the word changes. */
  const [dismissed, setDismissed] = useState<string | null>(null);
  /** Where the caret goes once the box shows the text a change made: the input is controlled, so after the render. */
  const caretAfter = useRef<number | null>(null);
  const people = options.people ?? [];
  const filters: readonly Filter[] = options.channels ? [...SEARCH_FILTERS, CHANNEL_FILTER] : SEARCH_FILTERS;
  const query = [...chips.map(chipWord), text.trim()].filter(Boolean).join(' ');

  useLayoutEffect(() => {
    const at = caretAfter.current;
    if (at === null) return;
    caretAfter.current = null;
    input.current?.setSelectionRange(at, at);
  }, [text, chips]);

  /** The typed words and the caret, as one change: the list's rest and its dismissal start over. */
  function put(next: string, at: number) {
    setText(next);
    setCaret(at);
    setActive(0);
    setDismissed(null);
    caretAfter.current = at;
  }

  function setQuery(next: string) {
    const lifted = lift(next, next.length, [], people, true);
    setChips(lifted.chips);
    const words = lifted.text.trim();
    put(words, words.length);
  }

  const filterOn = (key: FilterKey) => chips.some((chip) => chip.key === key);

  function startFilter(key: FilterKey) {
    // the half-typed filter word at the end, if any, gives way to this one
    const kept = text.replace(/(^|\s)(from|has|before|after|channel|in):\S*$/i, '').trimEnd();
    const next = `${kept ? `${kept} ` : ''}${key}:`;
    put(next, next.length);
    input.current?.focus();
  }

  function removeChip(index: number) {
    setChips((now) => now.filter((_, i) => i !== index));
    input.current?.focus();
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    ask(query);
  }

  // the word under the caret, when it is a filter with a value to complete
  const word = wordAt(text, caret);
  const asked = word ? /^([a-z]+):(.*)$/i.exec(word.typed) : null;
  const up = !!(word && asked && dismissed !== word.typed);
  const key = (asked?.[1] ?? '').toLowerCase();
  const typed = asked?.[2] ?? '';
  let suggestions: Suggestion[] = [];
  if (up) {
    const prefix = typed.toLowerCase();
    // what the key could take: a person for `from:` (with their face), a kind not in the box yet for `has:`, a channel for `channel:`
    const values: { value: string; avatar?: number | null }[] =
      key === 'from'
        ? people.map((person) => ({ value: person.name, avatar: person.avatar }))
        : key === 'has'
          ? HAS_KINDS.filter((kind) => !chips.some((chip) => chip.key === 'has' && chip.value === kind)).map((value) => ({ value }))
          : (key === 'channel' || key === 'in') && options.channels
            ? options.channels.map((value) => ({ value }))
            : [];
    const filterKey: FilterKey = key === 'in' ? 'channel' : (key as FilterKey);
    const seen = new Set<string>();
    suggestions = values
      .filter(({ value }) => {
        const low = value.toLowerCase();
        if (!low.startsWith(prefix) || seen.has(low)) return false;
        seen.add(low);
        return true;
      })
      .map((rest) => ({ ...rest, text: `${filterKey}:${rest.value}`, key: filterKey }));
  }
  const day = up && (key === 'before' || key === 'after') ? { key: key as 'before' | 'after', typed } : null;
  const shown = Math.min(active, Math.max(0, suggestions.length - 1));

  /** The word under the caret out of the text, and a chip in its place. */
  function chipWordUnderCaret(chip: Chip) {
    if (!word) return;
    const rest = text.slice(word.end).replace(/^\s+/, '');
    const head = text.slice(0, word.start);
    setChips((now) => withChip(now, chip));
    put(head + rest, word.start);
    input.current?.focus();
  }

  function pick(index: number) {
    const chosen = suggestions[index];
    if (chosen) chipWordUnderCaret({ key: chosen.key, value: chosen.value, avatar: chosen.avatar });
  }

  function pickDay(value: string) {
    if (day && isDay(value)) chipWordUnderCaret({ key: day.key, value });
  }

  function dismiss() {
    if (word) setDismissed(word.typed);
    input.current?.focus();
  }

  function onChange(e: ChangeEvent<HTMLInputElement>) {
    const lifted = lift(e.target.value, e.target.selectionStart ?? e.target.value.length, chips, people, false);
    if (lifted.chips !== chips) setChips(lifted.chips);
    put(lifted.text, lifted.caret);
    // the text as typed: the browser has the caret where it goes, and no fix is wanted after the render
    if (lifted.text === e.target.value) caretAfter.current = null;
  }

  function onSelect(e: SyntheticEvent<HTMLInputElement>) {
    setCaret(e.currentTarget.selectionStart ?? e.currentTarget.value.length);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>): boolean {
    if (e.nativeEvent.isComposing) return false;
    const box = e.currentTarget;
    if (e.key === 'Backspace' && chips.length > 0 && box.selectionStart === 0 && box.selectionEnd === 0) {
      e.preventDefault();
      removeChip(chips.length - 1);
      return true;
    }
    if (e.key === 'Escape' && (suggestions.length > 0 || day)) {
      e.preventDefault();
      e.stopPropagation();
      dismiss();
      return true;
    }
    if (suggestions.length === 0) return false;
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
    return false;
  }

  return {
    query,
    setQuery,
    submit,
    filters,
    filterOn,
    startFilter,
    chips,
    removeChip,
    text,
    suggestions,
    active: shown,
    pick,
    day,
    pickDay,
    dismiss,
    onChange,
    onSelect,
    onKeyDown
  };
}

/** A chip's name for a reader, and its tooltip: `from bob`, `has an image`, `before 2026-10-30`. */
function chipName(chip: Chip): string {
  if (chip.key === 'has') return HAS[chip.value as HasKind]?.title ?? `has ${chip.value}`;
  return `${chip.key} ${chip.value}`;
}

/**
 * One filter in the box: `from:` as the person's face (`Face`, the site's square) and name,
 * `has:` as its kind's glyph alone (its name on hover), a day as the calendar, the word and the
 * day, a channel as `#` and its name. The `×` takes it out; the press leaves the focus in the box.
 */
function SearchChip({ chip, onRemove }: { chip: Chip; onRemove: () => void }) {
  const name = chipName(chip);
  const HasIcon = chip.key === 'has' ? HAS[chip.value as HasKind]?.icon : undefined;
  return (
    <span
      data-chip={chipWord(chip)}
      className="inline-flex h-6 min-w-0 max-w-full shrink-0 items-center gap-1 border border-primaryStroke bg-backgroundTertiary pl-1 pr-0.5 text-xs text-textPrimary"
    >
      {chip.key === 'from' && (
        <>
          <Face name={chip.value} version={chip.avatar ?? null} className="h-4 w-4 text-[9px]" />
          <span className="min-w-0 truncate font-semibold">{chip.value}</span>
        </>
      )}
      {HasIcon && (
        <Tooltip content={name}>
          <span role="img" aria-label={name} className="flex items-center px-0.5 text-textSecondary">
            <HasIcon aria-hidden size={14} />
          </span>
        </Tooltip>
      )}
      {(chip.key === 'before' || chip.key === 'after') && (
        <>
          <RiCalendarLine aria-hidden size={13} className="shrink-0 text-textSecondary" />
          <span className="text-textTertiary">{chip.key}</span>
          <span className="tabular-nums">{chip.value}</span>
        </>
      )}
      {chip.key === 'channel' && (
        <>
          <RiHashtag aria-hidden size={13} className="shrink-0 text-textSecondary" />
          <span className="min-w-0 truncate">{chip.value}</span>
        </>
      )}
      <Tooltip content="remove">
        <button
          type="button"
          aria-label={`remove ${name}`}
          data-chip-remove={chipWord(chip)}
          onMouseDown={(e) => e.preventDefault()}
          onClick={onRemove}
          className="flex h-4 w-4 shrink-0 items-center justify-center text-textTertiary transition-colors duration-150 hover:text-textPrimary"
        >
          <RiCloseLine aria-hidden size={12} />
        </button>
      </Tooltip>
    </span>
  );
}

interface SearchFieldProps {
  search: ChatSearch;
  /** The input, the hook's (`useChatSearch`'s first argument). */
  input: RefObject<HTMLInputElement | null>;
  /** The input's id; `<id>-list` is the list under it, `<id>-day` the day picker. */
  id: string;
  /** The box's name for a reader (`sr-only`). */
  label: string;
  /** Before the chips, inside the box: the group room's glass. */
  leading?: ReactNode;
  /** The caller's keys, after the box's own (`search.onKeyDown`) passed them on: its escape, mostly. */
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
  /** The box's classes: its width, its height. */
  className?: string;
  /** The input's text size and the like. */
  inputClassName?: string;
}

/**
 * The search box: one bordered box with the chips in a row and the input after them, wrapping
 * when they are many, and under it what the word under the caret could become: the list
 * (`SearchSuggestions`) or the day picker (`SearchDay`). A press on the box's empty part puts
 * the focus in the input. While the day picker is up, the down arrow or tab in the box goes into
 * it, and enter takes a whole day typed after the colon (`before:2026-10-30`), or goes into it.
 */
export function SearchField({ search, input, id, label, leading, onKeyDown, className, inputClassName }: SearchFieldProps) {
  const dayInput = useRef<HTMLInputElement | null>(null);
  const listId = `${id}-list`;
  const up = search.suggestions.length > 0 || !!search.day;
  const room = SEARCH_MAX_CHARS - search.chips.reduce((n, chip) => n + chipWord(chip).length + 1, 0);
  return (
    <div className={cn('relative', className)}>
      <div
        onMouseDown={(e) => {
          if (e.target !== e.currentTarget) return;
          e.preventDefault();
          input.current?.focus();
        }}
        className="flex min-h-[1.875rem] cursor-text flex-wrap items-center gap-1 border border-primaryStroke bg-background px-1 py-0.5 focus-within:border-primaryBlue"
      >
        {leading}
        {search.chips.map((chip, i) => (
          <SearchChip key={chipWord(chip)} chip={chip} onRemove={() => search.removeChip(i)} />
        ))}
        <label htmlFor={id} className="sr-only">
          {label}
        </label>
        <input
          ref={input}
          id={id}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={up}
          aria-controls={search.day ? `${id}-day` : listId}
          aria-activedescendant={search.suggestions.length > 0 ? `${listId}-${search.active}` : undefined}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          maxLength={Math.max(0, room)}
          value={search.text}
          onChange={search.onChange}
          onSelect={search.onSelect}
          onKeyDown={(e) => {
            const day = search.day;
            if (day && !e.nativeEvent.isComposing && (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey) || e.key === 'Enter')) {
              e.preventDefault();
              if (e.key === 'Enter' && isDay(day.typed)) search.pickDay(day.typed);
              else dayInput.current?.focus();
              return;
            }
            if (search.onKeyDown(e)) return;
            onKeyDown?.(e);
          }}
          placeholder={search.chips.length > 0 ? undefined : 'search'}
          className={cn(
            'h-6 min-w-[4rem] flex-1 bg-transparent px-1 text-base leading-snug text-textPrimary outline-none placeholder:text-textTertiary',
            inputClassName
          )}
        />
      </div>
      <SearchSuggestions id={listId} search={search} />
      <SearchDay id={`${id}-day`} search={search} input={dayInput} />
    </div>
  );
}

/**
 * The filter buttons under the box: each its glyph and its key, a click starts the filter in the
 * box (its list, or the day picker, comes up), its tooltip what it does. Blue while it has a chip
 * in the box. The press leaves the focus where it is, so a box that shows these only while it has
 * the focus (the group room's) keeps them through the click.
 */
export function SearchFilters({ search, id, className }: { search: ChatSearch; id: string; className?: string }) {
  return (
    <div id={id} className={cn('flex flex-wrap gap-1', className)}>
      {search.filters.map(({ key, icon: Icon, title }) => (
        <Tooltip key={key} content={title} className="max-w-64 whitespace-normal">
          <Button
            size="sm"
            data-filter={key}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => search.startFilter(key)}
            className={cn('gap-1 px-1.5 py-0.5 text-xs font-normal max-md:min-h-0', search.filterOn(key) ? 'border-primaryBlue text-primaryBlue' : 'text-textSecondary')}
          >
            <Icon aria-hidden size={13} />
            {key}
          </Button>
        </Tooltip>
      ))}
    </div>
  );
}

/**
 * What the word under the caret could become, under the box: a list in a box of its own (a
 * stroke, no shadow), one row a suggestion, the one the arrow keys rest on in blue. A `from:`
 * row wears the person's face before the name, a `has:` row its kind's glyph, a channel's `#`.
 * A press on a row leaves the focus in the box; the click makes the chip. Nothing while there is
 * nothing to offer.
 */
export function SearchSuggestions({ search, id, className }: { search: ChatSearch; id: string; className?: string }) {
  if (search.suggestions.length === 0) return null;
  return (
    <ul
      id={id}
      role="listbox"
      aria-label="what the filter could be"
      className={cn('absolute left-0 right-0 top-full z-20 mt-1 max-h-48 overflow-y-auto border border-primaryStroke bg-backgroundSecondary py-1 text-sm', className)}
    >
      {search.suggestions.map((suggestion, i) => {
        const HasIcon = suggestion.key === 'has' ? HAS[suggestion.value as HasKind]?.icon : undefined;
        return (
          <li key={suggestion.text} id={`${id}-${i}`} role="option" aria-selected={i === search.active}>
            <button
              type="button"
              tabIndex={-1}
              data-suggestion={suggestion.text}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => search.pick(i)}
              className={cn(
                'flex w-full items-center gap-2 px-2 py-1 text-left',
                i === search.active ? 'bg-primaryBlue/10 text-primaryBlue' : 'text-textPrimary hover:bg-backgroundTertiary'
              )}
            >
              {suggestion.key === 'from' && <Face name={suggestion.value} version={suggestion.avatar ?? null} className="h-5 w-5 text-[10px]" />}
              {HasIcon && <HasIcon aria-hidden size={16} className="shrink-0" />}
              {suggestion.key === 'channel' && <RiHashtag aria-hidden size={16} className="shrink-0" />}
              <span className="min-w-0 truncate">{suggestion.value}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The day picker under the box while the word under the caret is `before:` or `after:`: the
 * browser's own date input, and `add`. Enter in it (or `add`) makes the chip, escape goes back
 * to the box.
 */
function SearchDay({ search, id, input }: { search: ChatSearch; id: string; input: RefObject<HTMLInputElement | null> }) {
  const day = search.day;
  // the draft starts over for each word: what was typed after the colon, when it is a day
  const [draft, setDraft] = useState({ for: '', value: '' });
  if (!day) return null;
  const forWord = `${day.key}:${day.typed}`;
  const value = draft.for === forWord ? draft.value : isDay(day.typed) ? day.typed : '';
  return (
    <div
      id={id}
      role="dialog"
      aria-label={`lines ${day.key} a day`}
      className="absolute left-0 right-0 top-full z-20 mt-1 flex flex-wrap items-center gap-2 border border-primaryStroke bg-backgroundSecondary p-2 text-sm"
    >
      <RiCalendarLine aria-hidden size={16} className="shrink-0 text-textSecondary" />
      <label htmlFor={`${id}-input`} className="shrink-0 text-textSecondary">
        {day.key}
      </label>
      <input
        ref={input}
        id={`${id}-input`}
        type="date"
        min="1970-01-01"
        value={value}
        onChange={(e) => setDraft({ for: forWord, value: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            search.pickDay(value);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            search.dismiss();
          }
        }}
        className="min-w-[8.5rem] flex-1 border border-primaryStroke bg-background px-1.5 py-0.5 text-sm text-textPrimary focus:border-primaryBlue"
      />
      <Button
        size="sm"
        variant="outline"
        disabled={!isDay(value)}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => search.pickDay(value)}
        className="py-0.5 max-md:min-h-0"
      >
        add
      </Button>
    </div>
  );
}

interface SearchResultsProps {
  /** The pane's id; `<id>-close` is the close, `<id>-empty` the word for no hits. */
  id: string;
  /** What the hits are for: the words asked, or a speaker's name. */
  label: string;
  /** How many hits there are, for the first row; 0 is `nothing`. */
  count: number;
  onClose: () => void;
  className?: string;
  /** The hits, newest first, a `SearchHit` each. */
  children?: ReactNode;
}

/**
 * The hits of a search where the lines were, the whole of their place: a row at the top with
 * what they are for, how many, and `close`; then the hits, a row each (`SearchHit`), or
 * `nothing`. The caller lays it over its lines (`absolute inset-0` in the lines' box), which
 * keep their place under it as `invisible`, so their scroll, their refs and their listeners
 * hold, and a line coming meanwhile still lands at the bottom; `close`, or a hit picked, takes
 * the pane away and the lines are as they were. The room chat's (ChatPanel.tsx, `#chat-results`)
 * and the direct message window's (FriendChat.tsx, `#friend-chat-results`) are this one.
 */
export function SearchResults({ id, label, count, onClose, className, children }: SearchResultsProps) {
  return (
    <section id={id} aria-label={`search hits for ${label}`} className={cn('flex min-h-0 flex-col', className)}>
      <div className="flex shrink-0 items-center gap-2 border-b border-primaryStroke px-3 py-1 text-xs text-textTertiary">
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {count > 0 && <span className="shrink-0 tabular-nums">{count === 1 ? '1 line' : `${count} lines`}</span>}
        <button
          id={`${id}-close`}
          type="button"
          onClick={onClose}
          className="shrink-0 font-semibold text-textSecondary transition-colors duration-150 hover:text-textPrimary"
        >
          close
        </button>
      </div>
      {count === 0 ? (
        <p id={`${id}-empty`} className="px-3 py-2 text-textTertiary">
          nothing
        </p>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1">{children}</ul>
      )}
    </section>
  );
}

interface SearchHitProps {
  /** The line's id, as `data-id` on the button; the pages and the tests key on it. */
  id: string | number;
  /** Unix ms on the line: the short clock at the left, the full stamp as the title. */
  at: number;
  /** Before the name: a group hit's channel when it is not the one on screen. */
  before?: ReactNode;
  /** The writer as drawn: a room's speaker in blue, a thread's name (yours in blue). */
  who: ReactNode;
  /** The words; empty for a line of pictures alone, and nothing is drawn after the name then but the mark. */
  text: string;
  /** How many pictures are on the line: the picture mark, and the count past one. */
  images: number;
  /** The line has a video of its own: the film mark. */
  video?: boolean;
  onClick: () => void;
  /** The button's own attributes besides `data-id`: `data-channel` on a group's hit. */
  attrs?: HTMLAttributes<HTMLButtonElement> & Record<`data-${string}`, string | number | boolean | undefined>;
}

/**
 * One hit in the pane: the clock at the left, then the name and the words, wrapped in full, and
 * the picture mark with a count for pictures. The whole row is the click (the button's `after`
 * covers the row, the clock with it), and a pointer or the focus on it tints the row.
 */
export function SearchHit({ id, at, before, who, text, images, video = false, onClick, attrs }: SearchHitProps) {
  const pictures = images === 1 ? 'a picture' : `${images} pictures`;
  return (
    <li className="relative flex items-baseline gap-2 px-3 py-1 transition-colors duration-150 focus-within:bg-backgroundTertiary hover:bg-backgroundTertiary">
      <span className="shrink-0 text-xs tabular-nums text-textTertiary">{when(at)}</span>
      <button
        {...attrs}
        type="button"
        data-id={id}
        title={at ? stamp(at) : undefined}
        onClick={onClick}
        className="min-w-0 flex-1 text-left [overflow-wrap:anywhere] after:absolute after:inset-0 after:content-[''] focus-visible:outline-none"
      >
        {before}
        {who}
        {text && <span className="text-textSecondary">: {plainEmotes(text)}</span>}
        {images > 0 && (
          // over the button's `after`, so the pointer reaches the mark and its tooltip; the click still falls through to the row
          <Tooltip content={pictures}>
            <span role="img" aria-label={pictures} className="relative z-10 ml-1 inline-flex items-center gap-0.5 align-middle text-textTertiary">
              <RiImageLine aria-hidden size={12} />
              {images > 1 && <span className="text-xs tabular-nums">{images}</span>}
            </span>
          </Tooltip>
        )}
        {video && (
          <Tooltip content="a video">
            <span role="img" aria-label="a video" className="relative z-10 ml-1 inline-flex items-center align-middle text-textTertiary">
              <RiFilmLine aria-hidden size={12} />
            </span>
          </Tooltip>
        )}
      </button>
    </li>
  );
}
