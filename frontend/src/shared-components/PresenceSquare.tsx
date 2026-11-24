import { type Presence, type PresenceChoice, PRESENCE_WORD } from '@/infra/atoms/presence-atoms';
import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

export type PresenceStatus = Presence;

export function presenceStatus(value: Presence | PresenceChoice): PresenceStatus {
  return value === 'invisible' ? 'offline' : value;
}

const COLOUR: Record<PresenceStatus, string> = {
  streaming: 'bg-[linear-gradient(to_bottom_right,rgb(var(--increase))_50%,rgb(var(--primary-color))_50%)]',
  online: 'bg-increase',
  dnd: "bg-caution before:absolute before:inset-x-[2px] before:top-1/2 before:h-px before:-translate-y-1/2 before:bg-backgroundSecondary before:content-['']",
  offline: 'bg-textTertiary'
};

const SIZE = {
  corner: 'absolute -bottom-1 -right-1 h-3 w-3 border-2',
  word: 'relative h-2.5 w-2.5 shrink-0',
  chip: 'relative h-2 w-2 shrink-0'
} as const;

export type PresenceSquareSize = keyof typeof SIZE;

interface PresenceSquareProps {
  status: PresenceStatus;
  size?: PresenceSquareSize;
  className?: string;
  id?: string;
  labelled?: boolean;
}

export function PresenceSquare({ status, size = 'corner', className, id, labelled = false }: PresenceSquareProps) {
  const square = (
    <span
      id={id}
      data-presence={status}
      {...(labelled ? { role: 'img', 'aria-label': PRESENCE_WORD[status] } : { 'aria-hidden': true })}
      className={cn('block', SIZE[size], COLOUR[status], className)}
    />
  );
  if (!labelled) return square;
  return <Tooltip content={PRESENCE_WORD[status]}>{square}</Tooltip>;
}
