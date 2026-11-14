import { RiCheckLine, RiExpandUpDownLine } from '@remixicon/react';
import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { cn } from '@/utils/cn';

/** One thing to pick: what a pick says, and the words for it. */
export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
  /** Listed, and not to be picked. */
  disabled?: boolean;
}

interface SelectProps<T extends string> {
  /** The box's id, the one the tests key on. `<id>-list` is the open list, and an option in it wears its `data-value`. */
  id: string;
  /** Its name for a screen reader. A word beside it on the page names it for the eye only. */
  label: string;
  value: T;
  options: readonly SelectOption<T>[];
  /** A pick of another option than the one that is on. */
  onChange: (value: T) => void;
  /** What the box says while `value` is none of the options. */
  placeholder?: string;
  disabled?: boolean;
  /** Classes for the box: a width (`w-full`, `min-w-0 flex-1`), another padding. The list is as wide as the box at the least. */
  className?: string;
}

/** Between the box and its list. */
const GAP = 4;
/** The least the list keeps from the edge of the window. */
const EDGE = 4;
/** The most of the list at once, in px. Past it the list scrolls. */
const TALLEST = 240;
/** How long the letters typed count as one word. */
const TYPING_MS = 500;
/** How many options page up and page down go. */
const PAGE = 10;

/** The box: an input's look (a stroke on the page colour), in the type of whatever it sits in. Its padding is in ems so it keeps its shape at any size. */
const BOX =
  'inline-flex cursor-pointer select-none items-center gap-[0.5em] border border-primaryStroke bg-background px-[0.5em] py-[0.33em] text-left text-textPrimary transition-colors duration-150 hover:border-secondaryStroke focus-visible:border-primaryBlue focus-visible:outline-none';
/**
 * The list: the page's stroke on the secondary background and no shadow, like every floating
 * box (Tooltip.tsx). Over the open sidebar (z-40) and the chat window (z-50). `left-0 top-0`
 * until `place` puts it where it goes.
 */
const LIST = 'fixed left-0 top-0 z-[60] w-max overflow-y-auto overflow-x-hidden overscroll-contain border border-primaryStroke bg-backgroundSecondary py-1';
/** A row of it. The same inset as the box's, so the words line up under the box's. Taller under a finger. */
const OPTION = 'flex cursor-pointer select-none items-center gap-[0.5em] whitespace-nowrap px-[0.5em] py-[0.33em] [@media(pointer:coarse)]:py-[0.75em]';

/**
 * Puts the list `el` where it goes for its box `anchor`: under it, or over it where there is
 * more room; as wide as the box at the least; never past the window; in the box's type.
 */
function place(el: HTMLElement, anchor: HTMLElement) {
  const view = anchor.ownerDocument.documentElement;
  const worn = (anchor.ownerDocument.defaultView ?? window).getComputedStyle(anchor);
  const a = anchor.getBoundingClientRect();
  // clientWidth, not innerWidth: the window's scrollbar is not room
  const vw = view.clientWidth;
  const vh = view.clientHeight;
  // the box's type: the list is drawn into the body, where the type is the page's
  el.style.fontSize = worn.fontSize;
  el.style.lineHeight = worn.lineHeight;
  el.style.minWidth = `${a.width}px`;
  el.style.maxWidth = `${vw - 2 * EDGE}px`;
  // all of it, with its stroke top and bottom; as much of that as it shows; as much of that as there is room for
  const all = el.scrollHeight + el.offsetHeight - el.clientHeight;
  const wants = Math.min(all, TALLEST);
  const under = vh - EDGE - GAP - a.bottom;
  const over = a.top - GAP - EDGE;
  const below = wants <= under || under >= over;
  const height = Math.max(0, Math.min(wants, below ? under : over));
  el.style.maxHeight = `${height}px`;
  // a list that scrolls is wider by its bar, so no row is cut short for it. chrome and safari count the bar into a
  // box as wide as its content either way; firefox counts only a bar that is always there, where its bars take room
  el.style.overflowY = all - height > 1 ? 'scroll' : '';
  el.style.left = `${Math.max(EDGE, Math.min(a.left, vw - el.offsetWidth - EDGE))}px`;
  el.style.top = `${below ? a.bottom + GAP : a.top - GAP - height}px`;
}

