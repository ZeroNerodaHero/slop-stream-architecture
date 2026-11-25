import { type KeyboardEvent, useRef } from 'react';

import { cn } from '@/utils/cn';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

const KEYS: Record<string, (i: number, n: number) => number> = {
  ArrowLeft: (i, n) => (i - 1 + n) % n,
  ArrowUp: (i, n) => (i - 1 + n) % n,
  ArrowRight: (i, n) => (i + 1) % n,
  ArrowDown: (i, n) => (i + 1) % n,
  Home: () => 0,
  End: (_, n) => n - 1
};

export function Segmented<T extends string>({
  id,
  label,
  options,
  value,
  onChange,
  className
}: {
  id: string;
  label: string;
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const index = Math.max(
    0,
    options.findIndex((o) => o.value === value)
  );
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const move = KEYS[e.key];
    if (!move) return;
    e.preventDefault();
    const next = move(index, options.length);
    const option = options[next];
    if (!option) return;
    onChange(option.value);
    refs.current[next]?.focus();
  };
  return (
    <div
      id={id}
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cn('relative inline-grid h-7 auto-cols-fr grid-flow-col border border-primaryStroke bg-backgroundSecondary text-xs font-semibold', className)}
    >
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 border border-secondaryStroke bg-backgroundTertiary transition-transform duration-150 ease-out motion-reduce:transition-none"
        style={{ width: `${100 / options.length}%`, transform: `translateX(${index * 100}%)` }}
      />
      {options.map((o, i) => {
        const on = i === index;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            id={`${id}-${o.value}`}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(o.value)}
            className={cn(
              'relative border border-transparent px-2.5 outline-none transition-colors duration-100 focus-visible:border-primaryBlue',
              on ? 'text-textPrimary' : 'text-textSecondary hover:text-textPrimary'
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
