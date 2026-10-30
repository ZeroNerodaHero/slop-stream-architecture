import { RiBroadcastLine, RiChat3Line, RiHashtag, RiUserFollowLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { type ReactNode, useEffect } from 'react';

import { meAtom } from '@/infra/atoms/auth-atoms';
import { clearNotifySettingsNote, KEEP, loadNotifications, notifySettingsAtom, notifySettingsLoadedAtom, notifySettingsNoteAtom, setNotifySetting } from '@/infra/atoms/notification-atoms';
import { pickTab } from '@/infra/atoms/user-modal-atoms';
import type { NotificationKind } from '@/infra/frames';
import { SECTION_TITLE, Status } from '@/shared-components/user-modal/parts';
import { cn } from '@/utils/cn';

/** The four kinds, as switches. The words say what a row of that kind reads. */
const KINDS: readonly { kind: NotificationKind; label: string; detail: string; icon: ReactNode }[] = [
  {
    kind: 'live',
    label: 'someone you follow goes live',
    detail: 'their name and a way to watch, the moment the video is up. once per stream',
    icon: <RiBroadcastLine aria-hidden size={24} />
  },
  {
    kind: 'follow',
    label: 'someone follows you',
    detail: 'who it was, with their page a click away. once per person',
    icon: <RiUserFollowLine aria-hidden size={24} />
  },
  {
    kind: 'dm',
    label: 'a friend messages you',
    detail: 'the newest line from each friend, one row a friend. reading the chat reads it',
    icon: <RiChat3Line aria-hidden size={24} />
  },
  {
    kind: 'chat',
    label: 'someone writes in a group you are in',
    detail: 'the newest line in each channel, one row a channel. opening the channel reads it. a channel too noisy for this is muted on its own page, in the channel list',
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
      <p id="notify-nobody" className="text-textSecondary">
        notifications are for accounts: someone you follow going live, a new follower, a friend&apos;s line, a line in a group you are in, kept for you and pushed to
        every device you are logged in on.{' '}
        <button type="button" onClick={() => pickTab('security')} className="text-primaryBlue underline-offset-2 hover:underline">
          sign up or log in
        </button>
        .
      </p>
    );
  }

  return (
    <div className="divide-y divide-primaryStroke">
      <fieldset className="m-0 border-0 p-0 py-6 first:pt-0 last:pb-0">
        <legend className={SECTION_TITLE}>what is kept</legend>
        <p className="mt-1 text-textSecondary">
          what goes in your inbox, the bell at the top right of every page. each is a switch: off, nothing of that kind is kept from then on.
        </p>
        <ul className="mt-4 flex flex-col gap-3">
          {KINDS.map(({ kind, label, detail, icon }) => {
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
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="font-semibold leading-tight">{label}</span>
                    <span className="text-sm text-textSecondary">{detail}</span>
                  </span>
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
        <p className="mt-4 text-sm text-textTertiary">
          kept with the account, so your phone agrees. the last {KEEP} are kept and older ones go; what is in the inbox already stays when a switch goes off.
        </p>
        <Status id="notify-settings-note" text={note} />
      </fieldset>
    </div>
  );
}
