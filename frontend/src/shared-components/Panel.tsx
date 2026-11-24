import { cn } from '@/utils/cn';

export function panelClassName(className?: string, interactive = false): string {
  return cn(
    'border border-primaryStroke bg-backgroundSecondary',
    interactive && 'transition-[border-color] duration-150 hover:border-primaryBlue focus-within:border-primaryBlue',
    className
  );
}
