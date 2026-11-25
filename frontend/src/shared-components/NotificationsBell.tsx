import { RiNotification3Line } from '@remixicon/react';
import { useAtomValue } from 'jotai';

import { notificationsOpenAtom, toggleNotifications, unreadNotificationsAtom } from '@/infra/atoms/notification-atoms';
import { buttonClassName } from '@/shared-components/Button';
import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

export const COUNT =
  'absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-control border border-background bg-primaryBlue px-0.5 text-[10px] font-semibold leading-none text-background';

export function NotificationsBell() {
  const open = useAtomValue(notificationsOpenAtom);
  const unread = useAtomValue(unreadNotificationsAtom);
  return (
    <Tooltip content={open ? null : unread > 0 ? `notifications: ${unread} new` : 'notifications'}>
      <button
        id="notifications"
        type="button"
        aria-label={unread > 0 ? `notifications, ${unread} new` : 'notifications'}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? 'notifications-panel' : undefined}
        data-unread={unread || undefined}
        onClick={toggleNotifications}
        className={cn(buttonClassName('secondary', 'relative p-1.5 max-md:h-11 max-md:w-11 max-md:p-0'), open && 'border-primaryBlue text-primaryBlue')}
      >
        <RiNotification3Line aria-hidden size={20} />
        {unread > 0 && (
          <span id="notifications-unread" aria-hidden className={COUNT}>
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
    </Tooltip>
  );
}
