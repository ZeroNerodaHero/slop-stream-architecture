import { type ReactNode, useState } from 'react';

import { cn } from '@/utils/cn';

/** The small label every block starts with. */
export const SECTION_TITLE = 'text-xs font-semibold uppercase tracking-wider text-textTertiary';
/** A box to type in, on the page colour so it stands off the pane. */
export const INPUT = 'w-full border border-primaryStroke bg-background px-3 py-2 text-base text-textPrimary placeholder:text-textTertiary disabled:opacity-40';
/** The buttons in a pane: a size down from the page's. */
export const BUTTON = 'px-4 py-2 text-base';

/** One block of a pane. The parent is `divide-y divide-primaryStroke`, which draws the rule between blocks. */
export function Section({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="py-6 first:pt-0 last:pb-0">
      <h3 className={SECTION_TITLE}>{title}</h3>
      {description && <p className="mt-1 text-textSecondary">{description}</p>}
      <div className="mt-4 flex flex-col gap-4">{children}</div>
    </section>
  );
}

/** A label over a control, a hint under it. The control carries `id`, and `aria-describedby={`${id}-hint`}` when there is a hint. */
export function Field({ id, label, hint, children }: { id: string; label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-semibold text-textSecondary">
        {label}
      </label>
      {children}
      {hint && (
        <p id={`${id}-hint`} className="text-sm text-textTertiary">
          {hint}
        </p>
      )}
    </div>
  );
}

/** A password box with its show/hide word inside, the way the login page has it. The security tab's and the profile tab's. */
export function PasswordInput({
  id,
  value,
  onChange,
  autoComplete,
  minLength
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete: string;
  minLength?: number;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input
        id={id}
        type={show ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        minLength={minLength}
        maxLength={128}
        required
        className={cn(INPUT, 'pr-16')}
      />
      <button
        id={`${id}-show`}
        type="button"
        onClick={() => setShow((s) => !s)}
        className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-textSecondary underline-offset-2 hover:underline"
      >
        {show ? 'hide' : 'show'}
      </button>
    </div>
  );
}

/** What the last action did, read aloud. Always rendered: a live region announces only text that arrives after it exists. */
export function Status({ id, text }: { id: string; text: string }) {
  const bad = /^not |^wrong|^too /.test(text);
  return (
    <p id={id} aria-live="polite" className={cn('min-h-[1.5em] text-sm', bad ? 'text-decrease' : 'text-textSecondary')}>
      {text}
    </p>
  );
}

interface OptionCardProps {
  id: string;
  name: string;
  checked: boolean;
  onChange: () => void;
  /** What sits at the top of the card: an icon, or a swatch. */
  picture: ReactNode;
  label: string;
  detail: string;
}

/** A radio as a card: the chosen one has the blue stroke (no shadow) and says so in words too. */
export function OptionCard({ id, name, checked, onChange, picture, label, detail }: OptionCardProps) {
  return (
    <label
      htmlFor={id}
      className={cn(
        'flex cursor-pointer flex-col gap-3 border bg-background p-4 transition-[border-color,color] duration-150',
        checked ? 'border-primaryBlue' : 'border-primaryStroke hover:border-secondaryStroke',
        'has-[:focus-visible]:border-primaryBlue'
      )}
    >
      <input id={id} type="radio" name={name} checked={checked} onChange={onChange} className="sr-only" />
      <span className={cn('flex items-start justify-between gap-3', checked ? 'text-primaryBlue' : 'text-textSecondary')}>
        {picture}
        <span className={cn('text-xs font-semibold uppercase tracking-wider', checked ? 'text-primaryBlue' : 'text-transparent')} aria-hidden={!checked}>
          on
        </span>
      </span>
      <span className="flex flex-col gap-0.5">
        <span className="font-semibold leading-tight text-textPrimary">{label}</span>
        <span className="text-sm text-textSecondary">{detail}</span>
      </span>
    </label>
  );
}
