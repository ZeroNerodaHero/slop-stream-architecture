import { cn } from '@/utils/cn';

export type Tone = 'neutral' | 'live' | 'bad';

interface StatusLineProps {
  text: string;
  tone?: Tone;
  id?: string;
  /** `sr-only` keeps the line for screen readers and the tests while the picture says it (the watch page's `watching`). */
  className?: string;
}

/** The one big line that says what is going on. Short words, high contrast, read aloud by screen readers. */
export function StatusLine({ text, tone = 'neutral', id = 'status', className }: StatusLineProps) {
  return (
    <p id={id} aria-live="polite" className={cn('my-3 text-2xl font-semibold', tone === 'live' && 'text-increase', tone === 'bad' && 'text-decrease', className)}>
      {tone === 'live' && <span aria-hidden className="mr-2 inline-block h-3 w-3 bg-increase align-middle" />}
      {text}
    </p>
  );
}
