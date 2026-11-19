import { useAtomValue } from 'jotai';

import type { GroupBadge } from '@/infra/api';
import { groupIconsAtom } from '@/infra/atoms/groups-atoms';
import { fromHex, isDark } from '@/infra/theme';
import { cn } from '@/utils/cn';
import { GroupMark } from '@/shared-components/GroupMark';

interface BadgeProps {
  group: GroupBadge;
  /** A picture not up yet (the create dialog's preview), shown instead of the group's. */
  src?: string | null;
  className?: string;
}

/**
 * A group's badge, the way discord tags a bot: the group's picture, tiny and square, then a
 * small solid box in the group's colour with the word in capitals, next to a name. One unit,
 * the height of the word's line (16px), so nothing it sits in grows. The picture's version is
 * the freshest the page has heard (`groupIconsAtom`), else the one the line carried; no
 * picture is its first letter on its colour, as `GroupMark` draws everywhere. The word is
 * white or black by the colour's own lightness, not the theme's, so it reads on any theme and
 * with any colour a group picked.
 */
export function Badge({ group, src, className }: BadgeProps) {
  const icons = useAtomValue(groupIconsAtom);
  const icon = icons.has(group.name) ? icons.get(group.name) : group.icon;
  const dark = isDark(fromHex(group.color));
  return (
    <span data-group={group.name} title={`in the group ${group.name}`} className={cn('inline-flex items-center align-middle', className)}>
      <GroupMark name={group.name} color={group.color} icon={icon} src={src} className="h-4 w-4 text-[10px] leading-none" />
      <span
        style={{ backgroundColor: group.color, color: dark ? '#fff' : '#000' }}
        className="whitespace-nowrap px-1 text-xs font-semibold uppercase leading-4 tracking-wider"
      >
        {group.badge}
      </span>
    </span>
  );
}
