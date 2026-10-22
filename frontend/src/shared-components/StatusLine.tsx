import { cn } from '@/utils/cn';

export type Tone = 'neutral' | 'live' | 'bad';

interface StatusLineProps {
  text: string;
  tone?: Tone;
  id?: string;
}

/** The one big line that says what is going on. Short words, high contrast, read aloud by screen readers. */
export function StatusLine({ text, tone = 'neutral', id = 'status' }: StatusLineProps) {
  return (
    <p id={id} aria-live="polite" className={cn('my-3 text-2xl font-semibold', tone === 'live' && 'text-increase', tone === 'bad' && 'text-decrease')}>
      {tone === 'live' && <span aria-hidden className="mr-2 inline-block h-3 w-3 bg-increase align-middle" />}
      {text}
    </p>
  );
}
