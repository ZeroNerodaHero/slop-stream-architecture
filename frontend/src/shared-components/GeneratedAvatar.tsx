import { cn } from '@/utils/cn';

/** FNV-1a, 32 bit. It only has to spread names around the hue wheel. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * The colour a name gets. The hue comes from the hash; lightness and chroma are fixed (oklch,
 * so a yellow is as bright as a blue), which keeps every one readable under white text on the
 * dark theme.
 */
export function colorOf(name: string): string {
  return `oklch(0.55 0.14 ${hash(name) % 360})`;
}

interface GeneratedAvatarProps {
  /** Empty is nobody: a grey box with a question mark. */
  name: string;
  className?: string;
}

/**
 * A stand-in picture made from the name alone, the way discord fills in a default avatar: a
 * coloured square with the first letter, the same every time for the same name and a different
 * colour for a different one. Case does not count (the chat treats `Billy` and `billy` as one
 * name), so neither does it here.
 */
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
