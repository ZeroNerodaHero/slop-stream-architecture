import { RiBroadcastLine, RiChat3Line, RiCloseLine, RiHashtag, RiNotification3Line, RiSettings3Line, RiUserFollowLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';

import { type Notification, roomOf } from '@/infra/api';
import { meAtom } from '@/infra/atoms/auth-atoms';
import { dmsAtom, openDm } from '@/infra/atoms/dm-atoms';
import { followingAtom } from '@/infra/atoms/follow-atoms';
import { myServersAtom } from '@/infra/atoms/groups-atoms';
import {
  closeNotifications,
  dismissNotification,
  loadNotifications,
  markNotificationsRead,
  notificationsAtom,
  notificationsOpenAtom,
  toggleNotifications,
  unreadNotificationsAtom
} from '@/infra/atoms/notification-atoms';
import { openUserModal } from '@/infra/atoms/user-modal-atoms';
import type { NotificationKind } from '@/infra/frames';
import { useIsMobile } from '@/infra/mobile';
import { plainEmotes } from '@/infra/emotes';
import { store } from '@/infra/store';
import { Badge } from '@/shared-components/Badge';
import { buttonClassName } from '@/shared-components/Button';
import { Face } from '@/shared-components/Face';
import { SHEET_CLOSE, SheetGrab, useSheetBack } from '@/shared-components/MobileSheet';
import { panelClassName } from '@/shared-components/Panel';
import { Who } from '@/shared-components/PersonRow';
import { Bone, Skeleton } from '@/shared-components/Skeleton';
import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';
import { ago } from '@/utils/since';

const WIDTH = 400;
const ROWS_GUESS = 4;
const EDGE = 8;
const GAP = 8;
const TICK_MS = 30_000;

const ICON_BUTTON =
  'flex h-7 w-7 shrink-0 items-center justify-center border border-transparent text-textSecondary hover:border-primaryBlue hover:text-primaryBlue focus-visible:border-primaryBlue focus-visible:outline-none';
export const COUNT =
  'absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center border border-background bg-primaryBlue px-0.5 text-[10px] font-semibold leading-none text-background';

const REMOVE_BUTTON = cn(
  ICON_BUTTON,
  'absolute right-2 top-2 bg-backgroundSecondary opacity-0 transition-opacity duration-150 focus-visible:opacity-100',
  'group-hover/notification:opacity-100 group-focus-within/notification:opacity-100 max-md:h-9 max-md:w-9 max-md:opacity-100 [@media(hover:none)]:opacity-100'
);

const KIND_ICON: Record<NotificationKind, typeof RiBroadcastLine> = { live: RiBroadcastLine, follow: RiUserFollowLine, dm: RiChat3Line, chat: RiHashtag };
const KIND_WORDS: Record<NotificationKind, string> = { live: 'went live', follow: 'followed you', dm: '', chat: '' };

function channelPath(at: { server: string; channel: string }): string {
  const server = encodeURIComponent(at.server);
  return at.channel === 'general' ? `/groups/${server}` : `/groups/${server}/${encodeURIComponent(at.channel)}`;
}

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

export function Notifications() {
  const open = useAtomValue(notificationsOpenAtom);
  const mobile = useIsMobile();
  if (!open) return null;
  return (
    <>
      {mobile && <div id="notifications-dim" aria-hidden data-sheet-open="" onClick={closeNotifications} className="fixed inset-0 z-50 touch-none bg-black/60" />}
      <NotificationsList />
    </>
  );
}

function personOf(n: Notification) {
  const dm = store.get(dmsAtom).find((d) => d.name === n.name);
  if (dm) return { id: dm.id, name: dm.name, avatar: dm.avatar, verified: dm.verified, bio: dm.bio, presence: dm.presence };
  const f = store.get(followingAtom)?.find((p) => p.name === n.name);
  if (f) return { id: '', name: f.name, avatar: f.avatar, verified: f.verified, bio: f.bio, presence: f.presence };
  return { id: '', name: n.name, avatar: n.avatar, verified: n.verified, bio: '', presence: 'offline' as const };
}

interface RowProps {
  n: Notification;
  fresh: boolean;
  now: number;
  onPick: () => void;
}

function Row({ n, fresh, now, onPick }: RowProps) {
  const Icon = KIND_ICON[n.kind];
  const when = new Date(n.at);
  const at = roomOf(n);
  const servers = useAtomValue(myServersAtom);
  const found = at ? (n.badge ?? servers?.find((s) => s.name === at.server)) : null;
  const group = found?.badge ? found : null;
  const className = cn(
    'flex w-full items-start gap-3 border border-transparent py-2 pl-3 pr-11 text-left transition-colors duration-150 max-md:pr-12',
    'group-hover/notification:border-primaryStroke group-hover/notification:bg-backgroundTertiary/60 focus-visible:border-primaryBlue focus-visible:outline-none'
  );
  const inner = (
    <>
      <span className="relative mt-0.5 shrink-0">
        <Face name={n.name} version={n.avatar} className="h-9 w-9 text-sm" />
        <span
          aria-hidden
          className={cn(
            'absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center border border-backgroundSecondary',
            n.kind === 'live' ? 'bg-primaryBlue text-background' : 'bg-background text-textSecondary'
          )}
        >
          <Icon size={10} />
        </span>
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 leading-tight">
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-sm">
          <Who name={n.name} verified={n.verified} className="max-w-full" />
          {n.kind === 'chat' && at && (
            <span className="flex min-w-0 max-w-full items-center gap-1.5 text-textSecondary">
              <span className="truncate">
                in #{at.channel}
                {!group && ` of ${at.server}`}
              </span>
              {group && (
                <span role="img" aria-label={`of ${at.server}`} className="inline-flex shrink-0">
                  <Badge group={group} />
                </span>
              )}
            </span>
          )}
          {n.kind !== 'dm' && n.kind !== 'chat' && <span className="text-textSecondary">{KIND_WORDS[n.kind]}</span>}
        </span>
        {(n.kind === 'dm' || n.kind === 'chat') && (
          <span className="truncate text-sm text-textSecondary [overflow-wrap:anywhere]">{plainEmotes(n.text) || 'a picture or a video'}</span>
        )}
        <span className="text-xs text-textTertiary" title={when.toLocaleString()}>
          {ago(when.toISOString(), now)}
        </span>
      </span>
      {fresh && <span aria-label="new" className="mt-2 h-2 w-2 shrink-0 bg-primaryBlue" />}
    </>
  );
  if (n.kind === 'chat' && at) {
    return (
      <Link
        id={`notification-${n.id}`}
        to={channelPath(at)}
        data-kind={n.kind}
        data-fresh={fresh || undefined}
        data-room={n.room ?? undefined}
        title={`open #${at.channel} in ${at.server}`}
        onClick={onPick}
        className={className}
      >
        {inner}
      </Link>
    );
  }
  if (n.kind === 'dm') {
    return (
      <button
        id={`notification-${n.id}`}
        type="button"
        data-kind={n.kind}
        data-fresh={fresh || undefined}
        title={`open the chat with ${n.name}`}
        onClick={() => {
          onPick();
          openDm(personOf(n));
        }}
        className={className}
      >
        {inner}
      </button>
    );
  }
  return (
    <Link
      id={`notification-${n.id}`}
      to={`/watch/${encodeURIComponent(n.name)}`}
      data-kind={n.kind}
      data-fresh={fresh || undefined}
      title={n.kind === 'live' ? `watch ${n.name}` : `${n.name}'s page`}
      onClick={onPick}
      className={className}
    >
      {inner}
    </Link>
  );
}

function RemoveButton({ id }: { id: number }) {
  return (
    <Tooltip content="remove">
      <button
        id={`notification-remove-${id}`}
        type="button"
        aria-label="remove notification"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const li = e.currentTarget.closest('li');
          const next = (li?.nextElementSibling ?? li?.previousElementSibling)?.querySelector<HTMLElement>('[id^="notification-remove-"]');
          (next ?? document.getElementById('notifications-close'))?.focus();
          dismissNotification(id);
        }}
        className={REMOVE_BUTTON}
      >
        <RiCloseLine aria-hidden size={16} />
      </button>
    </Tooltip>
  );
}

