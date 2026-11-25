import { RiEyeLine, RiEyeOffLine, RiInformationLine } from '@remixicon/react';
import { type ReactNode, useState } from 'react';

import { INPUT } from '@/shared-components/input';
import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

export const SECTION_TITLE = 'text-xs font-semibold uppercase tracking-wider text-textTertiary';
export const FIELDSET =
  'relative m-0 border-0 p-0 py-4 first:pt-0 last:pb-0 [&>legend+*]:clear-left [&>legend+*]:!mt-0 [&>legend]:float-left [&>legend]:w-full [&>legend]:pb-2';
export const BUTTON = 'px-4 py-2 text-base';
export const CHECKBOX =
  'h-4 w-4 shrink-0 appearance-none border border-primaryStroke bg-background checked:border-primaryBlue checked:bg-primaryBlue disabled:opacity-40 soft:rounded-[3px] bubble:rounded-[5px]';

export function Section({ id, title, description, children }: { id?: string; title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} className="py-6 first:pt-0 last:pb-0">
      <h3 className={SECTION_TITLE}>{title}</h3>
      {description && <p className="mt-1 text-textSecondary">{description}</p>}
      <div className="mt-3 flex flex-col gap-3">{children}</div>
    </section>
  );
}

export function Info({ tip }: { tip: string }) {
  return (
    <Tooltip content={tip} className="max-w-72 whitespace-normal">
      <span role="img" aria-label={tip} tabIndex={0} className="inline-flex text-textTertiary hover:text-textPrimary focus-visible:text-textPrimary">
        <RiInformationLine aria-hidden size={14} />
      </span>
    </Tooltip>
  );
}

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
  placeholder?: string;
  label?: string;
  describedBy?: string;
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

export function Status({ id, text, quiet }: { id: string; text: string; quiet?: boolean }) {
  const bad = /^not |^wrong|^too /.test(text);
  return (
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
  picture: ReactNode;
  label: string;
  detail?: string;
  compact?: boolean | 'tight';
  stacked?: boolean;
}

export function OptionCard({ id, name, checked, onChange, picture, label, detail, compact, stacked }: OptionCardProps) {
  const radio = <input id={id} type="radio" name={name} checked={checked} onChange={onChange} className="sr-only" />;
  const stroke = cn(checked ? 'border-primaryBlue' : 'border-primaryStroke hover:border-secondaryStroke', 'has-[:focus-visible]:border-primaryBlue');
  if (stacked)
    return (
      <label
        htmlFor={id}
        className={cn(
          'relative flex min-h-11 min-w-0 cursor-pointer flex-col items-center justify-center gap-2 rounded-card border bg-background px-2 py-3 text-center transition-[border-color,color] duration-150',
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
        'relative flex min-w-0 cursor-pointer flex-col gap-3 rounded-card border bg-background p-4 transition-[border-color,color] duration-150',
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
