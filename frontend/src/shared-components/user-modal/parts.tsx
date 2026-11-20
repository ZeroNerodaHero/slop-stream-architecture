import { RiEyeLine, RiEyeOffLine, RiInformationLine } from '@remixicon/react';
import { type ReactNode, useState } from 'react';

import { INPUT } from '@/shared-components/input';
import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

/** The small label every block starts with. */
export const SECTION_TITLE = 'text-xs font-semibold uppercase tracking-wider text-textTertiary';
/**
 * A block of a tab that is one set of choices: a fieldset, its legend the small title. The legend
 * floats, so it no longer sits on the rule `divide-y` draws above the block and cut a gap in it.
 */
export const FIELDSET =
  'relative m-0 border-0 p-0 py-4 first:pt-0 last:pb-0 [&>legend+*]:clear-left [&>legend+*]:!mt-0 [&>legend]:float-left [&>legend]:w-full [&>legend]:pb-2';
/** The buttons in a pane: a size down from the page's. */
export const BUTTON = 'px-4 py-2 text-base';
/** A square to tick: the theme's box, blue when on. */
export const CHECKBOX =
  'h-4 w-4 shrink-0 appearance-none border border-primaryStroke bg-background checked:border-primaryBlue checked:bg-primaryBlue disabled:opacity-40';

/** One block of a pane. The parent is `divide-y divide-primaryStroke`, which draws the rule between blocks. */
export function Section({ id, title, description, children }: { id?: string; title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} className="py-6 first:pt-0 last:pb-0">
      <h3 className={SECTION_TITLE}>{title}</h3>
      {description && <p className="mt-1 text-textSecondary">{description}</p>}
      <div className="mt-3 flex flex-col gap-3">{children}</div>
    </section>
  );
}

/** An ⓘ that says the rest of what a title means, on hover and focus. */
export function Info({ tip }: { tip: string }) {
  return (
    <Tooltip content={tip} className="max-w-72 whitespace-normal">
      <span role="img" aria-label={tip} tabIndex={0} className="inline-flex text-textTertiary hover:text-textPrimary focus-visible:text-textPrimary">
        <RiInformationLine aria-hidden size={14} />
      </span>
    </Tooltip>
  );
}

/** One block of a settings tab: the small title, an ⓘ for the rest, the controls. The parent is `divide-y divide-primaryStroke`. */
export function Block({ id, title, tip, children }: { id?: string; title: string; tip?: string; children: ReactNode }) {
  return (
    <section id={id} className="py-4 first:pt-0 last:pb-0">
      <div className="mb-2 flex items-center gap-1.5">
        <h3 className={SECTION_TITLE}>{title}</h3>
        {tip && <Info tip={tip} />}
      </div>
      {children}
    </section>
  );
}