/**
 * A box that picks one of a few options: the one that is on, and a list of them all that opens
 * under it. The site's own, drawn by the page, so it is the same box in every browser. The
 * browser's select is not used anywhere: its open list is the operating system's, round and
 * glossy on a mac, another thing again in each browser, and no css reaches it
 * (.cursor/skills/no-native-select).
 *
 * A click opens and shuts it. So do the keys, the way a select's do: enter, space or an arrow
 * opens it on the option that is on, the arrows, home, end and the page keys walk it (past
 * what cannot be picked, stopping at the ends), enter or space picks, escape shuts it and
 * changes nothing (a dialog it is in stays open), tab picks and moves on, and letters typed
 * go to the option that starts with them. A press anywhere else, or the focus leaving, shuts
 * it unchanged. The option that is on is blue and ticked.
 *
 * The keyboard's focus stays on the box the whole time (`aria-activedescendant` says where the
 * keys are), so nothing in the list is focused and no pane scrolls to it. The box is a `div`
 * that takes the focus, not a `button`: safari leaves a button out of the tab order unless a
 * setting is changed, and does not focus one on a click, and a select has neither fault.
 *
 * The list is drawn into the body, `fixed`, so no pane clips it and it sits over every panel,
 * and it follows its box through a scroll or a resize; inside a modal dialog it is drawn into
 * the dialog instead, since nothing in the body reaches the top layer (the tooltips' way). It
 * goes under the box, or over it where there is more room, is as wide as the box at the least
 * and as its longest option at the most, and scrolls past 240px. It wears the box's type size.
 */