function NotificationsList() {
  const me = useAtomValue(meAtom);
  const list = useAtomValue(notificationsAtom);
  const { pathname } = useLocation();
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [style, setStyle] = useState<CSSProperties | undefined>(undefined);
  const [now, setNow] = useState(() => Date.now());
  const known = useRef<Set<number> | null>(null);
  const [fresh, setFresh] = useState<ReadonlySet<number>>(() => new Set());
  const openedAt = useRef(pathname);
  const mobile = useIsMobile();

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.show();
    const place = () => {
      const bell = document.getElementById('notifications')?.getBoundingClientRect();
      const room = document.documentElement.clientWidth;
      if (!bell) {
        setStyle(undefined);
        return;
      }
      const right = Math.max(EDGE, room - bell.right);
      setStyle({ top: bell.bottom + GAP, left: 'auto', right, width: Math.min(WIDTH, room - right - EDGE) });
    };
    place();
    window.addEventListener('resize', place);
    if (store.get(notificationsAtom) === undefined) void loadNotifications();
    const clock = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => {
      window.removeEventListener('resize', place);
      window.clearInterval(clock);
      if (dialog?.contains(document.activeElement)) document.getElementById('notifications')?.focus();
      if (dialog?.open) dialog.close();
    };
  }, []);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target || dialogRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest('#notifications, #drawer-notifications, #notifications-dim')) return;
      closeNotifications();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeNotifications();
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  useEffect(() => {
    if (pathname !== openedAt.current) closeNotifications();
  }, [pathname]);

  useEffect(() => {
    if (!list) return;
    if (!known.current) {
      known.current = new Set(list.map((n) => n.id));
      setFresh(new Set(list.filter((n) => !n.read).map((n) => n.id)));
    } else {
      const came = list.filter((n) => !known.current?.has(n.id)).map((n) => n.id);
      if (came.length > 0) {
        for (const id of came) known.current.add(id);
        setFresh((prev) => new Set([...prev, ...came]));
      }
    }
    markNotificationsRead();
  }, [list]);

  const toSettings = () => {
    closeNotifications();
    openUserModal('notifications');
  };

  useSheetBack(closeNotifications);

  return (
    <dialog
      ref={dialogRef}
      id="notifications-panel"
      data-sheet={mobile ? '' : undefined}
      aria-labelledby="notifications-title"
      onClose={closeNotifications}
      style={mobile ? undefined : style}
      className={panelClassName(
        cn(
          'fixed z-50 m-0 flex max-h-[min(560px,calc(100dvh-5.5rem))] flex-col overflow-hidden p-0 text-base text-textPrimary open:flex',
          !style && !mobile && 'left-auto right-5 top-[4.5rem] w-[min(400px,calc(100vw-2.5rem))]',
          mobile && 'inset-x-0 bottom-0 top-auto w-full max-w-none max-h-[85dvh] border-x-0 border-b-0 pb-[env(safe-area-inset-bottom)]'
        )
      )}
    >
      {mobile && <SheetGrab onDismiss={closeNotifications} />}
      <header className="flex shrink-0 items-center gap-2 border-b border-primaryStroke px-3 py-2">
        <RiNotification3Line aria-hidden size={16} className="shrink-0 text-textSecondary" />
        <h2 id="notifications-title" className="min-w-0 flex-1 truncate text-sm font-semibold">
          notifications
        </h2>
        {me && (
          <Tooltip content="which kinds are kept">
            <button id="notifications-settings" type="button" aria-label="notification settings" onClick={toSettings} className={ICON_BUTTON}>
              <RiSettings3Line aria-hidden size={16} />
            </button>
          </Tooltip>
        )}
        <Tooltip content="close">
          <button id="notifications-close" type="button" aria-label="close" onClick={closeNotifications} className={cn(ICON_BUTTON, SHEET_CLOSE)}>
            <RiCloseLine aria-hidden size={18} />
          </button>
        </Tooltip>
      </header>

      {!me ? (
        <p id="notifications-nobody" className="px-4 py-4 text-sm text-textSecondary">
          notifications are for accounts: someone you follow going live, a new follower, a friend&apos;s line, a line in a group you are in, here and on your phone.{' '}
          <button
            type="button"
            onClick={() => {
              closeNotifications();
              openUserModal('security');
            }}
            className="text-primaryBlue underline-offset-2 hover:underline"
          >
            sign up or log in
          </button>
          .
        </p>
      ) : list === undefined ? (
        <Skeleton id="notifications-loading" className="py-1">
          {Array.from({ length: ROWS_GUESS }, (_, i) => (
            <div key={i} className="flex items-start gap-3 px-3 py-2">
              <Bone className="mt-0.5 h-9 w-9 shrink-0" />
              <div className="flex flex-1 flex-col gap-1.5 py-0.5">
                <Bone className="h-3.5 w-2/3" />
                <Bone className="h-3 w-1/4" />
              </div>
            </div>
          ))}
        </Skeleton>
      ) : list.length === 0 ? (
        <p id="notifications-empty" className="px-4 py-4 text-sm text-textSecondary">
          nothing yet. when someone you follow goes live, someone follows you, a friend writes, or someone writes in a group you are in, it shows up here.
        </p>
      ) : (
        <>
          <ul id="notifications-list" aria-label="notifications" className="min-h-0 flex-auto overflow-y-auto overscroll-contain py-1">
            {list.map((n) => (
              <li key={n.id} className="group/notification relative">
                <Row n={n} fresh={fresh.has(n.id) || !n.read} now={now} onPick={closeNotifications} />
                <RemoveButton id={n.id} />
              </li>
            ))}
          </ul>
        </>
      )}
    </dialog>
  );
}
