import { cn } from '@/utils/cn';

function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function colorOf(name: string): string {
  return `oklch(0.55 0.14 ${hash(name) % 360})`;
}

interface GeneratedAvatarProps {
  name: string;
  className?: string;
}

export function GeneratedAvatar({ name, className }: GeneratedAvatarProps) {
  const key = name.trim().toLowerCase();
  return (
    <span
      aria-hidden
      style={key ? { backgroundColor: colorOf(key) } : undefined}
      className={cn(
        'flex h-10 w-10 shrink-0 select-none items-center justify-center border border-primaryStroke bg-backgroundTertiary text-lg font-semibold uppercase leading-none',
        key ? 'text-white' : 'text-textTertiary',
        className
      )}
    >
      {key ? [...key][0] : '?'}
    </span>
  );
}