export function Select<T extends string>({ id, label, value, options, onChange, placeholder, disabled = false, className }: SelectProps<T>) {
  const box = useRef<HTMLDivElement | null>(null);
  const list = useRef<HTMLUListElement | null>(null);
  const [open, setOpen] = useState(false);
  /** The option the keys and the pointer rest on while the list is open, by its place in `options`. */
  const [active, setActive] = useState(-1);
  /** Where the list is drawn. Known from the first time it opens. */
  const [host, setHost] = useState<HTMLElement | null>(null);
  /** The letters typed lately, and when the last one was. */
  const typed = useRef({ word: '', at: 0 });
  /** The keys moved `active`, so the list scrolls to it. The pointer's own moves scroll nothing. */
  const follow = useRef(false);
  /** Where the pointer last was over the list. */
  const pointer = useRef<{ x: number; y: number } | null>(null);

  const chosen = options.findIndex((option) => option.value === value);
  /** The places in `options` of what can be picked. */
  const usable = options.flatMap((option, i) => (option.disabled ? [] : [i]));
  const shown = open && !disabled && usable.length > 0;
  /** Where the keys are among `usable`: on `active` while the list is open, on the option that is on while it is shut. */
  const here = Math.max(0, usable.indexOf(shown ? active : chosen));

  /** Opens the list with the keys on `at`: the option that is on, unless said. */
  function show(at = usable.includes(chosen) ? chosen : (usable[0] ?? -1)) {
    const el = box.current;
    if (!el || disabled || usable.length === 0) return;
    setHost(el.closest<HTMLElement>('dialog:modal') ?? el.ownerDocument.body);
    follow.current = true;
    pointer.current = null;
    setActive(at);
    setOpen(true);
  }

  /** Shuts the list, and says the option at `at` when it is another than the one that is on. */
  function pick(at: number) {
    const option = options[at];
    setOpen(false);
    if (option && !option.disabled && option.value !== value) onChange(option.value);
  }

  /** The keys go to the `to`th option that can be picked, and stop at the list's ends. */
  function walk(to: number) {
    follow.current = true;
    setActive(usable[Math.max(0, Math.min(to, usable.length - 1))] ?? -1);
  }

  /**
   * A letter typed: the keys go to the next option that starts with what was typed in the last
   * half second, and the list opens for it. One letter again and again walks the options that
   * start with it.
   */
  function type(letter: string) {
    const now = Date.now();
    const word = (now - typed.current.at > TYPING_MS ? '' : typed.current.word) + letter.toLowerCase();
    typed.current = { word, at: now };
    const again = [...word].every((c) => c === word[0]);
    const start = again ? word.slice(0, 1) : word;
    const from = again ? here + 1 : here;
    for (let n = 0; n < usable.length; n++) {
      const at = usable[(from + n) % usable.length];
      if (at === undefined || !options[at]?.label.toLowerCase().startsWith(start)) continue;
      if (shown) {
        follow.current = true;
        setActive(at);
      } else show(at);
      return;
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (disabled) return;
    const typing = typed.current.word !== '' && Date.now() - typed.current.at <= TYPING_MS;
    // a letter or a digit, and a space in the middle of a word: typed towards an option
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && (e.key !== ' ' || typing)) {
      e.preventDefault();
      type(e.key);
      return;
    }
    if (!shown) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') show();
      else if (e.key === 'Home') show(usable[0]);
      else if (e.key === 'End') show(usable[usable.length - 1]);
      else return;
      e.preventDefault();
      return;
    }
    if (e.key === 'Tab') {
      // the focus moves on, and the option the keys rest on is the pick
      pick(active);
      return;
    }
    if (e.key === 'ArrowDown') walk(here + 1);
    else if (e.key === 'ArrowUp') walk(here - 1);
    else if (e.key === 'PageDown') walk(here + PAGE);
    else if (e.key === 'PageUp') walk(here - PAGE);
    else if (e.key === 'Home') walk(0);
    else if (e.key === 'End') walk(usable.length - 1);
    else if (e.key === 'Enter' || e.key === ' ') pick(active);
    else if (e.key === 'Escape') {
      // the list's alone: a dialog it is in stays open, and so does a menu above it
      e.stopPropagation();
      setOpen(false);
    } else return;
    e.preventDefault();
  }

  // placed before it is painted, and after every render while it is open: its options may have changed
  useLayoutEffect(() => {
    if (shown && list.current && box.current) place(list.current, box.current);
  });

  // the keys moved: the option they rest on is brought into the list's view, with the list's own
  // inset at its two ends. by hand: scrollIntoView would scroll the page under it as well
  useLayoutEffect(() => {
    const el = list.current;
    const row = el?.children[active] as HTMLElement | undefined;
    if (!shown || !follow.current || !el || !row) return;
    const top = row.previousElementSibling ? row.offsetTop : 0;
    const bottom = row.nextElementSibling ? row.offsetTop + row.offsetHeight : el.scrollHeight;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
  }, [shown, active]);

  // while it is open: it follows its box through a scroll of anything but itself and through a
  // resize, and a press anywhere but on the box or the list shuts it
  useEffect(() => {
    if (!shown) return;
    const win = box.current?.ownerDocument.defaultView ?? window;
    const follows = (e: Event) => {
      if (list.current && box.current && e.target !== list.current) place(list.current, box.current);
    };
    const onPress = (e: PointerEvent) => {
      const at = e.target as Node | null;
      if (box.current?.contains(at) || list.current?.contains(at)) return;
      setOpen(false);
    };
    win.addEventListener('scroll', follows, true);
    win.addEventListener('resize', follows);
    win.addEventListener('pointerdown', onPress, true);
    return () => {
      win.removeEventListener('scroll', follows, true);
      win.removeEventListener('resize', follows);
      win.removeEventListener('pointerdown', onPress, true);
    };
  }, [shown]);

  return (
    <>
      <div
        ref={box}
        id={id}
        role="combobox"
        tabIndex={disabled ? undefined : 0}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={shown}
        aria-controls={shown ? `${id}-list` : undefined}
        aria-activedescendant={shown && active >= 0 ? `${id}-option-${active}` : undefined}
        aria-disabled={disabled || undefined}
        data-value={value}
        onClick={() => (shown ? setOpen(false) : show())}
        onKeyDown={onKeyDown}
        onBlur={() => setOpen(false)}
        className={cn(BOX, shown && 'border-primaryBlue hover:border-primaryBlue', disabled && 'cursor-default opacity-40 hover:border-primaryStroke', className)}
      >
        {/* a space when there is nothing to say: the box keeps its height */}
        <span className={cn('min-w-0 flex-1 truncate', chosen < 0 && 'text-textTertiary')}>{options[chosen]?.label ?? placeholder ?? '\u00a0'}</span>
        <RiExpandUpDownLine aria-hidden size="1.15em" className="shrink-0 text-textTertiary" />
      </div>
      {shown &&
        host &&
        createPortal(
          // a press on the list leaves the focus on the box: the focus leaving is what shuts it
          <ul ref={list} id={`${id}-list`} role="listbox" aria-label={label} onMouseDown={(e) => e.preventDefault()} className={LIST}>
            {options.map((option, i) => (
              <li
                key={option.value}
                id={`${id}-option-${i}`}
                role="option"
                aria-selected={i === chosen}
                aria-disabled={option.disabled || undefined}
                data-value={option.value}
                data-active={i === active || undefined}
                onPointerMove={(e) => {
                  // only a pointer that itself moved takes the highlight. safari says a pointer at rest moved when the list
                  // scrolls under it (the keys walking it), at the place it already was; the first place is only noted
                  const was = pointer.current;
                  pointer.current = { x: e.clientX, y: e.clientY };
                  if (e.pointerType === 'touch' || option.disabled || i === active || !was || (was.x === e.clientX && was.y === e.clientY)) return;
                  follow.current = false;
                  setActive(i);
                }}
                onClick={() => {
                  if (!option.disabled) pick(i);
                }}
                className={cn(
                  OPTION,
                  option.disabled ? 'cursor-default opacity-40' : i === active && 'bg-backgroundTertiary',
                  i === chosen ? 'text-primaryBlue' : i === active && !option.disabled ? 'text-textPrimary' : 'text-textSecondary'
                )}
              >
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                {i === chosen && <RiCheckLine aria-hidden size="1.15em" className="shrink-0" />}
              </li>
            ))}
          </ul>,
          host
        )}
    </>
  );
}
