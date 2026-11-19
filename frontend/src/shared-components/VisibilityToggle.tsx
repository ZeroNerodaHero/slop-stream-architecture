import { RiLockLine, RiLockUnlockLine } from '@remixicon/react';

import { cn } from '@/utils/cn';

interface VisibilityToggleProps {
  isPublic: boolean;
  onChange: (isPublic: boolean) => void;
  /** The ids the tests key on: the public one (sr-only, kept for its `aria-pressed`), then the switch, which is on for private. */
  ids: [string, string];
  className?: string;
  disabled?: boolean;
}

/**
 * Public or private, as an on/off switch: on is private. A 36x20 track with a lock on its knob
 * (open for public, shut for private), tinted blue when private, and the chosen word beside it;
 * the track and the word are one click. The make-a-group dialog, the room's manage dialog
 * (listing) and the user modal's groups tab all use it.
 */
export function VisibilityToggle({ isPublic, onChange, ids, className, disabled }: VisibilityToggleProps) {
  const Icon = isPublic ? RiLockUnlockLine : RiLockLine;
  return (
    <span className={cn('relative inline-flex items-center', className)}>
      {/* the public id from the two-lock days: a reader and the keyboard have the switch, so this one is out of both */}
      <button id={ids[0]} type="button" tabIndex={-1} aria-hidden aria-pressed={isPublic} disabled={disabled} onClick={() => onChange(true)} className="sr-only">
        public
      </button>
      <button
        id={ids[1]}
        type="button"
        role="switch"
        aria-checked={!isPublic}
        aria-label="private"
        disabled={disabled}
        onClick={() => onChange(!isPublic)}
        className="flex items-center gap-2 text-sm text-textSecondary hover:text-textPrimary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primaryBlue disabled:opacity-40 disabled:hover:text-textSecondary"
      >
        <span
          aria-hidden
          className={cn(
            'relative h-5 w-9 shrink-0 border border-primaryStroke transition-colors duration-150',
            isPublic ? 'bg-background' : 'bg-primaryBlue'
          )}
        >
          <span
            className={cn(
              'absolute left-px top-px flex h-4 w-4 items-center justify-center transition-transform duration-150',
              isPublic ? 'bg-textTertiary text-background' : 'translate-x-4 bg-background text-primaryBlue'
            )}
          >
            <Icon size={12} />
          </span>
        </span>
        <span aria-hidden>{isPublic ? 'public' : 'private'}</span>
      </button>
    </span>
  );
}
