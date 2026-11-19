import { RiUserLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';

import { type GroupBadge, groupImage } from '@/infra/api';
import { BOT_GROUP } from '@/infra/atoms/chat-atoms';
import { groupIconsAtom } from '@/infra/atoms/groups-atoms';
import { fromHex, isDark } from '@/infra/theme';
import { cn } from '@/utils/cn';
import { compactCount } from '@/utils/count';
import { GroupMark } from '@/shared-components/GroupMark';
import { Tooltip } from '@/shared-components/Tooltip';

interface BadgeProps {
  group: GroupBadge;
  /** A picture not up yet (the create dialog's preview), shown instead of the group's. */
  src?: string | null;
  /** The pointer or the keyboard focus on it shows the group's card (GroupCard): a chat line's badges. Otherwise a plain `title`. */
  card?: boolean;
  /** `md` is 24px tall instead of 16: the create dialog's preview, beside its colour swatches. */
  size?: 'sm' | 'md';
  className?: string;
}

/**
 * A group's badge, the way discord tags a bot: the group's picture, tiny and square, then a
 * small solid box in the group's colour with the word in capitals, next to a name. One unit,
 * the height of the word's line (16px), so nothing it sits in grows. The picture's version is
 * the freshest the page has heard (`groupIconsAtom`), else the one the line carried; no
 * picture is its first letter on its colour, as `GroupMark` draws everywhere. The word is
 * white or black by the colour's own lightness, not the theme's, so it reads on any theme and
 * with any colour a group picked. With `card` it is a tab stop, and hovering or focusing it
 * shows the group's card instead of the browser's title.
 */
export function Badge({ group, src, card, size = 'sm', className }: BadgeProps) {
  const icons = useAtomValue(groupIconsAtom);
  const icon = icons.has(group.name) ? icons.get(group.name) : group.icon;
  const pill = (
    <span
      data-group={group.name}
      title={card ? undefined : `in the group ${group.name}`}
      tabIndex={card ? 0 : undefined}
      aria-label={card ? `group ${group.name}` : undefined}
      className={cn('inline-flex items-center align-middle', card && 'cursor-default', className)}
    >
      <GroupMark name={group.name} color={group.color} icon={icon} src={src} className={size === 'md' ? 'h-6 w-6 text-xs leading-none' : 'h-4 w-4 text-[10px] leading-none'} />
      <Pill group={group} className={size === 'md' ? 'px-1.5 leading-6' : undefined} />
    </span>
  );
  if (!card) return pill;
  return (
    <Tooltip content={<GroupCard group={group} icon={icon} />} className="w-[280px] whitespace-normal p-0 text-sm font-normal">
      {pill}
    </Tooltip>
  );
}

/** The word in the group's colour, white or black by that colour's lightness. */
function Pill({ group, className }: { group: GroupBadge; className?: string }) {
  const dark = isDark(fromHex(group.color));
  return (
    <span
      style={{ backgroundColor: group.color, color: dark ? '#fff' : '#000' }}
      className={cn('whitespace-nowrap px-1 text-xs font-semibold uppercase leading-4 tracking-wider', className)}
    >
      {group.badge}
    </span>
  );
}

/**
 * What a chat line's badge shows on hover and focus, from what the line carried and nothing
 * asked (groups.rs `Badge`): the banner across the top when the group has one (16:5), then its
 * picture beside its full name with the badge under the name, the line about it (three lines
 * at most); how many are in it sits at the right end of the name's row. A line kept before these rode along has the name and the
 * badge alone. Drawn in the Tooltip's box, 280px wide: a stroke, no shadow.
 */
function GroupCard({ group, icon }: { group: GroupBadge; icon: number | null | undefined }) {
  const banner = groupImage(group.name, 'banner', group.banner);
  const members = group.name !== BOT_GROUP && typeof group.members === 'number' ? group.members : null;
  return (
    <span id="group-badge-card" data-group={group.name} className="flex flex-col">
      {banner && <img src={banner} alt="" className="aspect-[16/5] w-full border-b border-primaryStroke object-cover" />}
      <span className="flex flex-col gap-1 p-[3px]">
        <span className="flex items-center gap-1.5">
          <GroupMark name={group.name} color={group.color} icon={icon} className="h-10 w-10 text-base" />
          <span className="flex min-w-0 flex-1 flex-col items-start gap-1">
            {/* the name, cut short when long, with how many are in it at the right end */}
            <span className="flex w-full min-w-0 items-center justify-between gap-2">
              <span className="min-w-0 truncate font-semibold leading-tight text-textPrimary">{group.name}</span>
              {members !== null && (
                <span id="group-badge-members" className="inline-flex shrink-0 items-center gap-1 text-xs tabular-nums text-textTertiary">
                  <RiUserLine aria-hidden size={14} />
                  {compactCount(members)}
                  <span className="sr-only">{members === 1 ? ' member' : ' members'}</span>
                </span>
              )}
            </span>
            <Pill group={group} />
          </span>
        </span>
        {group.about && <span className="line-clamp-3 break-words leading-snug text-textSecondary">{group.about}</span>}
      </span>
    </span>
  );
}
