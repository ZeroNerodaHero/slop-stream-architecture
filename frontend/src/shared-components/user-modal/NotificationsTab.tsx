import { RiAtLine, RiBroadcastLine, RiChat3Line, RiHashtag, RiUserFollowLine } from '@remixicon/react';
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
import { CHECKBOX, FIELDSET, SECTION_TITLE, Status } from '@/shared-components/user-modal/parts';
import { cn } from '@/utils/cn';

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
  },
  {
    kind: 'mention',
    label: 'someone mentions you',
    icon: <RiAtLine aria-hidden size={24} />
  }
];

export function NotificationsTab() {
  const me = useAtomValue(meAtom);
  const settings = useAtomValue(notifySettingsAtom);
  const loaded = useAtomValue(notifySettingsLoadedAtom);
  const note = useAtomValue(notifySettingsNoteAtom);

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
      <fieldset className={FIELDSET}>
        <legend className={SECTION_TITLE}>inbox</legend>
        <ul className="mt-2 flex flex-col gap-3">
          {KINDS.map(({ kind, label, icon }) => {
            const on = settings[kind];
            return (
              <li key={kind}>
                <label
                  htmlFor={`notify-${kind}`}
                  className={cn(
                    'flex items-center gap-4 rounded-card border bg-background p-4 transition-[border-color,color] duration-150',
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
                    className={CHECKBOX}
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
