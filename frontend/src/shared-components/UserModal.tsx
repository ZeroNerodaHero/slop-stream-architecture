import {
  RiChat1Line,
  RiCloseLine,
  RiGroupLine,
  RiNotification3Line,
  RiPaletteLine,
  RiShieldKeyholeLine,
  RiSideBarLine,
  RiToolsLine,
  RiUserLine
} from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { Fragment, type KeyboardEvent, type ReactNode, useLayoutEffect, useRef } from 'react';

import { meAtom } from '@/infra/atoms/auth-atoms';
import { myPresenceAtom, PRESENCE_SQUARE, PRESENCE_WORD } from '@/infra/atoms/presence-atoms';
import { myAvatarVersionAtom, myNameAtom } from '@/infra/atoms/profile-atoms';
import { USER_TABS, type UserTab, closeUserModal, pickTab, userModalOpenAtom, userTabAtom } from '@/infra/atoms/user-modal-atoms';
import { Face } from '@/shared-components/Face';
import { AdvancedTab } from '@/shared-components/user-modal/AdvancedTab';
import { AppearanceTab } from '@/shared-components/user-modal/AppearanceTab';
import { ChatTab } from '@/shared-components/user-modal/ChatTab';
import { GroupsTab } from '@/shared-components/user-modal/GroupsTab';
import { NotificationsTab } from '@/shared-components/user-modal/NotificationsTab';
import { ProfileTab } from '@/shared-components/user-modal/ProfileTab';
import { SecurityTab } from '@/shared-components/user-modal/SecurityTab';
import { SidebarTab } from '@/shared-components/user-modal/SidebarTab';
import { cn } from '@/utils/cn';

const TABS: Record<UserTab, { label: string; group: string; icon: ReactNode }> = {
  profile: { label: 'profile', group: 'you', icon: <RiUserLine aria-hidden size={18} /> },
  groups: { label: 'groups', group: 'you', icon: <RiGroupLine aria-hidden size={18} /> },
  security: { label: 'security', group: 'you', icon: <RiShieldKeyholeLine aria-hidden size={18} /> },
  notifications: { label: 'notifications', group: 'you', icon: <RiNotification3Line aria-hidden size={18} /> },
  appearance: { label: 'appearance', group: 'this browser', icon: <RiPaletteLine aria-hidden size={18} /> },
  chat: { label: 'chat', group: 'this browser', icon: <RiChat1Line aria-hidden size={18} /> },
  sidebar: { label: 'sidebar', group: 'this browser', icon: <RiSideBarLine aria-hidden size={18} /> },
  advanced: { label: 'advanced', group: 'this browser', icon: <RiToolsLine aria-hidden size={18} /> }
};

const GROUP_LABEL = 'hidden px-3 pb-1 pt-4 text-xs font-semibold uppercase tracking-wider text-textTertiary first:pt-0 sm:block';
const TAB = cn(
  'flex shrink-0 items-center gap-2.5 whitespace-nowrap px-3 py-2 text-left font-semibold leading-tight transition-colors duration-150',
  // the mark: under the tab in the phone strip, at its left in the rail
  'border-b-2 sm:w-full sm:border-b-0 sm:border-l-2',
  // keyboard focus: a 1px square inside the edge (no radius in this theme, no ring)
  'focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-primaryBlue'
);
const TAB_ON = 'border-primaryBlue bg-backgroundTertiary text-textPrimary';
const TAB_OFF = 'border-transparent text-textSecondary hover:bg-backgroundTertiary/60 hover:text-textPrimary';

const STEP: Record<string, number | undefined> = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };

/** Arrows walk the tabs and show the one under focus; home and end jump. The buttons carry tabIndex 0/-1 themselves. */
function roveTabs(e: KeyboardEvent<HTMLDivElement>) {
  const tabs = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  const i = tabs.indexOf(e.target as HTMLButtonElement);
  if (i < 0) return;
  const step = STEP[e.key];
  const next = step !== undefined ? (i + step + tabs.length) % tabs.length : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -1;
  const target = USER_TABS[next]; // rendered from USER_TABS, so dom order and this order agree
  const button = tabs[next];
  if (next < 0 || !target || !button) return;
  e.preventDefault();
  pickTab(target);
  button.focus(); // works on tabIndex -1; the attribute flips on the next render
}

