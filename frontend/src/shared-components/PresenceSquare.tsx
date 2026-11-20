import { type Presence, type PresenceChoice, PRESENCE_WORD } from '@/infra/atoms/presence-atoms';
import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

/** What the square shows. The four presence words; `presenceStatus` maps a choice onto them. */
export type PresenceStatus = Presence;

/** A choice as others see it: `invisible` is `offline` to everyone but its chooser. */
export function presenceStatus(value: Presence | PresenceChoice): PresenceStatus {
  return value === 'invisible' ? 'offline' : value;
}

/**
 * The square's colour (docs/status.md): streaming cut corner to corner, online's green on the top
 * left and the accent (the blue every live mark is) on the bottom right, a hard stop so the cut is
 * crisp; green online, orange do not disturb with the bar discord's has drawn in the panel's
 * background, grey offline.
 */
const COLOUR: Record<PresenceStatus, string> = {
  streaming: 'bg-[linear-gradient(to_bottom_right,rgb(var(--increase))_50%,rgb(var(--primary-color))_50%)]',
  online: 'bg-increase',
  dnd: "bg-caution before:absolute before:inset-x-[2px] before:top-1/2 before:h-px before:-translate-y-1/2 before:bg-backgroundSecondary before:content-['']",
  offline: 'bg-textTertiary'
};

/**
 * `corner`: 12px on a face's bottom right corner, ringed in the background the face sits on (the
 * face's wrapper is `relative`; `className` names the ring, `border-background` or
 * `border-backgroundSecondary`). `word`: 10px, inline before a written word. `chip`: 8px, inline in
 * a dark chip over a picture.
 */
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
  /**
   * The square says its word itself (an image named `online`, with the word's tooltip), where
   * nothing beside it writes it out (the watch page's title row). Otherwise it is `aria-hidden`
   * and the word is somewhere near: a label, an sr-only span, the text beside it.
   */
  labelled?: boolean;
}

/**
 * Every presence indicator on the site (.cursor/rules/presence.mdc). One square per state, no icon:
 * only the colour says which, so nothing beside it moves when the word changes. Streaming is the
 * square cut on its diagonal, green over blue; nothing in it moves.
 */
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