/** A label over a control, a hint under it. The control carries `id`, and `aria-describedby={`${id}-hint`}` when there is a hint. */
export function Field({ id, label, hint, children }: { id: string; label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
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

/** A password box with an eye inside to show or hide it. The security tab's and the profile tab's. */
export function PasswordInput({
  id,
  value,
  onChange,
  autoComplete,
  minLength,
  placeholder,
  label,
  describedBy,
  className
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete: string;
  minLength?: number;
  /** One word in the box (placeholders.mdc). */
  placeholder?: string;
  /** Its name for a screen reader, where no `<label>` points at it. */
  label?: string;
  describedBy?: string;
  /** The wrapper's: a width or a flex basis. */
  className?: string;
}) {
  const [show, setShow] = useState(false);
  const word = show ? 'hide' : 'show';
  return (
    <div className={cn('relative', className)}>
      <input
        id={id}
        type={show ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        minLength={minLength}
        maxLength={128}
        required
        placeholder={placeholder}
        aria-label={label}
        aria-describedby={describedBy}
        className={cn(INPUT, 'h-full pr-9')}
      />
      <Tooltip content={word}>
        <button
          id={`${id}-show`}
          type="button"
          aria-label={word}
          aria-pressed={show}
          onClick={() => setShow((s) => !s)}
          className="absolute right-2 top-1/2 flex -translate-y-1/2 text-textTertiary hover:text-textPrimary focus-visible:text-textPrimary"
        >
          {show ? <RiEyeOffLine aria-hidden size={16} /> : <RiEyeLine aria-hidden size={16} />}
        </button>
      </Tooltip>
    </div>
  );
}

/** What the last action did, read aloud. Always rendered: a live region announces only text that arrives after it exists. */
export function Status({ id, text, quiet }: { id: string; text: string; quiet?: boolean }) {
  const bad = /^not |^wrong|^too /.test(text);
  return (
    // quiet: no room kept while it says nothing, for a line under a row that is usually empty
    <p id={id} aria-live="polite" className={cn('text-sm', !quiet && 'min-h-[1.5em]', quiet && text && 'mt-1', bad ? 'text-decrease' : 'text-textSecondary')}>
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
  /** A line under the label. The settings tabs have none; the socials editor's cards do. */
  detail?: string;
  /**
   * On a phone, a small card, so a row of them fits across: tighter padding, `text-xs` label, a
   * 20px icon, and no ON word: the picked card's label turns blue instead. `tight` is a notch
   * smaller again, for the five size cards at 360px.
   */
  compact?: boolean | 'tight';
  /** The picture centred over the label, as tall as they are: the presence cards. */
  stacked?: boolean;
}

/**
 * A radio as a card: the chosen one has the blue stroke (no shadow) and says so in words too.
 * `relative`, so the sr-only radio (position absolute) is placed inside the card. Without it the
 * input's containing block is the pane wrapper outside the scrolling tabpanel: a card low in the
 * pane puts its 1px input past the dialog's bottom edge, and the click that focuses it scrolls
 * the overflow-hidden dialog down to it, taking the rail and the pane out of view.
 */
export function OptionCard({ id, name, checked, onChange, picture, label, detail, compact, stacked }: OptionCardProps) {
  const radio = <input id={id} type="radio" name={name} checked={checked} onChange={onChange} className="sr-only" />;
  const stroke = cn(checked ? 'border-primaryBlue' : 'border-primaryStroke hover:border-secondaryStroke', 'has-[:focus-visible]:border-primaryBlue');
  if (stacked)
    return (
      <label
        htmlFor={id}
        className={cn(
          'relative flex min-h-11 min-w-0 cursor-pointer flex-col items-center justify-center gap-2 border bg-background px-2 py-3 text-center transition-[border-color,color] duration-150',
          '[&_svg]:h-7 [&_svg]:w-7 max-md:gap-1.5 max-md:[&_svg]:h-6 max-md:[&_svg]:w-6',
          checked && 'bg-primaryBlue/5',
          stroke
        )}
      >
        {radio}
        {picture}
        <span className={cn('font-semibold leading-tight max-md:text-xs', checked ? 'text-primaryBlue' : 'text-textPrimary')}>{label}</span>
      </label>
    );
  return (
    <label
      htmlFor={id}
      className={cn(
        'relative flex min-w-0 cursor-pointer flex-col gap-3 border bg-background p-4 transition-[border-color,color] duration-150',
        compact && 'max-md:min-h-11 max-md:gap-1.5 max-md:p-1.5 max-md:[&_svg]:h-5 max-md:[&_svg]:w-5',
        compact === 'tight' && 'max-md:p-1',
        stroke
      )}
    >
      {radio}
      <span className={cn('flex items-start justify-between gap-3', checked ? 'text-primaryBlue' : 'text-textSecondary')}>
        {picture}
        <span
          className={cn('shrink-0 text-xs font-semibold uppercase tracking-wider', checked ? 'text-primaryBlue' : 'text-transparent', compact && 'max-md:hidden')}
          aria-hidden={!checked}
        >
          on
        </span>
      </span>
      <span className="flex flex-col gap-0.5">
        <span
          className={cn(
            'font-semibold leading-tight text-textPrimary',
            compact && 'max-md:text-xs',
            compact && checked && 'max-md:text-primaryBlue',
            compact === 'tight' && 'max-md:text-[11px] max-md:tracking-tight'
          )}
        >
          {label}
        </span>
        {detail && <span className="text-sm text-textSecondary">{detail}</span>}
      </span>
    </label>
  );
}
