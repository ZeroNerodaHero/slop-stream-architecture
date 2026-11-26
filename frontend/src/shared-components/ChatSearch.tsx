import { type RemixiconComponentType, RiAttachment2, RiCalendarLine, RiCloseLine, RiFilmLine, RiHashtag, RiImageLine, RiLink, RiMicLine, RiUserLine, RiVideoLine } from '@remixicon/react';
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

export type FilterKey = 'from' | 'has' | 'before' | 'after' | 'channel';

export interface Filter {
  key: FilterKey;
  icon: RemixiconComponentType;
  title: string;
}

const SEARCH_FILTERS: readonly Filter[] = [
  { key: 'from', icon: RiUserLine, title: 'lines said under a name, and by that account under any name' },
  { key: 'has', icon: RiAttachment2, title: 'lines with a picture, a video or a link' },
  { key: 'before', icon: RiCalendarLine, title: 'lines said before a day (utc)' },
  { key: 'after', icon: RiCalendarLine, title: 'lines said after a day (utc), the day itself out' }
];

const CHANNEL_FILTER: Filter = { key: 'channel', icon: RiHashtag, title: 'lines in one channel of the group. without it, every channel you see is searched' };

type HasKind = 'image' | 'video' | 'link';
const HAS: Record<HasKind, { icon: RemixiconComponentType; title: string }> = {
  image: { icon: RiImageLine, title: 'has an image' },
  video: { icon: RiVideoLine, title: 'has a video: an uploaded one, youtube, twitch, a clip, an mp4' },
  link: { icon: RiLink, title: 'has a link' }
};
const HAS_KINDS = Object.keys(HAS) as HasKind[];
const HAS_WORDS: Record<string, HasKind> = { image: 'image', picture: 'image', video: 'video', clip: 'video', link: 'link', url: 'link' };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (value: string) => DAY.test(value) && value >= '1970-01-01';

export interface SearchPerson {
  name: string;
  avatar: number | null;
}

export interface SearchOptions {
  people?: readonly SearchPerson[];
  channels?: readonly string[];
}

export interface Chip {
  key: FilterKey;
  value: string;
  avatar?: number | null;
}

export interface Suggestion {
  text: string;
  key: FilterKey;
  value: string;
  avatar?: number | null;
}

export interface ChatSearch {
  query: string;
  setQuery: (query: string) => void;
  submit: (e: FormEvent) => void;
  filters: readonly Filter[];
  filterOn: (key: FilterKey) => boolean;
  startFilter: (key: FilterKey) => void;
  chips: readonly Chip[];
  removeChip: (index: number) => void;
  text: string;
  suggestions: readonly Suggestion[];
  active: number;
  pick: (index: number) => void;
  day: { key: 'before' | 'after'; typed: string } | null;
  pickDay: (value: string) => void;
  dismiss: () => void;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
  onSelect: (e: SyntheticEvent<HTMLInputElement>) => void;
  onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => boolean;
}

const askRoom = (query: string) => void searchRoom(query);

export const SEARCH_MAX_CHARS = 200;

const chipWord = (chip: Chip) => `${chip.key}:${chip.value}`;

function wordAt(text: string, caret: number): { start: number; end: number; typed: string } | null {
  let start = caret;
  while (start > 0 && !/\s/.test(text[start - 1] ?? ' ')) start -= 1;
  let end = caret;
  while (end < text.length && !/\s/.test(text[end] ?? ' ')) end += 1;
  if (start === caret) return null;
  return { start, end, typed: text.slice(start, caret) };
}

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

function withChip(chips: readonly Chip[], chip: Chip): Chip[] {
  const at = chips.findIndex((c) => c.key === chip.key && (chip.key !== 'has' || c.value === chip.value));
  return at < 0 ? [...chips, chip] : chips.map((c, i) => (i === at ? chip : c));
}

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

