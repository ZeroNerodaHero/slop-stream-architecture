import { RiCheckLine, RiExpandUpDownLine } from '@remixicon/react';
import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { cn } from '@/utils/cn';

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
  disabled?: boolean;
}

interface SelectProps<T extends string> {
  id: string;
  label: string;
  value: T;
  options: readonly SelectOption<T>[];
  onChange: (value: T) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

const GAP = 4;
const EDGE = 4;
const TALLEST = 240;
const TYPING_MS = 500;
const PAGE = 10;

const BOX =
  'inline-flex cursor-pointer select-none items-center gap-[0.5em] rounded-control border border-primaryStroke bg-background px-[0.5em] py-[0.33em] text-left text-textPrimary transition-colors duration-150 hover:border-secondaryStroke focus-visible:border-primaryBlue focus-visible:outline-none';
const LIST = 'fixed left-0 top-0 z-[70] w-max overflow-y-auto overflow-x-hidden overscroll-contain rounded-card border border-primaryStroke bg-backgroundSecondary py-1';
const OPTION = 'flex cursor-pointer select-none items-center gap-[0.5em] whitespace-nowrap px-[0.5em] py-[0.33em] [@media(pointer:coarse)]:py-[0.75em]';

function place(el: HTMLElement, anchor: HTMLElement) {
  const view = anchor.ownerDocument.documentElement;
  const worn = (anchor.ownerDocument.defaultView ?? window).getComputedStyle(anchor);
  const a = anchor.getBoundingClientRect();
  const vw = view.clientWidth;
  const vh = view.clientHeight;
  el.style.fontSize = worn.fontSize;
  el.style.lineHeight = worn.lineHeight;
  el.style.minWidth = `${a.width}px`;
  el.style.maxWidth = `${vw - 2 * EDGE}px`;
  const all = el.scrollHeight + el.offsetHeight - el.clientHeight;
  const wants = Math.min(all, TALLEST);
  const under = vh - EDGE - GAP - a.bottom;
  const over = a.top - GAP - EDGE;
  const below = wants <= under || under >= over;
  const height = Math.max(0, Math.min(wants, below ? under : over));
  el.style.maxHeight = `${height}px`;
  el.style.overflowY = all - height > 1 ? 'scroll' : '';
  el.style.left = `${Math.max(EDGE, Math.min(a.left, vw - el.offsetWidth - EDGE))}px`;
  el.style.top = `${below ? a.bottom + GAP : a.top - GAP - height}px`;
}

export function Select<T extends string>({ id, label, value, options, onChange, placeholder, disabled = false, className }: SelectProps<T>) {
  const box = useRef<HTMLDivElement | null>(null);
  const list = useRef<HTMLUListElement | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const typed = useRef({ word: '', at: 0 });
  const follow = useRef(false);
  const pointer = useRef<{ x: number; y: number } | null>(null);

  const chosen = options.findIndex((option) => option.value === value);
  const usable = options.flatMap((option, i) => (option.disabled ? [] : [i]));
  const shown = open && !disabled && usable.length > 0;
  const here = Math.max(0, usable.indexOf(shown ? active : chosen));

  function show(at = usable.includes(chosen) ? chosen : (usable[0] ?? -1)) {
    const el = box.current;
    if (!el || disabled || usable.length === 0) return;
    setHost(el.closest<HTMLElement>('dialog:modal') ?? el.ownerDocument.body);
    follow.current = true;
    pointer.current = null;
    setActive(at);
    setOpen(true);
  }

  function pick(at: number) {
    const option = options[at];
    setOpen(false);
    if (option && !option.disabled && option.value !== value) onChange(option.value);
  }

  function walk(to: number) {
    follow.current = true;
    setActive(usable[Math.max(0, Math.min(to, usable.length - 1))] ?? -1);
  }

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
      e.stopPropagation();
      setOpen(false);
    } else return;
    e.preventDefault();
  }

  useLayoutEffect(() => {
    if (shown && list.current && box.current) place(list.current, box.current);
  });

  useLayoutEffect(() => {
    const el = list.current;
    const row = el?.children[active] as HTMLElement | undefined;
    if (!shown || !follow.current || !el || !row) return;
    const top = row.previousElementSibling ? row.offsetTop : 0;
    const bottom = row.nextElementSibling ? row.offsetTop + row.offsetHeight : el.scrollHeight;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
  }, [shown, active]);

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
        <span className={cn('min-w-0 flex-1 truncate', chosen < 0 && 'text-textTertiary')}>{options[chosen]?.label ?? placeholder ?? '\u00a0'}</span>
        <RiExpandUpDownLine aria-hidden size="1.15em" className="shrink-0 text-textTertiary" />
      </div>
      {shown &&
        host &&
        createPortal(
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
