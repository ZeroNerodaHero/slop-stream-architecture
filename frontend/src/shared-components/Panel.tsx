import { cn } from '@/utils/cn';

/**
 * The one look every box has: a 1px stroke, the secondary background, a hard offset shadow.
 * The chat, the bio section, the admin lists (the home page's stream cards and the corner
 * player take the stroke and background without the shadow). `interactive` adds the blue
 * stroke and shadow on hover and keyboard focus for a box that is a link.
 */
export function panelClassName(className?: string, interactive = false): string {
  return cn(
    'border border-primaryStroke bg-backgroundSecondary shadow-hard',
    interactive &&
      'transition-[border-color,box-shadow] duration-150 hover:border-primaryBlue hover:shadow-hard-blue focus-within:border-primaryBlue focus-within:shadow-hard-blue',
    className
  );
}