/**
 * The user modal: who you are and how this browser shows things, the way discord does its
 * settings. A rail of tabs down the left (the account: profile, groups, security,
 * notifications; this browser: appearance, chat, sidebar, advanced), the open one's pane on
 * the right. Mounted by the Shell; it renders nothing until `openUserModal`, and the page
 * behind follows every change at once, so the layout and theme cards are their own preview.
 * A native <dialog>: the browser keeps focus in it, closes it on escape and hands focus back
 * to what opened it; a click on the backdrop closes it too.
 */
export function UserModal() {
  const open = useAtomValue(userModalOpenAtom);
  return open ? <UserDialog /> : null;
}

/** Mounted = shown. The one effect is mount-only: open the dialog, and close it on the way out. */
function UserDialog() {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  /** The press that began this click was on the backdrop too: a text drag that ends outside is not a close. */
  const pressedBackdrop = useRef(false);
  const tab = useAtomValue(userTabAtom);

  // A layout effect: its cleanup runs while the node is still in the document, which is when
  // close() hands focus back to the opener. (A passive cleanup would run after the removal.)
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    dialog.showModal();
    // the tab that is open, not the first focusable: the gear lands you on appearance
    dialog.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  // every way out goes through the element: close() restores focus, then fires `close`
  const close = () => dialogRef.current?.close();

  return (
    <dialog
      ref={dialogRef}
      id="user-modal"
      aria-labelledby={`panel-${tab}-title`}
      onPointerDown={(e) => {
        pressedBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (pressedBackdrop.current && e.target === e.currentTarget) close();
      }}
      onClose={(event) => {
        // a question asked from inside here (delete a group) closes itself. that close walks the
        // react tree and would shut this too.
        if (event.target !== event.currentTarget) return;
        closeUserModal();
      }}
      className={cn(
        // the dialog box is the panel: a click whose target is the dialog element landed on the backdrop
        'overflow-hidden bg-backgroundSecondary p-0 text-base text-textPrimary',
        'open:flex flex-col sm:flex-row',
        // full bleed on a phone: the browser's margins and size caps of a modal dialog go
        'm-0 h-dvh max-h-none w-full max-w-none border-0',
        'sm:m-auto sm:h-[min(680px,calc(100dvh-3rem))] sm:w-[min(960px,calc(100vw-3rem))] sm:border sm:border-primaryStroke',
        'backdrop:bg-black/60 sm:backdrop:backdrop-blur-sm'
      )}
    >
      <Rail tab={tab} />
      <Pane tab={tab} onClose={close} />
    </dialog>
  );
}

