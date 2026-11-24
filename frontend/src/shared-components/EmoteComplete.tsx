import { type KeyboardEvent, type ReactNode, type RefObject, type SyntheticEvent, useId, useState } from 'react';

import { type Emote, emoteQueryAt, emoteSrc, matchEmotes, notePicked, useMyEmotes } from '@/infra/emotes';
import { cn } from '@/utils/cn';

export interface EmoteCompleteBox {
  onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => boolean;
  onSelect: (e: SyntheticEvent<HTMLInputElement>) => void;
  onBlur: () => void;
  role: 'combobox';
  'aria-expanded': boolean;
  'aria-controls': string | undefined;
  'aria-activedescendant': string | undefined;
  'aria-autocomplete': 'list';
}

export function useEmoteComplete({
  value,
  onChange,
  input,
  id
}: {
  value: string;
  onChange: (next: string) => void;
  input: RefObject<HTMLInputElement | null>;
  id?: string;
}): { box: EmoteCompleteBox; list: ReactNode; open: boolean } {
  const mine = useMyEmotes();
  const own = useId();
  const listId = id ?? `emote-complete-${own.replace(/:/g, '')}`;
  const [caret, setCaret] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  const [shut, setShut] = useState('');

  const at = caret === null ? null : emoteQueryAt(value, caret);
  const found = at ? matchEmotes(mine, at.query) : [];
  const key = at ? `${at.start}:${at.query}` : '';
  const open = found.length > 0 && key !== shut;
  const lit = Math.min(active, Math.max(0, found.length - 1));

  function pick(emote: Emote) {
    if (!at || caret === null) return;
    const word = `:${emote.name}: `;
    const next = value.slice(0, at.start) + word + value.slice(caret);
    const to = at.start + word.length;
    notePicked(emote);
    onChange(next);
    setCaret(to);
    setActive(0);
    requestAnimationFrame(() => input.current?.setSelectionRange(to, to));
  }

  const box: EmoteCompleteBox = {
    onKeyDown: (e) => {
      if (!open || e.nativeEvent.isComposing) return false;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setActive((lit + step + found.length) % found.length);
        return true;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        const emote = found[lit];
        if (!emote) return false;
        e.preventDefault();
        pick(emote);
        return true;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setShut(key);
        return true;
      }
      return false;
    },
    onSelect: (e) => {
      const el = e.currentTarget;
      const next = el.selectionStart === el.selectionEnd ? el.selectionStart : null;
      if (next !== caret) {
        setCaret(next);
        setActive(0);
      }
    },
    onBlur: () => setCaret(null),
    role: 'combobox',
    'aria-expanded': open,
    'aria-controls': open ? listId : undefined,
    'aria-activedescendant': open ? `${listId}-${lit}` : undefined,
    'aria-autocomplete': 'list'
  };

  const list = open ? (
    <div
      id={`${listId}-panel`}
      data-emote-complete
      onPointerDown={(e) => e.preventDefault()}
      onMouseDown={(e) => e.preventDefault()}
      className="absolute bottom-full left-0 right-0 z-30 mb-1 border border-primaryStroke bg-backgroundSecondary py-1 text-sm"
    >
      <p className="px-2.5 pb-1 text-xs text-textTertiary">
        emotes matching <span className="font-semibold text-textSecondary">:{at?.query}</span>
      </p>
      <ul id={listId} role="listbox" aria-label="emotes" className="max-h-64 overflow-y-auto">
        {found.map((emote, i) => (
          <li
            key={emote.id}
            id={`${listId}-${i}`}
            role="option"
            aria-selected={i === lit}
            data-emote-option={emote.name}
            onPointerEnter={() => setActive(i)}
            onClick={() => pick(emote)}
            className={cn('flex cursor-pointer items-center gap-2.5 px-2.5 py-1', i === lit ? 'bg-primaryBlue/15 text-textPrimary' : 'text-textSecondary')}
          >
            <img src={emoteSrc(emote.id)} alt="" className="h-6 w-6 shrink-0 object-contain" />
            <span className="min-w-0 flex-1 truncate font-semibold">:{emote.name}:</span>
            <span className="shrink-0 truncate text-xs text-textTertiary">{emote.group}</span>
          </li>
        ))}
      </ul>
    </div>
  ) : null;

  return { box, list, open };
}
