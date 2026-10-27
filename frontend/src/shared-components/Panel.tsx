import { cn } from '@/utils/cn';

/**
 * The one look every box has: a 1px stroke on the secondary background, no shadow (the home
 * page's stream cards and the corner player have the same). The chat, the bio section, the
 * friend chat window. `interactive` turns the stroke blue on hover and keyboard focus for a
 * box that is a link.
 */
export function panelClassName(className?: string, interactive = false): string {
  return cn(
    'border border-primaryStroke bg-backgroundSecondary',
    interactive && 'transition-[border-color] duration-150 hover:border-primaryBlue focus-within:border-primaryBlue',
    className
  );
}
