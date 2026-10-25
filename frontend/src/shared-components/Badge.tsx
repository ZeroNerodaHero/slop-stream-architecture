import type { GroupBadge } from '@/infra/api';
import { fromHex, isDark } from '@/infra/theme';
import { cn } from '@/utils/cn';

interface BadgeProps {
  group: GroupBadge;
  className?: string;
}

/**
 * A group's badge, the way discord tags a bot: a small solid box in the group's colour with
 * the word in capitals, next to a name. The text is white or black by the colour's own
 * lightness, not the theme's, so it reads on any theme and with any colour a group picked.
 */
export function Badge({ group, className }: BadgeProps) {
  const dark = isDark(fromHex(group.color));
  return (
    <span
      data-group={group.name}
      title={`in the group ${group.name}`}
      style={{ backgroundColor: group.color, color: dark ? '#fff' : '#000' }}
      className={cn('whitespace-nowrap px-1 text-xs font-semibold uppercase tracking-wider', className)}
    >
      {group.badge}
    </span>
  );
}