function Rail({ tab }: { tab: UserTab }) {
  const me = useAtomValue(meAtom);
  const name = useAtomValue(myNameAtom);
  const avatar = useAtomValue(myAvatarVersionAtom);
  const presence = useAtomValue(myPresenceAtom);
  return (
    <div className="flex shrink-0 flex-col border-b border-primaryStroke bg-background sm:w-56 sm:border-b-0 sm:border-r">
      {/* the corner panel again, at the head of the rail: who this is about (the phone strip has no room for it) */}
      <div className="hidden items-center gap-3 border-b border-primaryStroke px-3 py-3 sm:flex">
        <span className="relative block shrink-0" title={name ? PRESENCE_WORD[presence] : undefined}>
          <Face name={name} version={avatar} className="h-9 w-9 text-base" />
          {/* the presence square in the picture's corner, the corner panel's way (docs/status.md): blue streaming,
              green online, red do not disturb, grey offline. the word is in the title; the ✓ keeps meaning login */}
          {name && (
            <span
              id="modal-presence"
              aria-hidden
              data-presence={presence}
              className={cn('absolute -bottom-1 -right-1 h-3.5 w-3.5 border-2 border-background', PRESENCE_SQUARE[presence])}
            />
          )}
        </span>
        <span className="min-w-0">
          <span className="block truncate font-semibold leading-tight">{name || 'nobody yet'}</span>
          <span className={cn('block text-xs', me ? 'text-increase' : 'text-textTertiary')}>{me ? 'logged in ✓' : 'not logged in'}</span>
        </span>
      </div>

      <div
        id="user-tabs"
        role="tablist"
        aria-orientation="vertical"
        aria-label="sections"
        onKeyDown={roveTabs}
        className="flex flex-row gap-1 overflow-x-auto p-2 sm:flex-col sm:gap-0 sm:overflow-visible"
      >
        {USER_TABS.map((t, i) => {
          const { label, group, icon } = TABS[t];
          const on = t === tab;
          const before = USER_TABS[i - 1];
          const newGroup = before === undefined || TABS[before].group !== group;
          return (
            <Fragment key={t}>
              {/* a tablist may hold only tabs, so the group words are decoration; the tab names carry the meaning */}
              {newGroup && (
                <span aria-hidden className={GROUP_LABEL}>
                  {group}
                </span>
              )}
              <button
                id={`tab-${t}`}
                type="button"
                role="tab"
                aria-selected={on}
                aria-controls={on ? `panel-${t}` : undefined}
                tabIndex={on ? 0 : -1}
                onClick={() => pickTab(t)}
                className={cn(TAB, on ? TAB_ON : TAB_OFF)}
              >
                {icon}
                {label}
              </button>
            </Fragment>
          );
        })}
      </div>

      <p className="mt-auto hidden px-3 py-3 text-xs leading-5 text-textTertiary sm:block">
        profile, groups, security and notifications are the account.
        <br />
        appearance, chat, sidebar and advanced are this browser.
        <br />
        <span className="select-all tabular-nums" title={`build ${__BUILD__}`}>
          build {__BUILD__.slice(0, 7)}
        </span>
      </p>
    </div>
  );
}

function Pane({ tab, onClose }: { tab: UserTab; onClose: () => void }) {
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      {/* pinned over the pane, discord's esc: the pane scrolls under it */}
      <div className="absolute right-4 top-4 z-10 flex flex-col items-center gap-1">
        <button
          id="user-modal-close"
          type="button"
          aria-label="close"
          aria-keyshortcuts="Escape"
          onClick={onClose}
          className="flex h-8 w-8 items-center justify-center border border-primaryStroke bg-backgroundSecondary text-textSecondary transition-colors duration-150 hover:border-primaryBlue hover:text-primaryBlue focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-primaryBlue"
        >
          <RiCloseLine aria-hidden size={20} />
        </button>
        <span aria-hidden className="hidden text-[10px] font-semibold uppercase tracking-wider text-textTertiary sm:block">
          esc
        </span>
      </div>

      {/* keyed on the tab: a fresh pane starts at the top with its own form state */}
      <div
        key={tab}
        id={`panel-${tab}`}
        role="tabpanel"
        aria-labelledby={`tab-${tab}`}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5 [scrollbar-gutter:stable] sm:px-8 sm:py-6"
      >
        <div className="max-w-[640px]">
          <h2 id={`panel-${tab}-title`} className="mb-6 border-l-4 border-primaryBlue pl-3 pr-12 text-xl font-semibold leading-tight">
            {TABS[tab].label}
          </h2>
          {tab === 'profile' && <ProfileTab />}
          {tab === 'groups' && <GroupsTab />}
          {tab === 'security' && <SecurityTab />}
          {tab === 'notifications' && <NotificationsTab />}
          {tab === 'appearance' && <AppearanceTab />}
          {tab === 'chat' && <ChatTab />}
          {tab === 'sidebar' && <SidebarTab />}
          {tab === 'advanced' && <AdvancedTab />}
        </div>
      </div>
    </div>
  );
}
