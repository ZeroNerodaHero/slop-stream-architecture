import { RiUserLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';

import { type GroupBadge, groupImage } from '@/infra/api';
import { BOT_GROUP } from '@/infra/atoms/chat-atoms';
import { groupColorsAtom, groupIconsAtom } from '@/infra/atoms/groups-atoms';
import { fromHex, isDark } from '@/infra/theme';
import { cn } from '@/utils/cn';
import { compactCount } from '@/utils/count';
import { GroupMark } from '@/shared-components/GroupMark';
import { Tooltip } from '@/shared-components/Tooltip';

interface BadgeProps {
  group: GroupBadge;
  src?: string | null;
  card?: boolean;
  preview?: boolean;
  size?: 'sm' | 'md';
  id?: string;
  className?: string;
}

export function Badge({ group: carried, src, card, preview, size = 'sm', id, className }: BadgeProps) {
  const icons = useAtomValue(groupIconsAtom);
  const icon = icons.has(carried.name) ? icons.get(carried.name) : carried.icon;
  const heard = useAtomValue(groupColorsAtom).get(carried.name);
  const group = !preview && heard && heard !== carried.color ? { ...carried, color: heard } : carried;
  const pill = (
    <span
      id={id}
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

function GroupCard({ group, icon }: { group: GroupBadge; icon: number | null | undefined }) {
  const banner = groupImage(group.name, 'banner', group.banner);
  const members = group.name !== BOT_GROUP && typeof group.members === 'number' ? group.members : null;
  return (
    <span id="group-badge-card" data-group={group.name} className="flex flex-col">
      {banner && <img src={banner} alt="" loading="lazy" decoding="async" className="aspect-[16/5] w-full border-b border-primaryStroke object-cover" />}
      <span className="flex flex-col gap-1 p-[3px]">
        <span className="flex items-center gap-1.5">
          <GroupMark name={group.name} color={group.color} icon={icon} className="h-10 w-10 text-base" />
          <span className="flex min-w-0 flex-1 flex-col items-start gap-1">
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
