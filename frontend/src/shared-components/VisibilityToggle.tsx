import { RiLockLine, RiLockUnlockLine } from '@remixicon/react';

import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

const ICON_BUTTON =
  'flex h-8 w-8 items-center justify-center border border-transparent transition-colors duration-150 hover:border-primaryBlue focus-visible:border-primaryBlue focus-visible:outline-none';

interface VisibilityToggleProps {
  isPublic: boolean;
  onChange: (isPublic: boolean) => void;
  /** The ids the tests key on: the public lock, then the private one. */
  ids: [string, string];
  className?: string;
}

/**
 * Public or private, as two lock icons: open for public, shut for private. The chosen one is
 * blue, the other grey; each says its name on hover and focus. The make-a-group dialog and the
 * room's manage dialog (listing) both use it.
 */
export function VisibilityToggle({ isPublic, onChange, ids, className }: VisibilityToggleProps) {
  const options = [
    { value: true, label: 'public', Icon: RiLockUnlockLine, id: ids[0] },
    { value: false, label: 'private', Icon: RiLockLine, id: ids[1] },
  ] as const;
  return (
    <span className={cn('flex items-center gap-1', className)}>
      {options.map(({ value, label, Icon, id }) => {
        const on = value === isPublic;
        return (
          <Tooltip key={label} content={label}>
            <button
              id={id}
              type="button"
              aria-label={label}
              aria-pressed={on}
              onClick={() => onChange(value)}
              className={cn(ICON_BUTTON, on ? 'text-primaryBlue' : 'text-textTertiary hover:text-textPrimary')}
            >
              <Icon aria-hidden size={16} />
            </button>
          </Tooltip>
        );
      })}
    </span>
  );
}