export function useChatSearch(input: RefObject<HTMLInputElement | null>, ask: (query: string) => void = askRoom, options: SearchOptions = {}): ChatSearch {
  const [chips, setChips] = useState<readonly Chip[]>([]);
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
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

  const word = wordAt(text, caret);
  const asked = word ? /^([a-z]+):(.*)$/i.exec(word.typed) : null;
  const up = !!(word && asked && dismissed !== word.typed);
  const key = (asked?.[1] ?? '').toLowerCase();
  const typed = asked?.[2] ?? '';
  let suggestions: Suggestion[] = [];
  if (up) {
    const prefix = typed.toLowerCase();
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

function chipName(chip: Chip): string {
  if (chip.key === 'has') return HAS[chip.value as HasKind]?.title ?? `has ${chip.value}`;
  return `${chip.key} ${chip.value}`;
}

function SearchChip({ chip, onRemove }: { chip: Chip; onRemove: () => void }) {
  const name = chipName(chip);
  const HasIcon = chip.key === 'has' ? HAS[chip.value as HasKind]?.icon : undefined;
  return (
    <span
      data-chip={chipWord(chip)}
      className="inline-flex h-6 min-w-0 max-w-full shrink-0 items-center gap-1 rounded-control border border-primaryStroke bg-backgroundTertiary pl-1 pr-0.5 text-xs text-textPrimary"
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
  input: RefObject<HTMLInputElement | null>;
  id: string;
  label: string;
  leading?: ReactNode;
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
  className?: string;
  inputClassName?: string;
}

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
        className="flex min-h-[1.875rem] cursor-text flex-wrap items-center gap-1 rounded-control border border-primaryStroke bg-background px-1 py-0.5 focus-within:border-primaryBlue"
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

export function SearchSuggestions({ search, id, className }: { search: ChatSearch; id: string; className?: string }) {
  if (search.suggestions.length === 0) return null;
  return (
    <ul
      id={id}
      role="listbox"
      aria-label="what the filter could be"
      className={cn('absolute left-0 right-0 top-full z-20 mt-1 max-h-48 overflow-y-auto rounded-panel border border-primaryStroke bg-backgroundSecondary py-1 text-sm', className)}
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

function SearchDay({ search, id, input }: { search: ChatSearch; id: string; input: RefObject<HTMLInputElement | null> }) {
  const day = search.day;
  const [draft, setDraft] = useState({ for: '', value: '' });
  if (!day) return null;
  const forWord = `${day.key}:${day.typed}`;
  const value = draft.for === forWord ? draft.value : isDay(day.typed) ? day.typed : '';
  return (
    <div
      id={id}
      role="dialog"
      aria-label={`lines ${day.key} a day`}
      className="absolute left-0 right-0 top-full z-20 mt-1 flex flex-wrap items-center gap-2 rounded-panel border border-primaryStroke bg-backgroundSecondary p-2 text-sm"
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
        className="min-w-[8.5rem] flex-1 rounded-control border border-primaryStroke bg-background px-1.5 py-0.5 text-sm text-textPrimary focus:border-primaryBlue"
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
  id: string;
  label: string;
  count: number;
  onClose: () => void;
  className?: string;
  children?: ReactNode;
}

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
  id: string | number;
  at: number;
  before?: ReactNode;
  who: ReactNode;
  text: string;
  images: number;
  video?: boolean;
  audio?: boolean;
  onClick: () => void;
  attrs?: HTMLAttributes<HTMLButtonElement> & Record<`data-${string}`, string | number | boolean | undefined>;
}

export function SearchHit({ id, at, before, who, text, images, video = false, audio = false, onClick, attrs }: SearchHitProps) {
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
        {audio && (
          <Tooltip content="a voice message">
            <span role="img" aria-label="a voice message" className="relative z-10 ml-1 inline-flex items-center align-middle text-textTertiary">
              <RiMicLine aria-hidden size={12} />
            </span>
          </Tooltip>
        )}
      </button>
    </li>
  );
}
