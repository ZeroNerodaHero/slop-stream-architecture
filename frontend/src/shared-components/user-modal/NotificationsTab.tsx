import { RiBroadcastLine, RiChat3Line, RiHashtag, RiUserFollowLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { type ReactNode, useEffect } from 'react';

import { meAtom } from '@/infra/atoms/auth-atoms';
import {
  clearNotifySettingsNote,
  loadNotifications,
  notifySettingsAtom,
  notifySettingsLoadedAtom,
  notifySettingsNoteAtom,
  setNotifySetting
} from '@/infra/atoms/notification-atoms';
import { pickTab } from '@/infra/atoms/user-modal-atoms';
import type { NotificationKind } from '@/infra/frames';
import { Button } from '@/shared-components/Button';
import { SECTION_TITLE, Status } from '@/shared-components/user-modal/parts';
import { cn } from '@/utils/cn';

/** The four kinds, as switches. */
const KINDS: readonly { kind: NotificationKind; label: string; icon: ReactNode }[] = [
  {
    kind: 'live',
    label: 'someone goes live',
    icon: <RiBroadcastLine aria-hidden size={24} />
  },
  {
    kind: 'follow',
    label: 'new follower',
    icon: <RiUserFollowLine aria-hidden size={24} />
  },
  {
    kind: 'dm',
    label: 'friend messages',
    icon: <RiChat3Line aria-hidden size={24} />
  },
  {
    kind: 'chat',
    label: 'group messages',
    icon: <RiHashtag aria-hidden size={24} />
  }
];

/**
 * Which kinds go in the inbox (docs/notifications.md): four switches, kept with the account
 * through the api, so every device agrees. The bell at the top right of every page is the
 * inbox itself; this tab is only what is put in it. Nobody sees the pointer to an account.
 * A switch stays disabled until this login's settings have been applied, so a click cannot
 * save the default. A channel is muted one at a time on the room page; the switch here is
 * every group's channels at once.
 */
export function NotificationsTab() {
  const me = useAtomValue(meAtom);
  const settings = useAtomValue(notifySettingsAtom);
  const loaded = useAtomValue(notifySettingsLoadedAtom);
  const note = useAtomValue(notifySettingsNoteAtom);

  // the settings as the api has them, for the login this is about; a stale `saved` goes with the tab
  useEffect(() => {
    if (me) void loadNotifications();
    return clearNotifySettingsNote;
  }, [me]);

  if (!me) {
    return (
      <div id="notify-nobody">
        <Button size="sm" variant="outline" onClick={() => pickTab('security')}>
          log in for notifications
        </Button>
      </div>
    );
  }

  return (
    <div className="divide-y divide-primaryStroke">
      <fieldset className="m-0 border-0 p-0 py-6 first:pt-0 last:pb-0">
        <legend className={SECTION_TITLE}>inbox</legend>
        <ul className="mt-2 flex flex-col gap-3">
          {KINDS.map(({ kind, label, icon }) => {
            const on = settings[kind];
            return (
              <li key={kind}>
                <label
                  htmlFor={`notify-${kind}`}
                  className={cn(
                    'flex items-center gap-4 border bg-background p-4 transition-[border-color,color] duration-150',
                    loaded ? 'cursor-pointer' : 'cursor-default',
                    on ? 'border-primaryBlue' : 'border-primaryStroke hover:border-secondaryStroke',
                    'has-[:focus-visible]:border-primaryBlue'
                  )}
                >
                  <span className={cn('shrink-0', on ? 'text-primaryBlue' : 'text-textTertiary')}>{icon}</span>
                  <span className="min-w-0 flex-1 font-semibold leading-tight">{label}</span>
                  <span className={cn('shrink-0 text-xs font-semibold uppercase tracking-wider', on ? 'text-primaryBlue' : 'text-textTertiary')}>
                    {on ? 'on' : 'off'}
                  </span>
                  <input
                    id={`notify-${kind}`}
                    type="checkbox"
                    checked={on}
                    disabled={!loaded}
                    onChange={(e) => void setNotifySetting(kind, e.target.checked)}
                    className="h-4 w-4 shrink-0 appearance-none border border-primaryStroke bg-background checked:border-primaryBlue checked:bg-primaryBlue disabled:opacity-40"
                  />
                </label>
              </li>
            );
          })}
        </ul>
        <Status id="notify-settings-note" text={note} quiet />
      </fieldset>
    </div>
  );
}
