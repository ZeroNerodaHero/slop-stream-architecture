import { RiLoginBoxLine, RiLogoutBoxRLine, RiMenuLine, RiNotification3Line, RiSettings3Line, RiUserAddLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { lazy, Suspense, useEffect, useRef } from 'react';
import { Link, useLocation } from 'react-router-dom';

import { loadMe, logout, meAtom, openAuthDialog } from '@/infra/atoms/auth-atoms';
import { nickAtom, setNick } from '@/infra/atoms/chat-atoms';
import { closeAllDms, loadDms } from '@/infra/atoms/dm-atoms';
import { forgetFollowing, friendsOpenAtom, loadFollowing } from '@/infra/atoms/follow-atoms';
import { forgetMyServers, loadGroups, loadMyServers, myGroupsAtom } from '@/infra/atoms/groups-atoms';
import { forgetNotifications, loadNotifications, toggleNotifications, unreadNotificationsAtom } from '@/infra/atoms/notification-atoms';
import { myPresenceAtom, type Presence, PRESENCE_TEXT, PRESENCE_WORD } from '@/infra/atoms/presence-atoms';
import { identityChanged, loadMyProfile, myAvatarVersionAtom, myNameAtom } from '@/infra/atoms/profile-atoms';
import { panelSideAtom } from '@/infra/atoms/settings-atoms';
import { openUserModal } from '@/infra/atoms/user-modal-atoms';
import { useIsMobile } from '@/infra/mobile';
import { isValidName } from '@/infra/names';
import { store } from '@/infra/store';
import { Badge } from '@/shared-components/Badge';
import { Button } from '@/shared-components/Button';
import { Face } from '@/shared-components/Face';
import { FriendsSkeleton, RAIL_FACE } from '@/shared-components/FriendsSkeleton';
import { PresenceSquare } from '@/shared-components/PresenceSquare';
import { Bone, Skeleton } from '@/shared-components/Skeleton';
import { SwipeDrawer } from '@/shared-components/SwipeDrawer';
import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

const COLLAPSED = 'w-14';
const EXPANDED = 'w-[min(300px,calc(100vw-12rem))]';
const COLUMN =
  'sticky top-0 h-screen w-14 shrink-0 self-start bubble:top-2 bubble:mt-2 bubble:h-[calc(100vh-1rem)] bubble:data-[side=left]:ml-2 bubble:data-[side=right]:mr-2';
const panelClass = (side: 'left' | 'right') =>
  cn(
    'absolute top-0 flex h-full flex-col overflow-hidden bg-background text-base bubble:rounded-panel bubble:border-transparent bubble:bg-backgroundSecondary',
    side === 'right' ? 'right-0 border-l border-primaryStroke' : 'left-0 border-r border-primaryStroke'
  );

const LEAVE_GRACE_MS = 100;
const WIDEN = 'transition-[width] duration-100 ease-out motion-reduce:transition-none';

const NAME_LINE = '-mx-1 block border border-transparent px-1 py-0.5 leading-tight';
const ICON_TAP = 'max-md:h-11 max-md:w-11';
const ACTION = cn(
  'relative inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-control border border-primaryStroke bg-backgroundTertiary text-textSecondary transition-colors duration-100',
  'hover:border-secondaryStroke hover:text-textPrimary focus-visible:border-primaryBlue focus-visible:outline-none',
  ICON_TAP
);
const BOX = 'shrink-0 gap-1 px-2 py-0.5 font-normal';
const ICON = 14;
const YOU =
  'relative inline-flex shrink-0 rounded-avatar border border-transparent transition-colors duration-150 hover:border-primaryBlue focus-visible:border-primaryBlue focus-visible:outline-none';
function Dot() {
  return (
    <span aria-hidden className="mx-1.5 text-textTertiary">
      ·
    </span>
  );
}

const Friends = lazy(() => import('@/shared-components/Friends').then((m) => ({ default: m.Friends })));

function SettingsOpener() {
  return (
    <Tooltip content="settings">
      <button
        id="settings"
        type="button"
        aria-label="settings"
        aria-haspopup="dialog"
        onClick={(e) => {
          e.currentTarget.focus();
          store.set(friendsOpenAtom, false);
          openUserModal();
        }}
        className={ACTION}
      >
        <RiSettings3Line aria-hidden size={ICON} />
      </button>
    </Tooltip>
  );
}

function NotificationsOpener() {
  const unread = useAtomValue(unreadNotificationsAtom);
  return (
    <Tooltip content={unread > 0 ? `notifications: ${unread} new` : 'notifications'}>
      <button
        id="drawer-notifications"
        type="button"
        aria-label={unread > 0 ? `notifications, ${unread} new` : 'notifications'}
        aria-haspopup="dialog"
        data-unread={unread || undefined}
        onClick={() => {
          store.set(friendsOpenAtom, false);
          toggleNotifications();
        }}
        className={ACTION}
      >
        <RiNotification3Line aria-hidden size={ICON} />
        {unread > 0 && (
          <span
            aria-hidden
            className="absolute right-1 top-1.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-control bg-primaryBlue px-0.5 text-[9px] font-semibold leading-none text-background"
          >
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
    </Tooltip>
  );
}

function LogoutButton() {
  return (
    <Tooltip content="log out">
      <button id="logout" type="button" aria-label="log out" onClick={() => void logout().then(() => identityChanged('login'))} className={ACTION}>
        <RiLogoutBoxRLine aria-hidden size={ICON} />
      </button>
    </Tooltip>
  );
}

function Status({ presence }: { presence: Presence }) {
  return (
    <span id="my-status" className={PRESENCE_TEXT[presence]}>
      {PRESENCE_WORD[presence]}
    </span>
  );
}

export function DrawerOpener() {
  const open = useAtomValue(friendsOpenAtom);
  return (
    <Tooltip content={open ? null : 'menu'}>
      <button
        id="user-drawer-open"
        type="button"
        aria-label="menu"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="user-drawer"
        onClick={() => store.set(friendsOpenAtom, true)}
        className="-ml-2.5 flex h-11 w-11 shrink-0 items-center justify-center border border-transparent text-textSecondary focus-visible:border-primaryBlue focus-visible:outline-none"
      >
        <RiMenuLine aria-hidden size={22} />
      </button>
    </Tooltip>
  );
}

export function UserPanel() {
  const me = useAtomValue(meAtom);
  const nick = useAtomValue(nickAtom);
  const myName = useAtomValue(myNameAtom);
  const avatar = useAtomValue(myAvatarVersionAtom);
  const presence = useAtomValue(myPresenceAtom);
  const side = useAtomValue(panelSideAtom);
  const myBadge = useAtomValue(myGroupsAtom).find((g) => g.primary) ?? null;
  const mobile = useIsMobile();
  const { pathname } = useLocation();
  const panel = useRef<HTMLElement | null>(null);
  const nickAtFocus = useRef('');
  const friendsOpen = useAtomValue(friendsOpenAtom);
  const leaving = useRef<number | null>(null);
  const hovered = useRef(false);

  useEffect(() => {
    void loadMe().then(loadMyProfile);
  }, []);

  useEffect(() => {
    forgetFollowing();
    forgetMyServers();
    closeAllDms();
    forgetNotifications();
    if (me !== undefined) {
      void loadFollowing();
      void loadGroups();
    }
    if (me) {
      void loadMyServers();
      void loadDms();
      void loadNotifications();
    }
  }, [me]);

  useEffect(() => {
    store.set(friendsOpenAtom, false);
  }, [pathname]);

  useEffect(() => {
    if (friendsOpen) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== panel.current && panel.current?.contains(active)) active.blur();
  }, [friendsOpen]);

  function stayOpen() {
    if (leaving.current !== null) {
      window.clearTimeout(leaving.current);
      leaving.current = null;
    }
    if (!friendsOpen) store.set(friendsOpenAtom, true);
  }
  function leaveSoon() {
    const active = document.activeElement;
    if (active && active !== panel.current && panel.current?.contains(active) && active.matches(':focus-visible')) return;
    if (leaving.current !== null) window.clearTimeout(leaving.current);
    leaving.current = window.setTimeout(() => {
      leaving.current = null;
      store.set(friendsOpenAtom, false);
    }, LEAVE_GRACE_MS);
  }
  function closeFriends() {
    store.set(friendsOpenAtom, false);
  }

  if (me === undefined) {
    if (mobile) return null;
    return (
      <aside aria-label="you" data-side={side} className={COLUMN}>
        <Skeleton label="loading who you are" className={cn(panelClass(side), COLLAPSED)}>
          <div className={cn('flex flex-1 pt-1', side === 'right' ? 'justify-end pr-[calc(0.75rem-1px)]' : 'pl-[calc(0.75rem-1px)]')}>
            <Bone className="h-8 w-[calc(2rem+2px)]" />
          </div>
          <div className={cn('flex shrink-0 border-t border-primaryStroke py-1.5 bubble:border-transparent', side === 'right' ? 'justify-end pr-[calc(0.75rem-1px)]' : 'pl-[calc(0.75rem-1px)]')}>
            <Bone className="h-[calc(2rem+2px)] w-[calc(2rem+2px)]" />
          </div>
        </Skeleton>
      </aside>
    );
  }
  const mirrored = side === 'right' && !mobile;
  const wide = friendsOpen || mobile;
  const myPage = isValidName(myName) ? `/watch/${myName}` : null;
  const youLabel = `you: ${myPage ? 'your page' : 'pick a name'}. ${PRESENCE_WORD[presence]}`;
  const youTitle = `${myPage ? 'your page' : 'pick a name'} · ${PRESENCE_WORD[presence]}`;
  const face = (
    <>
      <Face name={me ?? nick} version={avatar} className={RAIL_FACE} />
      <PresenceSquare id="my-presence" status={presence} className="border-background" />
    </>
  );

  const actions = (
    <span className={cn('flex shrink-0 items-center gap-1', mirrored && 'flex-row-reverse', !wide && 'invisible')}>
      {mobile && <NotificationsOpener />}
      <SettingsOpener />
      {me && <LogoutButton />}
    </span>
  );

  const youRow = (
    <div
      className={cn(
        'flex shrink-0 items-center gap-2 border-primaryStroke',
        mobile ? 'border-b py-2.5' : 'border-t py-1.5 bubble:border-transparent',
        mobile ? 'pl-[calc(1.25rem-1px)] pr-3' : mirrored ? 'flex-row-reverse pl-3 pr-[calc(0.75rem-1px)]' : 'pl-[calc(0.75rem-1px)] pr-3'
      )}
    >
      {myPage ? (
        <Link id="you" to={myPage} aria-label={youLabel} title={youTitle} draggable={false} onClick={closeFriends} className={YOU}>
          {face}
        </Link>
      ) : (
        <button
          id="you"
          type="button"
          aria-label={youLabel}
          aria-haspopup="dialog"
          title={youTitle}
          onClick={(e) => {
            e.currentTarget.focus();
            closeFriends();
            openUserModal('profile');
          }}
          className={YOU}
        >
          {face}
        </button>
      )}

      {me ? (
        <>
          <span className={cn('min-w-0 flex-1 whitespace-nowrap', mirrored && 'text-right', !wide && 'invisible')}>
            <Link
              to={`/watch/${me}`}
              title="your page"
              draggable={false}
              onClick={closeFriends}
              className={cn(
                NAME_LINE,
                'group/name flex w-full items-center gap-1.5 text-left focus-visible:border-primaryBlue focus-visible:outline-none',
                mirrored && 'flex-row-reverse text-right'
              )}
            >
              <span id="me" className="truncate font-semibold group-hover/name:underline">
                {me}
              </span>
              <Tooltip content="logged in: this name is yours">
                <span role="img" aria-label="logged in" className="shrink-0 text-increase">
                  ✓
                </span>
              </Tooltip>
            </Link>
            {(myBadge || mobile) && (
              <span id="you-badge" className={cn('flex items-center text-xs leading-5', mirrored && 'flex-row-reverse')}>
                {myBadge && <Badge group={myBadge} card className="min-w-0" />}
                {myBadge && mobile && <Dot />}
                {mobile && <Status presence={presence} />}
              </span>
            )}
          </span>
          {actions}
        </>
      ) : (
        <>
          <span className={cn('min-w-0 flex-1 whitespace-nowrap', mirrored && 'text-right', !wide && 'invisible')}>
            <label htmlFor="username" className="sr-only">
              your name
            </label>
            <span className="relative -mx-1 block">
              <input
                id="username"
                value={nick}
                onChange={(e) => setNick(e.target.value)}
                onFocus={(e) => {
                  nickAtFocus.current = e.currentTarget.value;
                }}
                onBlur={(e) => {
                  if (e.currentTarget.value !== nickAtFocus.current) identityChanged('nick');
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                }}
                placeholder="name"
                title="your name. click to change it"
                maxLength={24}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                className={cn(
                  NAME_LINE,
                  'mx-0 w-full truncate bg-transparent font-semibold text-textPrimary placeholder:font-normal placeholder:text-textTertiary focus:border-primaryBlue focus:bg-background',
                  mirrored ? 'pl-6 text-right' : 'pr-6'
                )}
              />
              <span aria-hidden className={cn('pointer-events-none absolute top-1/2 -translate-y-1/2 text-sm text-textTertiary', mirrored ? 'left-1.5' : 'right-1.5')}>
                ✎
              </span>
            </span>
            <span className={cn('flex items-center text-sm leading-5 text-textSecondary', mirrored && 'flex-row-reverse')}>
              {mobile && (
                <>
                  <Status presence={presence} />
                  <Dot />
                </>
              )}
              <Button id="signup-link" size="sm" variant="outline" onClick={() => openAuthDialog('signup')} className={BOX}>
                <RiUserAddLine aria-hidden size={ICON} />
                sign up
              </Button>
              <Button id="login-link" size="sm" onClick={() => openAuthDialog('login')} className={cn(BOX, mirrored ? 'mr-2' : 'ml-2')}>
                <RiLoginBoxLine aria-hidden size={ICON} />
                log in
              </Button>
            </span>
          </span>
          {actions}
        </>
      )}
    </div>
  );

  if (mobile) {
    return (
      <SwipeDrawer id="user-drawer" side="left" open={friendsOpen} onOpenChange={(to) => store.set(friendsOpenAtom, to)} label="you">
        {(shown) => (
          <>
            {youRow}
            <div className="flex min-h-0 flex-1 flex-col">
              <Suspense fallback={<FriendsSkeleton side="left" open={shown} />}>
                <Friends open={shown} side="left" onPick={closeFriends} />
              </Suspense>
            </div>
          </>
        )}
      </SwipeDrawer>
    );
  }

  return (
    <aside
      ref={panel}
      id="user-panel"
      aria-label="you"
      data-side={side}
      data-open={friendsOpen}
      onMouseEnter={() => {
        hovered.current = true;
        stayOpen();
      }}
      onMouseLeave={() => {
        hovered.current = false;
        leaveSoon();
      }}
      onFocusCapture={stayOpen}
      onBlurCapture={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null) && !hovered.current) leaveSoon();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && friendsOpen) {
          e.stopPropagation();
          closeFriends();
        }
      }}
      className={cn(COLUMN, friendsOpen && 'z-40')}
    >
      <div className={cn(panelClass(side), WIDEN, friendsOpen ? EXPANDED : COLLAPSED)}>
        <div className="flex min-h-0 flex-1 flex-col">
          <Suspense fallback={<FriendsSkeleton side={side} open={friendsOpen} />}>
            <Friends open={friendsOpen} side={side} onPick={closeFriends} />
          </Suspense>
        </div>
        {youRow}
      </div>
    </aside>
  );
}
