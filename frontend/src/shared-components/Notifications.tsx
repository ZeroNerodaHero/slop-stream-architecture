import { RiBroadcastLine, RiChat3Line, RiCloseLine, RiNotification3Line, RiSettings3Line, RiUserFollowLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';

import type { Notification } from '@/infra/api';
import { meAtom } from '@/infra/atoms/auth-atoms';
import { dmsAtom, openDm } from '@/infra/atoms/dm-atoms';
import { followingAtom } from '@/infra/atoms/follow-atoms';
import {
  closeNotifications,
  KEEP,
  loadNotifications,
  markNotificationsRead,
  notificationsAtom,
  notificationsOpenAtom,
  toggleNotifications,
  unreadNotificationsAtom
} from '@/infra/atoms/notification-atoms';
import { openUserModal } from '@/infra/atoms/user-modal-atoms';
import type { NotificationKind } from '@/infra/frames';
import { store } from '@/infra/store';
import { buttonClassName } from '@/shared-components/Button';
import { Face } from '@/shared-components/Face';
import { panelClassName } from '@/shared-components/Panel';
import { Who } from '@/shared-components/PersonRow';
import { Bone, Skeleton } from '@/shared-components/Skeleton';
import { cn } from '@/utils/cn';
import { ago } from '@/utils/since';

/** The list is this wide at most, and at least this far from the window's edge. */
const WIDTH = 400;
/** How many grey rows stand in the list before the inbox has answered. */
const ROWS_GUESS = 4;
const EDGE = 8;
/** Between the bell and the list. */
const GAP = 8;
/** The clock the rows' `3 min ago` runs on. */
const TICK_MS = 30_000;

const ICON_BUTTON =
  'flex h-7 w-7 shrink-0 items-center justify-center border border-transparent text-textSecondary hover:border-primaryBlue hover:text-primaryBlue focus-visible:border-primaryBlue focus-visible:outline-none';
/** The number on the bell: the sidebar's blue square, as its counts have it. */
const COUNT =
  'absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center border border-background bg-primaryBlue px-0.5 text-[10px] font-semibold leading-none text-background';

/** The small mark in the corner of the face: what kind of thing this is. */
const KIND_ICON: Record<NotificationKind, typeof RiBroadcastLine> = { live: RiBroadcastLine, follow: RiUserFollowLine, dm: RiChat3Line };
/** The words after the name. A dm's are its own text. */
const KIND_WORDS: Record<NotificationKind, string> = { live: 'went live', follow: 'followed you', dm: '' };

/**
 * The bell at the right end of every page's title row, before go live: the login's inbox
 * (docs/notifications.md), with how many are new on its corner. A click opens the list under
 * it (Notifications, mounted by the Shell) and closes it again.
 */
export function NotificationsBell() {
  const open = useAtomValue(notificationsOpenAtom);
  const unread = useAtomValue(unreadNotificationsAtom);
  return (
    <button
      id="notifications"
      type="button"
      aria-label={unread > 0 ? `notifications, ${unread} new` : 'notifications'}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={open ? 'notifications-panel' : undefined}
      title={unread > 0 ? `notifications: ${unread} new` : 'notifications'}
      data-unread={unread || undefined}
      onClick={toggleNotifications}
      className={cn(buttonClassName('secondary', 'relative px-2.5 py-2'), open && 'border-primaryBlue text-primaryBlue')}
    >
      <RiNotification3Line aria-hidden size={18} />
      {unread > 0 && (
        <span id="notifications-unread" aria-hidden className={COUNT}>
          {unread > 99 ? '99+' : unread}
        </span>
      )}
    </button>
  );
}

/** The list under the bell. Renders nothing until the bell is pressed. */
export function Notifications() {
  const open = useAtomValue(notificationsOpenAtom);
  return open ? <NotificationsList /> : null;
}

/** The person a dm row opens a chat with: as the chat window or the sidebar has them now, else what the row knows. */
function personOf(n: Notification) {
  const dm = store.get(dmsAtom).find((d) => d.name === n.name);
  if (dm) return { id: dm.id, name: dm.name, avatar: dm.avatar, verified: dm.verified, bio: dm.bio, presence: dm.presence };
  const f = store.get(followingAtom)?.find((p) => p.name === n.name);
  if (f) return { id: '', name: f.name, avatar: f.avatar, verified: f.verified, bio: f.bio, presence: f.presence };
  return { id: '', name: n.name, avatar: n.avatar, verified: n.verified, bio: '', presence: 'offline' as const };
}

interface RowProps {
  n: Notification;
  /** New when the list opened, or since: the blue square at the row's end. */
  fresh: boolean;
  now: number;
  onPick: () => void;
}

/**
 * One row: the face with the kind in its corner, the name and what happened, when. A go-live
 * and a follow are links to the person's page; a dm opens the chat with them.
 */
function Row({ n, fresh, now, onPick }: RowProps) {
  const Icon = KIND_ICON[n.kind];
  const when = new Date(n.at);
  const className = cn(
    'flex w-full items-start gap-3 border border-transparent px-3 py-2 text-left transition-colors duration-150',
    'hover:border-primaryStroke hover:bg-backgroundTertiary/60 focus-visible:border-primaryBlue focus-visible:outline-none'
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
          {n.kind !== 'dm' && <span className="text-textSecondary">{KIND_WORDS[n.kind]}</span>}
        </span>
        {n.kind === 'dm' && <span className="truncate text-sm text-textSecondary [overflow-wrap:anywhere]">{n.text}</span>}
        <span className="text-xs text-textTertiary" title={when.toLocaleString()}>
          {ago(when.toISOString(), now)}
        </span>
      </span>
      {/* new: the blue square, the colour the counts wear; it stays while the list is open, so what was new can be told apart */}
      {fresh && <span aria-label="new" className="mt-2 h-2 w-2 shrink-0 bg-primaryBlue" />}
    </>
  );
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

/**
 * The login's inbox under the bell: the last 30 things that happened to them, newest first,
 * each a row (above). Opening it reads everything on it (the number on the bell goes, the api
 * is told, the other devices follow); the rows that were new keep their mark for as long as
 * the list is open, and so does one that comes while it is. A `<dialog>` shown, not modal: the
 * page stays usable, and a click anywhere else, escape, the ×, or a page change closes it.
 * For nobody it says what an account would get. The gear in its header is the notifications
 * tab of the user modal, where the kinds are switched.
 */
function NotificationsList() {
  const me = useAtomValue(meAtom);
  const list = useAtomValue(notificationsAtom);
  const { pathname } = useLocation();
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [style, setStyle] = useState<CSSProperties | undefined>(undefined);
  const [now, setNow] = useState(() => Date.now());
  /** The rows the list has shown. A row not here is new, whatever its `read` says (the store reads it as it comes). */
  const known = useRef<Set<number> | null>(null);
  const [fresh, setFresh] = useState<ReadonlySet<number>>(() => new Set());
  const openedAt = useRef(pathname);

  // Mount only: shown under the bell (and kept there through a resize), the list asked for when
  // this tab has none yet (a load that failed; the rows otherwise come by push), the clock.
  // Closed on the way out, and focus back on the bell when it was in here.
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
      // `left: auto`: the browser's own dialog style pins both edges, and with a width the left one would win
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

  // a press anywhere outside the list (the bell has its own toggle) closes it, and so does escape
  // wherever the focus is (a box that stops the key for itself, the chat window's, keeps it)
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target || dialogRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest('#notifications')) return;
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

  // a page change closes it: a row was clicked, or the back button
  useEffect(() => {
    if (pathname !== openedAt.current) closeNotifications();
  }, [pathname]);

  // the rows that are new: the unread ones when the list first shows, and every row that comes after. then
  // everything on it has been seen (the store marks the rows read; the bell's number goes; the api is told)
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

  return (
    <dialog
      ref={dialogRef}
      id="notifications-panel"
      aria-labelledby="notifications-title"
      onClose={closeNotifications}
      style={style}
      className={panelClassName(
        cn(
          'fixed z-50 m-0 flex max-h-[min(560px,calc(100dvh-5.5rem))] flex-col overflow-hidden p-0 text-base text-textPrimary open:flex',
          // until the bell is measured: the top right of the window
          !style && 'left-auto right-5 top-[4.5rem] w-[min(400px,calc(100vw-2.5rem))]'
        )
      )}
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-primaryStroke px-3 py-2">
        <RiNotification3Line aria-hidden size={16} className="shrink-0 text-textSecondary" />
        <h2 id="notifications-title" className="min-w-0 flex-1 truncate text-sm font-semibold">
          notifications
        </h2>
        {me && (
          <button id="notifications-settings" type="button" aria-label="notification settings" title="which kinds are kept" onClick={toSettings} className={ICON_BUTTON}>
            <RiSettings3Line aria-hidden size={16} />
          </button>
        )}
        <button id="notifications-close" type="button" aria-label="close" title="close" onClick={closeNotifications} className={ICON_BUTTON}>
          <RiCloseLine aria-hidden size={18} />
        </button>
      </header>

      {!me ? (
        <p id="notifications-nobody" className="px-4 py-4 text-sm text-textSecondary">
          notifications are for accounts: someone you follow going live, a new follower, a friend&apos;s line, here and on your phone.{' '}
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
        // a few rows' worth of grey, the rows' shape: the face, the name and what happened, when
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
          nothing yet. when someone you follow goes live, someone follows you, or a friend writes, it shows up here.
        </p>
      ) : (
        <>
          <ul id="notifications-list" aria-label="notifications" className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1">
            {list.map((n) => (
              <li key={n.id}>
                <Row n={n} fresh={fresh.has(n.id) || !n.read} now={now} onPick={closeNotifications} />
              </li>
            ))}
          </ul>
          {list.length >= KEEP && <p className="shrink-0 border-t border-primaryStroke px-3 py-1.5 text-xs text-textTertiary">the last {KEEP}. older ones are gone.</p>}
        </>
      )}
    </dialog>
  );
}
