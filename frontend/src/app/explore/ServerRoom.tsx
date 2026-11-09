import {
  RiAddLine,
  RiCloseLine,
  RiDeleteBinLine,
  RiDraggable,
  RiForbidLine,
  RiGroupLine,
  RiHashtag,
  RiInformationLine,
  RiLockLine,
  RiLogoutBoxRLine,
  RiNotificationLine,
  RiNotificationOffLine,
  RiPencilLine,
  RiSearchLine,
  RiSettings3Line,
  RiShieldStarLine,
  RiTimeLine,
  RiUserUnfollowLine,
  RiVipCrownLine
} from '@remixicon/react';
import { useAtomValue } from 'jotai';
import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
  type SyntheticEvent
} from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { api, type Channel, CHANNEL_CAP, groupImage, type GroupMember, type GroupRole, groupWords, messageOf, type GroupRoom, type RolePerms } from '@/infra/api';
import { meAtom } from '@/infra/atoms/auth-atoms';
import { reconnectChat } from '@/infra/atoms/chat-atoms';
import { cropPicture } from '@/infra/atoms/crop-atoms';
import { PRESENCE_WORD, presenceOfAtom } from '@/infra/atoms/presence-atoms';
import {
  channelRenamedAtom,
  enterRoom,
  leaveRoom,
  reloadLines,
  reloadRoom,
  renameChannel,
  roomAtom,
  roomErrorAtom,
  roomGoneAtom,
  setChannelMuted,
  setChannelOrder
} from '@/infra/atoms/room-atoms';
import { cleanName, isValidName } from '@/infra/names';
import { GROUP_BANNER, GROUP_ICON } from '@/infra/picture';
import { previewStreamsAtom, setHomePreviews } from '@/infra/preview';
import { store } from '@/infra/store';
import { Badge } from '@/shared-components/Badge';
import { Button, buttonClassName } from '@/shared-components/Button';
import { type ChatSearch, comboProps, SearchFilters, SearchSuggestions, useChatSearch } from '@/shared-components/ChatSearch';
import { ConfirmDialog } from '@/shared-components/ConfirmDialog';
import { Face } from '@/shared-components/Face';
import { GroupMark } from '@/shared-components/GroupMark';
import { ChatPanel } from '@/shared-components/ChatPanel';
import { PageFrame } from '@/shared-components/PageFrame';
import { PersonCard, usePeek } from '@/shared-components/PersonCard';
import { PresenceSquare } from '@/shared-components/PersonRow';
import { PicturePick } from '@/shared-components/PicturePick';
import { Bone, Skeleton } from '@/shared-components/Skeleton';
import { Tooltip } from '@/shared-components/Tooltip';
import { Field, SECTION_TITLE, Section } from '@/shared-components/user-modal/parts';
import { cn } from '@/utils/cn';

/** Cameras played in the room. The same peers home uses, muted, and not counted as viewers. */
const FACES = 4;

const TILE = 'block overflow-hidden border border-primaryStroke bg-backgroundSecondary transition-[border-color] duration-150 hover:border-primaryBlue';

const RESERVED = new Set(['before', 'search', 'by', 'around']);

const INPUT = 'min-w-0 flex-1 border border-primaryStroke bg-background px-3 py-2 text-base text-textPrimary placeholder:text-textTertiary';

/** Matches `MAX_ABOUT_CHARS` in the api: a channel's line about it, like the group's. */
const ABOUT_CAP = 200;

/**
 * The room is the window: a 7px breath under the title row it sits under (its measured height,
 * `--title-row`: PageFrame.tsx, which globals.css also makes the page's `scroll-padding-top`;
 * 4rem until it is measured), the chat, and a 7px breath over the window's foot. The grid
 * carries both breaths as padding, so the snap puts its edge under the row and the chat 7px
 * below it, and it folds the page's foot (`pb-10`, 2.5rem) under itself. So the room scrolled
 * to is exactly what the window shows, and the page can scroll exactly that far, whether the
 * row is one line or two. The columns beside the chat, the channels and the roster, stand 7px
 * further in (SIDE_INSET): 14px under the row, and the roster ends 14px over the foot, which
 * it may not pass.
 */
const ROOM_GRID = 'grid snap-start items-start gap-4 py-[7px] -mb-10';
/** The room's three columns on a wide screen: the channels, the chat, the roster. The skeleton has the same, so the chat lands at its width. */
const ROOM_COLUMNS = 'lg:grid-cols-[200px_minmax(0,1fr)_240px]';
const ROOM_HEIGHT = 'h-[calc(100dvh-var(--title-row,4rem)-14px)] min-h-[420px]';
const SIDE_INSET = 'mt-[7px]';
const ROSTER_HEIGHT = 'max-h-[calc(100dvh-var(--title-row,4rem)-28px)]';

/**
 * The page's two views, each a snap area (`snap-start`; the type is on <html> while the page
 * is up, see ServerPage): the top, where the banner's margin above (the title row's `mb-6`) is
 * scroll margin so the snap lands at the very top of the page, not with the banner flush under
 * the row; and the room, under the title row. The skeleton has the same two.
 */
const TOP_VIEW = 'snap-start scroll-mt-6';

/** The header's icon-only buttons (the gear, leave): a tooltip for the word, a border on hover. */
const ICON_BUTTON =
  'flex h-7 w-7 shrink-0 items-center justify-center border border-transparent focus-visible:border-primaryBlue focus-visible:outline-none disabled:cursor-default disabled:opacity-40';

/**
 * The bell on a channel's row while the channel is not muted: up with the pointer on the row
 * (`group/channel`) or the keyboard focus on it, and always up on a screen with no hover,
 * which has no pointer to rest there. Muted, the bell is the mark that says so, and stays up.
 */
const BELL_HIDDEN = 'opacity-0 transition-opacity duration-150 focus-visible:opacity-100 group-hover/channel:opacity-100 [@media(hover:none)]:opacity-100';

/** The pencil by a channel's name on the channels tab, the same way: up with the pointer on the name (`group/name`), the focus on it, or no hover to wait for. */
const PENCIL_HIDDEN = 'opacity-0 transition-opacity duration-150 focus-visible:opacity-100 group-hover/name:opacity-100 [@media(hover:none)]:opacity-100';

const COLORS = ['#5865f2', '#f85149', '#3fb950', '#f2cc60', '#bc8cff', '#ff9f43', '#39d2c0', '#ff6bcb'] as const;

/** Matches `MAX_ROLES` in the api. */
const ROLE_CAP = 20;

const ORDERS = [
  { id: 'name', label: 'name' },
  { id: 'newest', label: 'newest' },
  { id: 'oldest', label: 'oldest' }
] as const;

/** The five powers: the word for each (the rows, the tooltips) and its icon (the role editor's toggles), the manage tabs' icons where a tab is that power's. */
const POWERS: { key: keyof RolePerms; label: string; icon: ReactNode }[] = [
  {
    key: 'appearance',
    label: 'about and public',
    icon: <RiInformationLine aria-hidden size={16} />
  },
  {
    key: 'roles',
    label: 'roles',
    icon: <RiShieldStarLine aria-hidden size={16} />
  },
  {
    key: 'channels',
    label: 'channels',
    icon: <RiHashtag aria-hidden size={16} />
  },
  {
    key: 'kick',
    label: 'kick',
    icon: <RiUserUnfollowLine aria-hidden size={16} />
  },
  { key: 'ban', label: 'ban', icon: <RiForbidLine aria-hidden size={16} /> }
];

const NO_PERMS: RolePerms = {
  appearance: false,
  roles: false,
  channels: false,
  kick: false,
  ban: false
};

/** A role's cooldown, the choices (seconds): off, then a few steps up to five minutes. The api takes any 0 to 3600. */
const COOLDOWNS = [0, 5, 15, 30, 60, 300];

/** A cooldown in words: `off`, `30s`, `5m`. */
function cooldownWords(seconds: number): string {
  if (seconds === 0) return 'off';
  return seconds < 60 ? `${seconds}s` : `${Math.round(seconds / 60)}m`;
}

/** How long a timeout runs, the choices on the members tab (seconds, and the word). The api takes 10 seconds to a week. */
const TIMEOUTS: { key: string; label: string }[] = [
  { key: '60', label: '1 minute' },
  { key: '600', label: '10 minutes' },
  { key: '3600', label: 'an hour' },
  { key: '86400', label: 'a day' }
];

/** Whether a member's timeout (unix seconds) is still running. */
function timedOut(member: GroupMember): boolean {
  return (member.timeout ?? 0) * 1000 > Date.now();
}

/** When a timeout ends, in words: the time today, or the day and the time further off. */
function untilWords(unix: number): string {
  const at = new Date(unix * 1000);
  const far = at.getTime() - Date.now() > 20 * 3600_000;
  return far ? at.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/**
 * Whether this login may make, change, delete, give or take a role with these powers: an owner
 * and a site admin may any; anyone else only one whose every power they hold themselves. The
 * api's rule, so the page offers nothing the api refuses.
 */
function reaches(room: GroupRoom, perms: RolePerms): boolean {
  return room.owner || room.admin === true || POWERS.every((power) => !perms[power.key] || room.perms[power.key]);
}

/** Whether this login holds a power. Every power does something to a member, so this is the members tab's rule too. */
function manages(room: GroupRoom): boolean {
  return room.owner || POWERS.some((power) => room.perms[power.key]);
}

/** What the group calls its owner role (docs/groups.md): `owner` until an owner renames it; an older api has no word for it. */
function ownerRoleOf(room: GroupRoom): string {
  return room.owner_role ?? 'owner';
}

/**
 * An owner's mark: a crown, the owner role's name its tooltip and its words for a reader. On the
 * header and the roster. With `words`, the name stands beside the crown instead, the way a role
 * stands on the members tab, and there is no tooltip to repeat it.
 */
function OwnerMark({ name, size = 14, words = false }: { name: string; size?: number; words?: boolean }) {
  if (words) {
    return (
      <span data-owner-mark className="flex shrink-0 items-center gap-1 text-xs text-primaryBlue">
        <RiVipCrownLine aria-hidden size={size} />
        {name}
      </span>
    );
  }
  return (
    <Tooltip content={name}>
      <span role="img" aria-label={name} data-owner-mark className="flex shrink-0 text-primaryBlue">
        <RiVipCrownLine aria-hidden size={size} />
      </span>
    </Tooltip>
  );
}

/** One line of a `HoverMenu`: what a pick says (`key`), the word for it, and its colour when it has one (a role's). */
interface MenuItem {
  key: string;
  label: string;
  color?: string;
}

/**
 * A menu on a small trigger (the `+` after a member's roles, the word `time out`): its items
 * open while the pointer rests on the trigger or on the menu (a short grace for a pointer
 * crossing between them), or on a click or enter for a touch screen and the keyboard, which
 * puts the focus on the first item; the arrows walk it, escape closes it and hands the focus
 * back, so does the focus leaving. A 1px box drawn into the dialog, fixed, like the tooltips,
 * since the pane scrolls and would clip it: under the trigger, or over it at the window's
 * foot. A pick closes the menu and says its key. Nothing at all without items.
 */
function HoverMenu({
  label,
  items,
  onPick,
  className,
  children
}: {
  label: string;
  items: MenuItem[];
  onPick: (key: string) => void;
  className: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const plus = useRef<HTMLButtonElement | null>(null);
  const menu = useRef<HTMLUListElement | null>(null);
  const closing = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Opened by a click or a key: the first item takes the focus once the menu is placed. */
  const focusFirst = useRef(false);

  const show = () => {
    if (closing.current) clearTimeout(closing.current);
    closing.current = null;
    setHost(plus.current?.closest<HTMLElement>('dialog:modal') ?? document.body);
    setOpen(true);
  };
  const hide = () => {
    if (closing.current) clearTimeout(closing.current);
    closing.current = setTimeout(() => setOpen(false), 150);
  };
  const close = () => {
    if (closing.current) clearTimeout(closing.current);
    closing.current = null;
    setOpen(false);
  };

  useEffect(
    () => () => {
      if (closing.current) clearTimeout(closing.current);
    },
    []
  );

  // placed before paint (`left-0 top-0` until then, the tooltips' way): under the plus, kept in
  // the window; over the plus when the foot is too near. again on a scroll or a resize
  useLayoutEffect(() => {
    const el = menu.current;
    if (!open || !el) return;
    const place = () => {
      const a = plus.current?.getBoundingClientRect();
      if (!a) return;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      el.style.left = `${Math.max(4, Math.min(a.left, document.documentElement.clientWidth - w - 4))}px`;
      el.style.top = `${a.bottom + h <= document.documentElement.clientHeight - 4 ? a.bottom : Math.max(4, a.top - h)}px`;
    };
    place();
    if (focusFirst.current) {
      focusFirst.current = false;
      el.querySelector<HTMLButtonElement>('button')?.focus();
    }
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open]);

  if (items.length === 0) return null;

  function walk(e: KeyboardEvent<HTMLUListElement>) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      plus.current?.focus();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  }

  return (
    <>
      <button
        ref={plus}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onPointerEnter={(e) => {
          if (e.pointerType !== 'touch') show();
        }}
        onPointerLeave={hide}
        onClick={() => {
          if (open) return close();
          focusFirst.current = true;
          show();
        }}
        className={className}
      >
        {children}
      </button>
      {open &&
        host &&
        createPortal(
          <ul
            ref={menu}
            role="menu"
            aria-label={label}
            onPointerEnter={show}
            onPointerLeave={hide}
            onKeyDown={walk}
            onBlur={(e) => {
              const to = e.relatedTarget;
              if (to instanceof Node && (menu.current?.contains(to) || plus.current === to)) return;
              close();
            }}
            className="fixed left-0 top-0 z-[60] flex min-w-32 flex-col border border-primaryStroke bg-backgroundSecondary py-1 text-sm"
          >
            {/* what the menu is, said in it: the plus it hangs off is an icon alone, and a tooltip would fight the menu for the hover (tooltips.mdc) */}
            <li role="none" className="px-3 pb-1 pt-0.5 text-xs text-textTertiary">
              {label}
            </li>
            {items.map((item) => (
              <li key={item.key} role="none">
                <button
                  role="menuitem"
                  type="button"
                  data-pick={item.key}
                  className={cn(
                    'flex w-full items-center px-3 py-1 text-left hover:bg-primaryStroke/20 focus-visible:bg-primaryStroke/20 focus-visible:outline-none',
                    item.color ? 'font-semibold' : 'text-textPrimary'
                  )}
                  style={item.color ? { color: item.color } : undefined}
                  onClick={() => {
                    close();
                    onPick(item.key);
                  }}
                >
                  {item.label}
                </button>
              </li>
            ))}
          </ul>,
          host
        )}
    </>
  );
}

/** The roles a channel is kept to (docs/groups.md). None: the channel is everyone's. */
function keptTo(room: GroupRoom, channel: string): GroupRole[] {
  return room.roles.filter((role) => (role.channels ?? []).includes(channel));
}

/**
 * A channel's cooldown on the channels tab: a clock and the word (`off`, `30s`), which for the
 * channels power opens the choices as a menu (HoverMenu; a pick puts it, `setChannelCooldown`),
 * and for anyone else stands as it is, and only while there is one. On the page's list the
 * clock alone, the word its tooltip (`words`).
 */
function CooldownMark({ item, canSet, onPick, words = false }: { item: Channel; canSet: boolean; onPick?: (seconds: number) => void; words?: boolean }) {
  const seconds = item.cooldown ?? 0;
  if (words) {
    if (seconds === 0) return null;
    const said = `cooldown ${cooldownWords(seconds)}`;
    return (
      <Tooltip content={said}>
        <span role="img" aria-label={said} data-cooldown={seconds} className="flex shrink-0 text-textTertiary">
          <RiTimeLine aria-hidden size={14} />
        </span>
      </Tooltip>
    );
  }
  if (!canSet) {
    if (seconds === 0) return null;
    return (
      <span data-cooldown={seconds} className="flex shrink-0 items-center gap-1 text-xs text-textTertiary">
        <RiTimeLine aria-hidden size={14} />
        {cooldownWords(seconds)}
      </span>
    );
  }
  return (
    <HoverMenu
      label={`cooldown of #${item.name}`}
      items={(COOLDOWNS.includes(seconds) ? COOLDOWNS : [...COOLDOWNS, seconds].sort((a, b) => a - b)).map((s) => ({ key: String(s), label: cooldownWords(s) }))}
      onPick={(key) => onPick?.(Number(key))}
      className={cn(
        'flex shrink-0 items-center gap-1 text-xs focus-visible:text-primaryBlue focus-visible:outline-none',
        seconds > 0 ? 'text-textSecondary hover:text-textPrimary' : 'text-textTertiary hover:text-textPrimary'
      )}
    >
      <RiTimeLine aria-hidden size={14} />
      <span data-cooldown={seconds}>{cooldownWords(seconds)}</span>
    </HoverMenu>
  );
}

/** The mark on a channel kept to roles: a lock, the roles' names its tooltip. Nothing on a channel that is everyone's. */
function KeptMark({ roles }: { roles: GroupRole[] }) {
  if (roles.length === 0) return null;
  const words = `only ${roles.map((role) => role.name).join(', ')}`;
  return (
    <Tooltip content={words}>
      <span role="img" aria-label={words} className="flex shrink-0 text-textTertiary">
        <RiLockLine aria-hidden size={14} />
      </span>
    </Tooltip>
  );
}

/**
 * Whether this login has a say over the channels: the channels power, or a channel they made
 * (`can_delete`, the api's: a maker whose power has since gone still deletes their own). The
 * channels tab's rule, and with `manages` the gear's; the list on the page deletes nothing.
 */
function managesChannels(room: GroupRoom): boolean {
  return room.perms.channels || (room.channels ?? []).some((item) => item.can_delete);
}

/** Whether this login may change the pictures: an owner's, no role carries them. A site admin may, as with every power but naming an owner. */
function ownsPictures(room: GroupRoom): boolean {
  return room.owner || room.admin === true;
}

/** One moderation call, with its refusal said where the caller shows it. The outcome arrives on the socket, like everyone else's. */
type Run = (work: () => Promise<unknown>) => Promise<void>;

/** One member's camera, muted, the width of the channel column. Click opens their stream. */
function LiveFace({ name }: { name: string }) {
  const stream = useAtomValue(previewStreamsAtom)[name] ?? null;
  const ref = useRef<HTMLVideoElement | null>(null);
  // which stream the video got to play: a new stream is not playing until it says so
  const [playingStream, setPlayingStream] = useState<MediaStream | null>(null);
  const playing = stream !== null && playingStream === stream;

  useEffect(() => {
    const el = ref.current;
    if (!el || el.srcObject === stream) return;
    el.srcObject = stream;
    if (stream) void el.play().catch(() => undefined);
  }, [stream]);

  return (
    <Link id={`group-live-${name}`} to={`/watch/${encodeURIComponent(name)}`} state={{ live: true }} className={TILE}>
      <div className="relative aspect-video bg-black">
        <img
          src={`/thumb/${encodeURIComponent(name)}.jpg`}
          alt=""
          className={cn('absolute inset-0 h-full w-full object-cover', playing && 'opacity-0')}
          onError={(event) => {
            event.currentTarget.style.display = 'none';
          }}
        />
        <video
          ref={ref}
          autoPlay
          playsInline
          muted
          aria-hidden
          onPlaying={() => setPlayingStream(stream)}
          className={cn('absolute inset-0 h-full w-full object-cover', !playing && 'opacity-0')}
        />
      </div>
      <div className="truncate px-3 py-2 text-sm font-semibold">{name}</div>
    </Link>
  );
}

/**
 * The room's search box, the roster's first row, for everyone in the room, member or guest:
 * one box for a member and for a line. The words narrow the roster under it as they are typed
 * (`Roster`, which holds them); enter, or the glass, asks the group for them, every channel
 * this login sees unless `channel:<name>` names one, and the filter words stand under the box
 * while it has the focus (ChatSearch.tsx). What a filter's word could be (`from:` a member,
 * with their face, `channel:` a channel, `has:` its kinds) is offered under the box as it is
 * typed, over the filter words while there is something to offer. The hits are the chat
 * panel's, a pane where its lines were (`SearchResults`); the panel has no box of its own.
 * Escape takes the list down, then empties the box, and the roster is whole again.
 */
function RoomSearch({ search, input }: { search: ChatSearch; input: RefObject<HTMLInputElement | null> }) {
  return (
    <form id="group-search-form" onSubmit={search.submit} className="group/search relative shrink-0">
      <label htmlFor="group-search" className="sr-only">
        search members and every channel
      </label>
      <input
        ref={input}
        id="group-search"
        {...comboProps(search, 'group-search-list')}
        onKeyDown={(e) => {
          if (search.onKeyDown(e)) return;
          if (e.key === 'Escape') search.setQuery('');
        }}
        placeholder="members or every channel"
        autoCapitalize="off"
        spellCheck={false}
        className="h-8 w-full border border-primaryStroke bg-background pl-8 pr-2 text-sm text-textPrimary placeholder:text-textTertiary"
      />
      <Tooltip content="search">
        <button
          id="group-search-go"
          type="submit"
          aria-label="search"
          className="absolute left-0 top-0 flex h-8 w-8 items-center justify-center text-textTertiary hover:text-textPrimary focus-visible:text-primaryBlue focus-visible:outline-none"
        >
          <RiSearchLine aria-hidden size={14} />
        </button>
      </Tooltip>
      <SearchFilters
        id="group-search-filters"
        search={search}
        className="absolute left-0 right-0 top-full z-10 mt-1 hidden border border-primaryStroke bg-backgroundSecondary px-2 py-1 group-focus-within/search:flex"
      />
      <SearchSuggestions id="group-search-list" search={search} />
    </form>
  );
}

function GroupName({ words }: { words: { title: string; tag: string | null } }) {
  return (
    <>
      {words.title}
      {words.tag && <span className="ml-1 font-normal text-textTertiary">#{words.tag}</span>}
    </>
  );
}

/**
 * The room's shape in grey while it is asked for: the banner with the picture over its foot,
 * the title and the line about it, then the channels, the chat, and the roster's column (the
 * search box, the heading, a few faces: it is everyone's, so the chat lands at its width). The
 * answer lands on top of this instead of under a word. `gridRef` is the room's place: the page
 * scrolls to it while this shows, so the room lands where the window already is.
 */
function RoomSkeleton({ gridRef }: { gridRef: RefObject<HTMLDivElement | null> }) {
  return (
    <Skeleton id="group-loading" label="loading the group">
      <div className={cn('relative mb-16', TOP_VIEW)}>
        <div className="relative h-36 border border-primaryStroke">
          <Bone className="absolute inset-0" />
        </div>
        <div className="absolute -bottom-12 left-4 h-24 w-24 border-4 border-background">
          <Bone className="h-full" />
        </div>
      </div>
      <div className="mb-7 flex flex-col gap-2 pl-4">
        <Bone className="h-6 w-56 max-w-full" />
        <Bone className="h-4 w-80 max-w-full" />
      </div>
      <div ref={gridRef} className={cn(ROOM_GRID, ROOM_COLUMNS)}>
        <div className={cn('flex flex-col gap-1.5', SIDE_INSET)}>
          <Bone className="mb-1 h-3 w-24" />
          {Array.from({ length: 3 }, (_, i) => (
            <Bone key={i} className="h-7" />
          ))}
        </div>
        <div className={cn('flex flex-col gap-3 border border-primaryStroke bg-backgroundSecondary p-3', ROOM_HEIGHT)}>
          <Bone className="h-4 w-2/3" />
          <Bone className="h-4 w-1/2" />
          <Bone className="h-4 w-3/4" />
          <Bone className="mt-auto h-10" />
        </div>
        <div className={cn('flex flex-col gap-3 border border-primaryStroke bg-backgroundSecondary p-4', SIDE_INSET)}>
          <Bone className="h-8" />
          <Bone className="h-3 w-20" />
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="flex items-center gap-2">
              <Bone className="h-8 w-8 shrink-0" />
              <Bone className={cn('h-3', i === 1 ? 'w-16' : 'w-24')} />
            </div>
          ))}
        </div>
      </div>
    </Skeleton>
  );
}

/**
 * A group as a server: `/groups/<server>` and `/groups/<server>/<channel>`, one page, keyed
 * on the server by the router so a change of channel is a change of what is shown and nothing
 * more. The room (the group, its channels, who is live, the roster and the bans this login may
 * see) is asked once when the page arrives, with the last lines of every channel, and then the
 * events socket keeps it: every change arrives as a `group` frame and lands in place
 * (room-atoms). The chat is one socket for the whole server; the channel list swaps what the
 * panel shows. The banner and the picture sit over the channel list and a chat that reads as
 * a room, not as the stream's panel. Whoever is live is a tile under the channels, on the
 * left (`LiveFace`, at most FACES playing); with every camera off the column is the channels alone.
 *
 * The page is two views, and snaps between them: the room, the height of the window under the
 * title row (ROOM_HEIGHT), which is where the page lands when it opens, and the top, the
 * banner, the picture, the name and the line about it, a scroll up away. The window is the
 * page's scroller, so the snap type goes on <html> while the page is up; each view is a
 * `snap-start` area (TOP_VIEW, `#group-room`). The landing is done once, on the first thing
 * with the room's shape (the skeleton, or the room itself), so the room arrives in place.
 */
export function ServerPage() {
  const params = useParams<{ server: string; channel?: string }>();
  const server = cleanName(params.server);
  const channel = params.channel === undefined ? 'general' : cleanName(params.channel);
  const channelOk = isValidName(channel) && !RESERVED.has(channel);
  const ok = isValidName(server) && server !== 'bot' && channelOk;
  const titleId = channel === 'general' ? 'group-title' : 'channel-title';
  const me = useAtomValue(meAtom);
  const room = useAtomValue(roomAtom);
  const error = useAtomValue(roomErrorAtom);
  const gone = useAtomValue(roomGoneAtom);
  const renamed = useAtomValue(channelRenamedAtom);
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [leaving, setLeaving] = useState(false);
  const [managing, setManaging] = useState(false);
  const live = room?.live ?? [];
  const shown = live.slice(0, FACES);
  const previewKey = shown.join(',');
  const channels = room?.channels ?? [];
  // the channel just renamed is still found under its old name until the layout effect below
  // has moved the page: otherwise the room, its dialog and its chat would be taken down for
  // "no such channel" and put back empty under the new address
  const found = channel === 'general' || channels.some((item) => item.name === channel) || renamed?.from === channel;
  /** The room's grid, or the skeleton's while the room is asked for: where the page lands. */
  const roomRef = useRef<HTMLDivElement | null>(null);
  /** Whether the page has landed on this server's own room. Until then every commit with a room's shape scrolls to it. */
  const landed = useRef(false);

  // the room, once: asked when the page arrives (and again as another login), then the
  // socket's. the channel is not an input here: changing it asks nothing
  useEffect(() => {
    if (!ok || me === undefined) return;
    enterRoom(server);
    return leaveRoom;
  }, [ok, server, me]);

  // a channel was renamed (the channels tab here, or the fact from elsewhere): the page on it is
  // the new address, and the note is cleared once the page is off the old name. not in the same
  // pass: the router lands a render later than a store write does, and clearing first would
  // leave one render with the old name in the url and no channel of that name in the room
  useLayoutEffect(() => {
    if (!renamed) return;
    if (renamed.from === channel) navigate(`/groups/${server}/${renamed.to}`, { replace: true });
    else store.set(channelRenamedAtom, null);
  }, [renamed, channel]);

  // the room was taken down for "no such channel" (the channel on screen deleted, or kept to a
  // role this login lost, under the page) and is back on another channel: the chat panel went
  // down with it, and its shelf of lines, so the last lines are asked for again
  const missing = room !== null && !found;
  const wasMissing = useRef(false);
  useEffect(() => {
    if (wasMissing.current && !missing) reloadLines();
    wasMissing.current = missing;
  }, [missing]);

  useEffect(() => {
    const names = previewKey ? previewKey.split(',') : [];
    setHomePreviews(names);
    return () => setHomePreviews([]);
  }, [previewKey]);

  // the two views snap: the type is the window's, so it sits on <html> for as long as the page is up
  useEffect(() => {
    if (!ok) return;
    const root = document.documentElement;
    root.style.scrollSnapType = 'y mandatory';
    return () => {
      root.style.scrollSnapType = '';
    };
  }, [ok]);

  // the landing: the room under the title row, before anything is painted. the skeleton's grid
  // counts, so the wait is spent looking at the room's place; the room itself, when it is this
  // server's (the atom may still hold the last page's for the first commit), is the last time
  useLayoutEffect(() => {
    const grid = roomRef.current;
    if (landed.current || !grid) return;
    if (room !== null && room.name === server) landed.current = true;
    grid.scrollIntoView({ block: 'start', behavior: 'instant' });
  });

  if (!ok) {
    return (
      <PageFrame title={channelOk ? 'no such group' : 'no such channel'}>
        <p className="text-textSecondary">{channelOk ? 'that is not a group.' : 'that is not a channel.'}</p>
      </PageFrame>
    );
  }

  if (gone) {
    return (
      <PageFrame title={server} titleId={titleId}>
        <p id="group-gone" className="text-textSecondary">
          this group was deleted.{' '}
          <Link to="/groups" className="text-primaryBlue hover:underline">
            back to groups
          </Link>
        </p>
      </PageFrame>
    );
  }

  if (!room) {
    return (
      <PageFrame wide title={server || 'group'} titleId={titleId}>
        {error ? <p className="text-textSecondary">{error === 'no such group' ? 'no such group.' : error}</p> : <RoomSkeleton gridRef={roomRef} />}
      </PageFrame>
    );
  }

  async function join() {
    setBusy(true);
    setActionError('');
    try {
      await api.joinGroup(server);
      // the open chat says hello again, so my lines wear the badge; the room is asked again,
      // since what a member may see (the roster) is not what a stranger may
      reconnectChat();
      await reloadRoom();
    } catch (err) {
      setActionError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  async function leave() {
    const lastOne = (room?.members ?? 0) <= 1;
    setBusy(true);
    setActionError('');
    try {
      await api.leaveGroup(server);
      reconnectChat();
      if (lastOne) {
        navigate('/groups');
        return;
      }
      await reloadRoom();
      setLeaving(false);
    } catch (err) {
      setActionError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  /** One moderation call. Its outcome arrives on the socket, like everyone else's. */
  async function act(work: () => Promise<unknown>) {
    setActionError('');
    try {
      await work();
    } catch (err) {
      setActionError(messageOf(err));
    }
  }

  /** A new picture or banner: cropped to its size here, then put. The new version comes back on the socket. */
  async function pick(file: File, kind: 'icon' | 'banner') {
    const jpeg = await cropPicture(file, kind === 'icon' ? GROUP_ICON : GROUP_BANNER);
    if (!jpeg) return;
    await act(() => (kind === 'icon' ? api.saveGroupIcon(server, jpeg) : api.saveGroupBanner(server, jpeg)));
  }

  const words = groupWords(room);
  const color = room.color || '#5865f2';
  const bannerSrc = groupImage(server, 'banner', room.banner);
  const mine = room.mine;
  const noChannel = !found;
  const power = room.owner || POWERS.some((item) => room.perms[item.key]);
  // the gear: a tab to show. a power, or a channel of this login's own to delete (the channels tab)
  const canManage = power || managesChannels(room);
  const lastMember = mine && room.members <= 1;
  const canPicture = ownsPictures(room);

  return (
    <PageFrame
      wide
      titleId={titleId}
      title={
        <span className="flex min-w-0 items-center gap-3">
          <Badge group={{ name: server, badge: room.badge, color }} />
          <span className="truncate">
            {channel === 'general' ? (
              <GroupName words={words} />
            ) : (
              <>
                <Link to={`/groups/${server}`} className="hover:text-primaryBlue">
                  <GroupName words={words} />
                </Link>
                <span className="text-textTertiary"> / {channel}</span>
              </>
            )}
          </span>
        </span>
      }
    >
      {noChannel ? (
        <p className="text-textSecondary">
          no such channel.{' '}
          <Link to={`/groups/${server}`} className="text-primaryBlue hover:underline">
            back to #general
          </Link>
        </p>
      ) : (
        <>
          <div className={cn('relative mb-16', TOP_VIEW)}>
            <div id="group-banner" className="group/banner relative h-36 overflow-hidden border border-primaryStroke" style={{ backgroundColor: color }}>
              {bannerSrc && <img src={bannerSrc} alt="" className="h-full w-full object-cover" />}
              {canPicture && (
                <PicturePick
                  id="group-banner-pick"
                  label={room.banner === null ? 'add a banner' : 'change banner'}
                  reveal="group-hover/banner:opacity-100"
                  className="inset-0"
                  onPick={(file) => void pick(file, 'banner')}
                />
              )}
            </div>
            <div className="absolute -bottom-12 left-4 flex items-end gap-4">
              <div className="group/icon relative flex">
                <GroupMark id="group-icon" name={server} color={color} icon={room.icon} className="h-24 w-24 border-4 border-background text-3xl" />
                {canPicture && (
                  <PicturePick
                    id="group-icon-pick"
                    label={room.icon === null ? 'add a picture' : 'change picture'}
                    reveal="group-hover/icon:opacity-100"
                    className="inset-1"
                    onPick={(file) => void pick(file, 'icon')}
                  />
                )}
              </div>
            </div>
          </div>
          <div className="mb-7 flex flex-wrap items-start justify-between gap-3 pl-4">
            <div className="min-w-0">
              <h2 className="flex flex-wrap items-center gap-2 text-xl font-semibold">
                {words.title}
                {words.tag && <span className="text-base font-normal text-textTertiary">#{words.tag}</span>}
                {room.owner && <OwnerMark name={ownerRoleOf(room)} size={18} />}
                {room.public === false && <span className="bg-primaryStroke px-1.5 py-0.5 text-xs uppercase text-textSecondary">private</span>}
                <span id="group-members-count" className="text-sm font-normal text-textTertiary">
                  {room.members === 1 ? '1 member' : `${room.members} members`}
                </span>
              </h2>
              {room.about && (
                <p id="group-about-line" className="mt-2 max-w-xl text-textSecondary">
                  {room.about}
                </p>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {canManage && (
                <Tooltip content="manage">
                  <button
                    id="group-manage-open"
                    type="button"
                    aria-label="manage"
                    className={cn(ICON_BUTTON, 'text-textSecondary hover:border-primaryStroke hover:text-textPrimary')}
                    onClick={() => setManaging(true)}
                  >
                    <RiSettings3Line aria-hidden size={16} />
                  </button>
                </Tooltip>
              )}
              {!mine && me && (
                <Button id="group-join" variant="primary" className="px-3 py-1.5 text-sm" disabled={busy} onClick={() => void join()}>
                  join
                </Button>
              )}
              {!mine && me === null && (
                <Link to="/login" className={buttonClassName('primary', 'px-3 py-1.5 text-sm')}>
                  log in to join
                </Link>
              )}
              {!mine && <p className="text-sm text-textSecondary">you can read this. join to talk.</p>}
              {mine && !leaving && (
                <Tooltip content={lastMember ? 'leave and delete' : 'leave'}>
                  <button
                    id="room-leave"
                    type="button"
                    aria-label={lastMember ? 'leave and delete' : 'leave'}
                    className={cn(ICON_BUTTON, 'text-decrease hover:border-decrease')}
                    disabled={busy}
                    onClick={() => setLeaving(true)}
                  >
                    <RiLogoutBoxRLine aria-hidden size={16} />
                  </button>
                </Tooltip>
              )}
              {mine && leaving && (
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-textSecondary">{lastMember ? 'this deletes the group' : 'leave this group?'}</span>
                  <button
                    id="room-leave-yes"
                    type="button"
                    className="text-sm font-semibold text-decrease disabled:opacity-40"
                    disabled={busy}
                    onClick={() => void leave()}
                  >
                    sure
                  </button>
                  <button
                    type="button"
                    className="text-sm text-textSecondary underline-offset-2 hover:text-textPrimary hover:underline"
                    onClick={() => setLeaving(false)}
                  >
                    keep
                  </button>
                </span>
              )}
            </div>
          </div>
          {actionError && <p className="mb-4 text-sm text-decrease">{actionError}</p>}
          <div id="group-room" ref={roomRef} className={cn(ROOM_GRID, ROOM_COLUMNS)}>
            <div className={cn('flex min-w-0 flex-col gap-6', SIDE_INSET)}>
              <ChannelList server={server} channel={channel} room={room} me={me ?? null} onError={setActionError} />
              {/* the cameras, under the channels. with every camera off the list stands alone: nothing says so */}
              {shown.length > 0 && (
                <section id="group-live" aria-label="live">
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-textTertiary">
                    live <span className="font-normal normal-case tracking-normal">{live.length}</span>
                  </h3>
                  <div className="flex flex-col gap-3">
                    {shown.map((name) => (
                      <LiveFace key={name} name={name} />
                    ))}
                  </div>
                  {live.length > FACES && <p className="mt-2 text-xs text-textTertiary">{live.length - FACES} more live</p>}
                </section>
              )}
            </div>
            <div className={cn('min-w-0', ROOM_HEIGHT)}>
              {/* the search box is the roster's (RoomSearch), for a member and a guest alike; the hits land in the panel. a search is every channel's: a hit opened in another one moves the page there */}
              <ChatPanel
                name={server}
                channel={channel}
                onChannel={(to) => navigate(to === 'general' ? `/groups/${server}` : `/groups/${server}/${to}`)}
                className="h-full"
              />
            </div>
            <Roster room={room} />
          </div>
          {managing && <ManageDialog server={server} channel={channel} room={room} me={me ?? null} onClose={() => setManaging(false)} />}
        </>
      )}
    </PageFrame>
  );
}

/**
 * The channels, in the order the manage dialog put them (`general` first until it is moved).
 * Adding one takes the channels power: `add channel`, a row under the last channel, asks the
 * name and a line about it in a dialog (AddChannelDialog), and goes at the cap (CHANNEL_CAP,
 * the api's). Nothing here deletes: that is the manage dialog's channels tab. A channel
 * added, deleted or moved anywhere arrives on the socket and the list follows. A member mutes
 * a channel here (docs/notifications.md): a bell at the right of its row, up while the pointer
 * is on the row, with the word as a tooltip. A click mutes it, so its lines stop reaching
 * their bell, and the bell on the row is the crossed one from then on, and stays up as the
 * mark that says so, until they click it again.
 */
function ChannelList({ server, channel, room, me, onError }: { server: string; channel: string; room: GroupRoom; me: string | null; onError: (error: string) => void }) {
  const [adding, setAdding] = useState(false);
  const channels = room.channels ?? [];
  const muted = room.muted ?? [];
  const canAdd = room.perms.channels && room.mine;
  // the mute is a member's: a stranger gets no row to mute
  const canMute = room.mine && me !== null;
  const full = channels.length >= CHANNEL_CAP;

  async function mute(item: string, on: boolean) {
    onError('');
    try {
      await setChannelMuted(server, item, on);
    } catch (err) {
      onError(messageOf(err));
    }
  }

  return (
    <nav aria-label="channels">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-textTertiary">channels</h3>
      <ul id="group-channels" className="flex flex-col gap-0.5">
        {channels.map((item) => {
          const here = item.name === channel;
          const isMuted = muted.includes(item.name);
          return (
            // the row is the box, the name fills it and the bell sits in it at the right: the pointer anywhere on the row brings the bell up
            <li
              key={item.name}
              data-muted={isMuted || undefined}
              className={cn('group/channel flex items-center', here ? 'bg-primaryStroke/40' : 'hover:bg-primaryStroke/20')}
            >
              {here ? (
                <span aria-current="page" className="min-w-0 flex-1 truncate px-2 py-1 font-semibold">
                  #{item.name}
                </span>
              ) : (
                <Link
                  id={`group-channel-${item.name}`}
                  to={item.name === 'general' ? `/groups/${server}` : `/groups/${server}/${item.name}`}
                  className="min-w-0 flex-1 truncate px-2 py-1 text-textSecondary group-hover/channel:text-textPrimary"
                >
                  #{item.name}
                </Link>
              )}
              <KeptMark roles={keptTo(room, item.name)} />
              <CooldownMark item={item} canSet={false} words />
              {canMute && (
                <Tooltip content={isMuted ? 'unmute' : 'mute'}>
                  <button
                    id={`channel-mute-${item.name}`}
                    type="button"
                    aria-pressed={isMuted}
                    aria-label={isMuted ? `unmute #${item.name}` : `mute #${item.name}`}
                    className={cn(ICON_BUTTON, 'mr-0.5 text-textTertiary hover:text-textPrimary', !isMuted && BELL_HIDDEN)}
                    onClick={() => void mute(item.name, !isMuted)}
                  >
                    {isMuted ? <RiNotificationOffLine aria-hidden size={16} /> : <RiNotificationLine aria-hidden size={16} />}
                  </button>
                </Tooltip>
              )}
            </li>
          );
        })}
      </ul>
      {canAdd && full && (
        <p id="group-channels-full" className="mt-3 text-xs text-textTertiary">
          {CHANNEL_CAP} channels is the cap. delete one to add another.
        </p>
      )}
      {canAdd && !full && (
        // a row under the last channel, in the list's own shape: the dialog takes the name
        <button
          id="group-channel-add"
          type="button"
          aria-haspopup="dialog"
          onClick={() => setAdding(true)}
          className="mt-0.5 flex w-full items-center gap-1 px-2 py-1 text-left text-textTertiary hover:bg-primaryStroke/20 hover:text-textPrimary"
        >
          <RiAddLine aria-hidden size={14} />
          add channel
        </button>
      )}
      {adding && <AddChannelDialog server={server} channels={channels} onClose={() => setAdding(false)} />}
    </nav>
  );
}

/**
 * Why a channel cannot have this name, or nothing when it can: the name rule, the history
 * words (RESERVED, the api's), and a channel the server already has.
 */
function channelNameFault(clean: string, channels: Channel[]): string {
  if (!isValidName(clean)) return '';
  if (RESERVED.has(clean)) return `${clean} is a word the history routes use, so it cannot be a channel.`;
  if (channels.some((item) => item.name === clean)) return `there is a #${clean} already.`;
  return '';
}

/**
 * The dialog that adds a channel (docs/groups.md): its name, and a line about it if wanted.
 * `add it` posts the channel, which goes under the last one, and the page is the new channel.
 * Opened by the row under the channel list, and by `add channel` on the manage dialog's
 * channels tab: it is put on the page's body, not inside whatever opened it, the way the
 * confirm dialog is (a modal inside a modal closes the outer one with it), and the manage
 * dialog lets a close that is not its own pass. A refusal from the api is said in here.
 */
function AddChannelDialog({ server, channels, onClose }: { server: string; channels: Channel[]; onClose: () => void }) {
  const navigate = useNavigate();
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const pressedBackdrop = useRef(false);
  const [name, setName] = useState('');
  const [about, setAbout] = useState('');
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState('');
  const clean = cleanName(name);
  const fault = channelNameFault(clean, channels);
  const ok = isValidName(clean) && fault === '';

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    dialog.showModal();
    dialog.querySelector<HTMLElement>('#channel-make-name')?.focus();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  // every way out goes through the element: close() hands focus back, then fires `close`, which is onClose
  const close = () => dialogRef.current?.close();

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ok || sending) return;
    setSending(true);
    setStatus('');
    try {
      const made = await api.createChannel(server, clean, about.trim());
      close();
      navigate(`/groups/${server}/${made.name}`);
    } catch (err) {
      setStatus(messageOf(err));
      setSending(false);
    }
  }

  const onPointerDown = (e: PointerEvent<HTMLDialogElement>) => {
    pressedBackdrop.current = e.target === e.currentTarget;
  };
  const onClick = (e: MouseEvent<HTMLDialogElement>) => {
    if (pressedBackdrop.current && e.target === e.currentTarget) close();
  };

  return createPortal(
    <dialog
      ref={dialogRef}
      id="channel-make"
      aria-labelledby="channel-make-title"
      onPointerDown={onPointerDown}
      onClick={onClick}
      onClose={(event) => {
        event.stopPropagation();
        onClose();
      }}
      // the dialog box is the panel: a click whose target is the dialog element landed on the backdrop
      className="m-auto w-[min(460px,calc(100vw-3rem))] border border-primaryStroke bg-backgroundSecondary p-6 text-base text-textPrimary backdrop:bg-black/60"
    >
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-5">
        <div>
          <h2 id="channel-make-title" className="border-l-4 border-primaryBlue pl-3 text-xl font-semibold leading-tight">
            add a channel
          </h2>
          <p className="mt-3 text-sm text-textSecondary">a name, and a line about it if you like. it goes under the last channel; manage moves it.</p>
        </div>
        <Field id="channel-make-name" label="name" hint={fault || 'letters, digits, _ and -. up to 32.'}>
          <div className="relative">
            <span aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-textTertiary">
              #
            </span>
            <input
              id="channel-make-name"
              value={name}
              onChange={(e) =>
                setName(
                  e.target.value
                    .toLowerCase()
                    .replace(/[^a-z0-9_-]/g, '')
                    .slice(0, 32)
                )
              }
              maxLength={32}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              aria-describedby="channel-make-name-hint"
              aria-invalid={fault !== '' || undefined}
              className={cn(INPUT, 'w-full pl-7')}
            />
          </div>
        </Field>
        <Field id="channel-make-about" label="about" hint={`optional. up to ${ABOUT_CAP} characters.`}>
          <input
            id="channel-make-about"
            value={about}
            onChange={(e) => setAbout(e.target.value)}
            maxLength={ABOUT_CAP}
            autoComplete="off"
            aria-describedby="channel-make-about-hint"
            className={cn(INPUT, 'w-full')}
          />
        </Field>
        {status && (
          <p id="channel-make-status" className="text-sm text-decrease">
            {status}
          </p>
        )}
        <div className="flex items-center justify-end gap-3">
          <button type="button" className="text-sm text-textTertiary" onClick={close}>
            cancel
          </button>
          <Button id="channel-make-submit" type="submit" variant="primary" className="px-4 py-2" disabled={!ok || sending}>
            {sending ? 'adding…' : 'add it'}
          </Button>
        </div>
      </form>
    </dialog>,
    document.body
  );
}

/** How long the pointer rests on a member before their card shows: a pause, not a pass down the roster. The sidebar's (Friends.tsx). */
const PEEK_MS = 200;

/**
 * One member of the roster: the face with the presence square on its corner (the sidebar's
 * way, docs/status.md; the word for a reader), the name, the crown on an owner (OwnerMark, the
 * owner role's name its tooltip), `live` on one whose camera is up, the roles they hold in
 * their colours. The word is the events socket's: room-atoms holds every name on the roster
 * while the room is up. The whole row is one link to their page, the sidebar's row's way, and
 * the pointer resting on it, or the focus landing in it, puts the person's card (PersonCard.tsx,
 * the sidebar's) beside the roster: the face with the word on it, the name, the frame while
 * they stream, their status. The row holds the name, the picture and the word; the status is
 * the card's one profile read.
 */
function Member({ member, live, ownerRole }: { member: GroupMember; live: boolean; ownerRole: string }) {
  const presence = useAtomValue(presenceOfAtom(member.name));
  const peek = usePeek(PEEK_MS);
  const show = (e: SyntheticEvent<HTMLElement>) => peek.show(e.currentTarget, e.currentTarget.closest('#group-roster'));
  return (
    <li
      data-member={member.name}
      data-owner={member.owner || undefined}
      data-presence={presence}
      className="flex"
      onPointerEnter={show}
      onPointerLeave={(e) => peek.leave(e.currentTarget)}
      onFocus={show}
      onBlur={peek.blur}
    >
      <Link
        to={`/watch/${encodeURIComponent(member.name)}`}
        // streaming: the page holds the player's box from its first paint (WatchPage.tsx)
        state={presence === 'streaming' ? { live: true } : undefined}
        // not draggable: the face must not lift off the row as a ghost link
        draggable={false}
        className="flex min-w-0 flex-1 items-center gap-2 border border-transparent outline-none hover:border-primaryStroke focus-visible:border-primaryBlue"
      >
        <span className="relative flex shrink-0">
          <Face name={member.name} version={member.avatar ?? null} className="h-8 w-8 shrink-0" />
          <PresenceSquare presence={presence} className="border-backgroundSecondary" />
          <span className="sr-only">{PRESENCE_WORD[presence]}</span>
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2">
            <span className="truncate font-semibold">{member.name}</span>
            {member.owner && <OwnerMark name={ownerRole} />}
            {timedOut(member) && (
              <Tooltip content={`timed out until ${untilWords(member.timeout ?? 0)}`}>
                <span role="img" aria-label={`timed out until ${untilWords(member.timeout ?? 0)}`} data-timed-out className="flex shrink-0 text-textTertiary">
                  <RiTimeLine aria-hidden size={14} />
                </span>
              </Tooltip>
            )}
            {live && <span className="text-xs uppercase text-primaryBlue">live</span>}
          </span>
          {member.roles.length > 0 && (
            <span className="flex flex-wrap gap-x-2 text-xs">
              {member.roles.map((role) => (
                <span key={role.id} style={{ color: role.color }}>
                  {role.name}
                </span>
              ))}
            </span>
          )}
        </span>
      </Link>
      {/* every member is a login, so the ✓ is theirs; the word is the row's, and the status the card asks for */}
      {peek.at && <PersonCard id={`roster-peek-${member.name}`} person={{ name: member.name, verified: true, avatar: member.avatar ?? null, presence }} at={peek.at} />}
    </li>
  );
}

/**
 * What the roster is matched on, from the words in the search box: the plain words, and the
 * name after `from:`, so the list narrows to who is being asked for as the name is typed. The
 * other filters (`has:image`, the days, the channel) are the lines' alone, and leave the list whole.
 */
function rosterQuery(query: string): string {
  return query
    .split(/\s+/)
    .map((word) => word.replace(/^from:/i, ''))
    .filter((word) => word && !/^(has|before|after|channel|in):/i.test(word))
    .join(' ')
    .toLowerCase();
}

/**
 * The right of the room, for everyone in it: who is in. The room's search box first, its own
 * row (`RoomSearch`): the words in it narrow the names and the roles under it as they are
 * typed (`rosterQuery`), and enter asks the group for them, so one box finds a member or a
 * line. The box completes `from:` with the members, each with their face, and `channel:` with
 * the channels this login sees. Then the heading with the count, and each member (`Member`),
 * owners first, then the group's order (room-atoms sorts). The api gives the list to anyone on
 * a public group and to members on a private one (docs/groups.md); a private group's guest
 * gets the box, the count and a word for the rest. The box and the heading stay put while the
 * list scrolls. A row is the way to the member's page, their card on hover (`Member`). Nothing
 * here acts on a member: what a power does is in the manage dialog, from the header.
 */
function Roster({ room }: { room: GroupRoom }) {
  const members = room.roster ?? [];
  const live = room.live ?? [];
  const input = useRef<HTMLInputElement | null>(null);
  const search = useChatSearch(input, undefined, {
    people: members.map((member) => ({ name: member.name, avatar: member.avatar ?? null })),
    channels: (room.channels ?? []).map((item) => item.name)
  });
  const q = rosterQuery(search.query);
  const shown = q ? members.filter((member) => member.name.toLowerCase().includes(q) || member.roles.some((role) => role.name.toLowerCase().includes(q))) : members;

  return (
    <aside
      id="group-roster"
      aria-label="members"
      className={cn('flex flex-col gap-3 border border-primaryStroke bg-backgroundSecondary p-4 text-sm', SIDE_INSET, ROSTER_HEIGHT)}
    >
      <RoomSearch search={search} input={input} />
      <h3 className="flex shrink-0 items-center gap-1 whitespace-nowrap text-xs font-semibold uppercase tracking-wider text-textTertiary">
        members <span className="font-normal normal-case tracking-normal">{room.members}</span>
      </h3>
      {!room.roster && (
        <p id="group-members-private" className="text-textTertiary">
          this group is private: who is in it is for its members.
        </p>
      )}
      {q && shown.length === 0 && (
        <p id="group-members-nobody" className="text-textTertiary">
          nobody by that name.
        </p>
      )}
      {/* no bar: it would take width from the rows. the padding under the last row is for its presence square, which hangs 4px below its face and would otherwise be 4px of scroll. its scroll is its own: the end of a long roster does not send the page to its other view */}
      <ul id="group-members" className="flex min-h-0 flex-col gap-2 overflow-y-auto overscroll-contain pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {shown.map((member) => (
          <Member key={member.name} member={member} live={live.includes(member.name)} ownerRole={ownerRoleOf(room)} />
        ))}
      </ul>
    </aside>
  );
}

interface ManageProps {
  server: string;
  room: GroupRoom;
  run: Run;
}

type ManageTab = 'about' | 'channels' | 'roles' | 'members' | 'bans' | 'delete';

/**
 * The rail of the manage dialog, in order and in groups, each tab with the power that shows
 * it. `about` is the about line and the listing (appearance), and for an owner the pictures
 * too; `channels` is their order, and add and delete (channels; and for a channel's maker
 * without the power, the delete of their own); `members` is for anyone who manages at all,
 * since every power does something to a member.
 */
const MANAGE_TABS: {
  id: ManageTab;
  label: string;
  group: string;
  icon: ReactNode;
  shown: (room: GroupRoom) => boolean;
}[] = [
  {
    id: 'about',
    label: 'about',
    group: 'the group',
    icon: <RiInformationLine aria-hidden size={18} />,
    shown: (room) => room.perms.appearance
  },
  {
    id: 'channels',
    label: 'channels',
    group: 'the group',
    icon: <RiHashtag aria-hidden size={18} />,
    shown: managesChannels
  },
  {
    id: 'roles',
    label: 'roles',
    group: 'the group',
    icon: <RiShieldStarLine aria-hidden size={18} />,
    shown: (room) => room.perms.roles
  },
  {
    id: 'members',
    label: 'members',
    group: 'people',
    icon: <RiGroupLine aria-hidden size={18} />,
    shown: (room) => manages(room)
  },
  {
    id: 'bans',
    label: 'bans',
    group: 'people',
    icon: <RiForbidLine aria-hidden size={18} />,
    shown: (room) => room.perms.ban
  },
  {
    id: 'delete',
    label: 'delete',
    group: 'owner',
    icon: <RiDeleteBinLine aria-hidden size={18} />,
    shown: (room) => room.owner
  }
];

// the rail's looks, the user modal's (UserModal.tsx): the mark under a tab in the phone strip, at its left in the rail
const RAIL_GROUP = 'hidden px-3 pb-1 pt-4 text-xs font-semibold uppercase tracking-wider text-textTertiary first:pt-0 sm:block';
const RAIL_TAB = cn(
  'flex shrink-0 items-center gap-2.5 whitespace-nowrap px-3 py-2 text-left font-semibold leading-tight transition-colors duration-150',
  'border-b-2 sm:w-full sm:border-b-0 sm:border-l-2',
  'focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-primaryBlue'
);
const RAIL_TAB_ON = 'border-primaryBlue bg-backgroundTertiary text-textPrimary';
const RAIL_TAB_OFF = 'border-transparent text-textSecondary hover:bg-backgroundTertiary/60 hover:text-textPrimary';
const RAIL_STEP: Record<string, number | undefined> = {
  ArrowDown: 1,
  ArrowRight: 1,
  ArrowUp: -1,
  ArrowLeft: -1
};

/**
 * What a power does, in a dialog over the room (`manage`, the gear in the header), laid out
 * like the user modal: a rail of tabs down the left, in groups (the group: about and the
 * listing, channels, roles; people: members, bans; owner: delete), and the open tab's pane on
 * the right. A tab shows for the power behind it, and the first one this login may see opens.
 * The pictures are an owner's: the top of `about` here, and the pictures themselves at the
 * top of the page; the channels are put in order here, and the list on the left follows.
 * Every call lands through the socket, for this page and every other one with the room open,
 * so the dialog reads the room the page does and follows it live. A native <dialog>: the
 * browser keeps focus in it, closes it on escape and hands focus back to the button that
 * opened it; a click on the backdrop closes it too. A refusal is said in the pane, since the
 * page is under the backdrop. `channel` is the one on screen: deleting it from here moves the
 * page to `general` first, so the room under the dialog does not turn into `no such channel`.
 */
function ManageDialog({ server, channel, room, me, onClose }: { server: string; channel: string; room: GroupRoom; me: string | null; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  /** The press that began this click was on the backdrop too: a text drag that ends outside is not a close. */
  const pressedBackdrop = useRef(false);
  const [error, setError] = useState('');
  const [picked, setPicked] = useState<ManageTab | null>(null);
  const words = groupWords(room);
  const tabs = MANAGE_TABS.filter((item) => item.shown(room));
  // the tab picked while it is still one this login may see, else the first that is: a power lost while this was open moves the pane
  const tab = tabs.find((item) => item.id === picked)?.id ?? tabs[0]?.id ?? null;
  // the tab moved without a pick (a power lost while this was open): the pane it lands on starts clean, as a picked one does.
  // a layout effect, so the last pane's refusal is cleared before the new pane is painted
  useLayoutEffect(() => setError(''), [tab]);

  /** The parent's `onClose` as of the last render: the layout effect runs once, and its cleanup tells the parent through this. */
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // A layout effect: its cleanup runs while the node is still in the document, which is when
  // close() hands focus back to the opener. Taken away while still open (the room dropped under
  // it: `me` changed and the page went back to its skeleton), the parent is told from here. The
  // `close` event that close() queues lands on a node react has already let go of, so the
  // element's onClose would not fire, `managing` would stay true, and this would open again by
  // itself when the room came back.
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    dialog.showModal();
    // the heading, not the first control: a screen reader hears what this is
    dialog.querySelector<HTMLElement>('#group-manage-title')?.focus();
    return () => {
      if (!dialog.open) return;
      dialog.close();
      onCloseRef.current();
    };
  }, []);

  // every way out goes through the element: close() restores focus, then fires `close`
  const close = () => dialogRef.current?.close();

  const run: Run = async (work) => {
    setError('');
    try {
      await work();
    } catch (err) {
      setError(messageOf(err));
    }
  };

  /** Another tab: its pane, and no refusal left over from the last one. */
  function pick(next: ManageTab) {
    setPicked(next);
    setError('');
  }

  /** Arrows walk the rail and show the tab under focus; home and end jump. The buttons carry tabIndex 0/-1 themselves. */
  function rove(e: KeyboardEvent<HTMLDivElement>) {
    const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    const i = buttons.indexOf(e.target as HTMLButtonElement);
    if (i < 0) return;
    const step = RAIL_STEP[e.key];
    const next = step !== undefined ? (i + step + buttons.length) % buttons.length : e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : -1;
    const target = tabs[next]; // rendered from `tabs`, so dom order and this order agree
    const button = buttons[next];
    if (next < 0 || !target || !button) return;
    e.preventDefault();
    pick(target.id);
    button.focus();
  }

  return (
    <dialog
      ref={dialogRef}
      id="group-manage"
      aria-labelledby="group-manage-title"
      onPointerDown={(e) => {
        pressedBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (pressedBackdrop.current && e.target === e.currentTarget) close();
      }}
      onClose={(event) => {
        // the delete asks in its own dialog, which closes itself. that close walks the react tree and would shut this too
        if (event.target !== event.currentTarget) return;
        onClose();
      }}
      // the dialog box is the panel: a click whose target is the dialog element landed on the backdrop.
      // a set height, not a cap: the rail and the pane fill it, and a change of tab does not move the box
      className={cn(
        'm-auto h-[min(680px,calc(100dvh-3rem))] w-[min(880px,calc(100vw-3rem))] overflow-hidden border border-primaryStroke bg-backgroundSecondary p-0 text-base text-textPrimary',
        'flex-col open:flex sm:flex-row backdrop:bg-black/60'
      )}
    >
      {/* the rail: the group at its head, then the tabs. a strip along the top on a phone */}
      <div className="flex shrink-0 flex-col border-b border-primaryStroke bg-background sm:w-52 sm:border-b-0 sm:border-r">
        <div className="hidden items-center gap-3 border-b border-primaryStroke px-3 py-3 sm:flex">
          <GroupMark name={server} color={room.color || '#5865f2'} icon={room.icon} className="h-9 w-9 text-base" />
          <span className="min-w-0">
            <span className="block truncate font-semibold leading-tight">{words.title}</span>
            <span className="block text-xs text-textTertiary">{words.tag ? `#${words.tag}` : 'manage'}</span>
          </span>
        </div>
        <div
          id="manage-tabs"
          role="tablist"
          aria-orientation="vertical"
          aria-label="sections"
          onKeyDown={rove}
          className="flex flex-row gap-1 overflow-x-auto p-2 sm:flex-col sm:gap-0 sm:overflow-visible"
        >
          {tabs.map((item, i) => {
            const on = item.id === tab;
            const before = tabs[i - 1];
            const newGroup = before === undefined || before.group !== item.group;
            return (
              <Fragment key={item.id}>
                {/* a tablist may hold only tabs, so the group words are decoration; the tab names carry the meaning */}
                {newGroup && (
                  <span aria-hidden className={RAIL_GROUP}>
                    {item.group}
                  </span>
                )}
                <button
                  id={`manage-tab-${item.id}`}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  aria-controls={on ? `manage-panel-${item.id}` : undefined}
                  tabIndex={on ? 0 : -1}
                  onClick={() => pick(item.id)}
                  className={cn(RAIL_TAB, on ? RAIL_TAB_ON : RAIL_TAB_OFF)}
                >
                  {item.icon}
                  {item.label}
                </button>
              </Fragment>
            );
          })}
        </div>
      </div>

      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        {/* pinned over the pane: the pane scrolls under it */}
        <Tooltip content="close" at="left">
          <button
            id="group-manage-close"
            type="button"
            aria-label="close"
            aria-keyshortcuts="Escape"
            onClick={close}
            className="absolute right-4 top-4 z-10 flex h-8 w-8 items-center justify-center border border-primaryStroke bg-backgroundSecondary text-textSecondary transition-colors duration-150 hover:border-primaryBlue hover:text-primaryBlue focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-primaryBlue"
          >
            <RiCloseLine aria-hidden size={20} />
          </button>
        </Tooltip>
        {/* keyed on the tab: a fresh pane starts at the top with its own form state */}
        <div
          key={tab ?? 'none'}
          id={tab ? `manage-panel-${tab}` : undefined}
          role={tab ? 'tabpanel' : undefined}
          aria-labelledby={tab ? `manage-tab-${tab}` : undefined}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5 [scrollbar-gutter:stable] sm:px-8 sm:py-6"
        >
          <h2 id="group-manage-title" tabIndex={-1} className="min-w-0 border-l-4 border-primaryBlue pl-3 pr-12 text-xl font-semibold leading-tight outline-none">
            {tab ?? 'manage'} <span className="font-normal text-textTertiary">· {words.title}</span>
          </h2>
          {/* always rendered: a live region announces only text that arrives after it exists */}
          <p id="group-manage-error" aria-live="polite" className="min-h-[1.5em] pt-3 text-sm text-decrease">
            {error}
          </p>
          <div className="pt-1 text-sm">
            {tab === null && (
              // the powers went while this was open: an owner took the role, or this login was put out
              <p className="text-textSecondary">you have no powers here now.</p>
            )}
            {tab === 'about' && (
              <div className="divide-y divide-primaryStroke">
                {ownsPictures(room) && <PicturesSection server={server} room={room} run={run} />}
                <AboutSection server={server} room={room} run={run} />
                <ListingSection server={server} room={room} run={run} />
              </div>
            )}
            {tab === 'channels' && <ChannelsSection server={server} channel={channel} room={room} run={run} />}
            {tab === 'roles' && <RolesSection server={server} room={room} run={run} />}
            {tab === 'members' && <MembersSection server={server} room={room} me={me} run={run} />}
            {tab === 'bans' && <BansSection server={server} room={room} run={run} />}
            {tab === 'delete' && <DeleteSection server={server} run={run} />}
          </div>
        </div>
      </div>
    </dialog>
  );
}

/**
 * The pictures, for an owner (ownsPictures): the group's picture, square, and its banner, one
 * row with a word over each, the picture on the left and the banner filling the rest. Each is
 * the click, the way it is on the page itself: the pointer over one greys it and puts a camera
 * on it, and the crop dialog, over this one, takes the file from there. The new version comes
 * back on the socket, here and at the top of the page alike. There is no remove.
 */
function PicturesSection({ server, room, run }: ManageProps) {
  const color = room.color || '#5865f2';
  const bannerSrc = groupImage(server, 'banner', room.banner);

  async function pick(file: File, kind: 'icon' | 'banner') {
    const jpeg = await cropPicture(file, kind === 'icon' ? GROUP_ICON : GROUP_BANNER);
    if (!jpeg) return;
    await run(() => (kind === 'icon' ? api.saveGroupIcon(server, jpeg) : api.saveGroupBanner(server, jpeg)));
  }

  return (
    <section id="manage-pictures" className="flex flex-wrap items-start gap-4 py-6 first:pt-0 last:pb-0">
      <div className="flex flex-col gap-2">
        <h3 className={SECTION_TITLE}>group image</h3>
        <div className="group/icon relative flex">
          <GroupMark id="manage-icon" name={server} color={color} icon={room.icon} className="h-24 w-24 border border-primaryStroke text-3xl" />
          <PicturePick
            id="manage-icon-pick"
            label={room.icon === null ? 'add a picture' : 'change picture'}
            reveal="group-hover/icon:opacity-100"
            className="inset-0"
            onPick={(file) => void pick(file, 'icon')}
          />
        </div>
      </div>
      {/* the banner takes the rest of the row, and drops under the picture when the row is too narrow for a strip */}
      <div className="flex min-w-48 flex-1 flex-col gap-2">
        <h3 className={SECTION_TITLE}>group banner</h3>
        <div id="manage-banner" className="group/banner relative h-24 overflow-hidden border border-primaryStroke" style={{ backgroundColor: color }}>
          {bannerSrc && <img src={bannerSrc} alt="" className="h-full w-full object-cover" />}
          <PicturePick
            id="manage-banner-pick"
            label={room.banner === null ? 'add a banner' : 'change banner'}
            reveal="group-hover/banner:opacity-100"
            className="inset-0"
            onPick={(file) => void pick(file, 'banner')}
          />
        </div>
      </div>
    </section>
  );
}

function AboutSection({ server, room, run }: ManageProps) {
  // the about box: what is typed, over the line it started from. the line changing under it
  // (saved here, or by another owner, which the socket brings) starts the box over from the new one
  const [draft, setDraft] = useState({ base: room.about, text: room.about });
  const about = draft.base === room.about ? draft.text : room.about;
  return (
    <Section title="about" description="the line under the name, for anyone who opens the group. up to 200 characters.">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => api.saveGroupAbout(server, about.trim()));
        }}
      >
        <input
          id="group-about"
          value={about}
          onChange={(e) => setDraft({ base: room.about, text: e.target.value })}
          maxLength={200}
          aria-label="about"
          className={INPUT}
        />
        <button type="submit" className="text-sm font-semibold text-primaryBlue">
          save
        </button>
      </form>
    </Section>
  );
}

/**
 * Public or private: whether the group is on the lists (home, `/groups`, `GET /api/groups`)
 * for someone not in it. The create dialog asks the same; this is where it is changed after.
 * The new word arrives on the socket (`access`), so the pressed one follows the room, not the click.
 */
function ListingSection({ server, room, run }: ManageProps) {
  const isPublic = room.public !== false;
  return (
    <Section title="listing" description="public is on the lists for anyone. private is off them: someone with the address can still open it and join.">
      <p className="flex flex-wrap items-center gap-2">
        <button
          id="room-public"
          type="button"
          aria-pressed={isPublic}
          className={cn('text-sm font-semibold', isPublic ? 'text-primaryBlue' : 'text-textTertiary hover:text-textPrimary')}
          onClick={() => void run(() => api.setGroupPublic(server, true))}
        >
          public
        </button>
        <button
          id="room-private"
          type="button"
          aria-pressed={!isPublic}
          className={cn('text-sm font-semibold', !isPublic ? 'text-primaryBlue' : 'text-textTertiary hover:text-textPrimary')}
          onClick={() => void run(() => api.setGroupPublic(server, false))}
        >
          private
        </button>
      </p>
    </Section>
  );
}

/**
 * Every member with what a power may do to them: give or take a role, kick, ban, remove owner.
 * For an owner, `transfer ownership` on a member who is not one: it asks first, in a dialog of
 * its own over this one, and a yes makes them an owner and this login no longer one, in the
 * api's one call (`transferOwnership`); the facts move the crowns, and this login's room is
 * asked again, since what it may do changed.
 */
function MembersSection({ server, room, me, run }: ManageProps & { me: string | null }) {
  /** The member the group is about to be handed to, while the question is up. */
  const [handing, setHanding] = useState<string | null>(null);
  const members = room.roster ?? [];
  const owners = members.filter((member) => member.owner).length;
  const order = room.member_order === 'newest' || room.member_order === 'oldest' ? room.member_order : 'name';
  /** The powers a role carries, by id: what the roster's held roles do not say. */
  const permsOf = (id: string) => room.roles.find((role) => role.id === id)?.perms ?? NO_PERMS;

  return (
    <Section title="members" description="who is in, owners first.">
      {room.perms.appearance && room.member_order !== undefined && (
        <p className="flex flex-wrap items-center gap-2">
          <span className="text-textTertiary">then by</span>
          {ORDERS.map((item) => {
            const on = order === item.id;
            return (
              <button
                key={item.id}
                id={`member-order-${item.id}`}
                type="button"
                aria-pressed={on}
                className={cn('text-sm font-semibold', on ? 'text-primaryBlue' : 'text-textTertiary hover:text-textPrimary')}
                onClick={() => void run(() => api.setMemberOrder(server, item.id))}
              >
                {item.label}
              </button>
            );
          })}
        </p>
      )}
      <ul id="manage-members" className="flex flex-col gap-2">
        {members.map((member) => {
          // a role cannot touch an owner, unless an owner is the one giving or taking
          const touch = room.perms.roles && (!member.owner || room.owner);
          const offer = touch ? room.roles.filter((role) => !member.roles.some((held) => held.id === role.id) && reaches(room, role.perms)) : [];
          // not yourself; an owner only by an owner, and never the last one
          const removable = member.name !== me && (!member.owner || (room.owner && owners > 1));
          // an owner hands the group to a member who is not one
          const handable = room.owner && !member.owner && member.name !== me;
          // the kick power times a member out, and lifts it; an owner only by an owner, like a kick
          const quiet = timedOut(member);
          const acts = handable || (removable && (room.perms.kick || room.perms.ban || (room.owner && member.owner)));
          return (
            <li
              key={member.name}
              data-member={member.name}
              data-owner={member.owner || undefined}
              className="flex items-start gap-2 border border-primaryStroke px-2 py-1.5"
            >
              <Face name={member.name} version={member.avatar ?? null} className="h-8 w-8 shrink-0" />
              <div className="min-w-0 flex-1">
                {/* the roles they hold, the owner role first as the crown and its name, each a word in its colour with its take; then the plus, for the ones to give */}
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{member.name}</span>
                  {member.owner && <OwnerMark name={ownerRoleOf(room)} words size={12} />}
                  {member.roles.map((role) => (
                    <span key={role.id} data-held={role.name} className="flex items-center text-xs" style={{ color: role.color }}>
                      {role.name}
                      {touch && reaches(room, permsOf(role.id)) && (
                        <button
                          type="button"
                          className="ml-1 text-textTertiary hover:text-textPrimary"
                          aria-label={`take ${role.name} from ${member.name}`}
                          onClick={() => void run(() => api.takeRole(server, role.id, member.name))}
                        >
                          ×
                        </button>
                      )}
                    </span>
                  ))}
                  <HoverMenu
                    label={`give ${member.name} a role`}
                    items={offer.map((role) => ({ key: role.id, label: role.name, color: role.color }))}
                    onPick={(id) => void run(() => api.giveRole(server, id, member.name))}
                    className="flex h-5 w-5 shrink-0 items-center justify-center border border-transparent text-textTertiary hover:border-primaryStroke hover:text-textPrimary focus-visible:border-primaryBlue focus-visible:outline-none"
                  >
                    <RiAddLine aria-hidden size={14} />
                  </HoverMenu>
                </div>
                {acts && (
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    {room.perms.kick && removable && (
                      <button type="button" className="text-textTertiary" onClick={() => void run(() => api.kickMember(server, member.name))}>
                        kick
                      </button>
                    )}
                    {room.perms.kick &&
                      removable &&
                      (quiet ? (
                        <span data-timed-out className="flex items-center gap-2 text-decrease">
                          timed out until {untilWords(member.timeout ?? 0)}
                          <button
                            id={`timeout-lift-${member.name}`}
                            type="button"
                            className="text-textTertiary hover:text-textPrimary"
                            onClick={() => void run(() => api.liftTimeout(server, member.name))}
                          >
                            lift
                          </button>
                        </span>
                      ) : (
                        <HoverMenu
                          label={`time ${member.name} out`}
                          items={TIMEOUTS}
                          onPick={(seconds) => void run(() => api.timeoutMember(server, member.name, Number(seconds)))}
                          className="text-textTertiary hover:text-textPrimary focus-visible:text-primaryBlue focus-visible:outline-none"
                        >
                          time out
                        </HoverMenu>
                      ))}
                    {room.perms.ban && removable && (
                      <button type="button" className="text-decrease" onClick={() => void run(() => api.banMember(server, member.name, ''))}>
                        ban
                      </button>
                    )}
                    {room.owner && member.owner && removable && (
                      <button type="button" className="text-textTertiary" onClick={() => void run(() => api.revokeOwner(server, member.name))}>
                        remove owner
                      </button>
                    )}
                    {handable && (
                      <button id={`transfer-owner-${member.name}`} type="button" className="text-textTertiary" onClick={() => setHanding(member.name)}>
                        transfer ownership
                      </button>
                    )}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {handing && (
        <ConfirmDialog
          id={`transfer-owner-${handing}-confirm`}
          title={`transfer ownership to ${handing}?`}
          message={`${handing} becomes the ${ownerRoleOf(room)} of the group, and you stop being one. you keep your roles and stay in the group. only they can hand it back.`}
          yes="yes, transfer"
          onYes={() => {
            const name = handing;
            setHanding(null);
            void run(() => api.transferOwnership(server, name));
          }}
          onNo={() => setHanding(null)}
        />
      )}
    </Section>
  );
}

function BansSection({ server, room, run }: ManageProps) {
  const [name, setName] = useState('');
  const [reason, setReason] = useState('');
  const bans = room.bans ?? [];
  return (
    <Section title="bans" description="a banned name is out, and cannot join again until it is unbanned.">
      <form
        className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-center"
        onSubmit={(e) => {
          e.preventDefault();
          const who = name.trim().toLowerCase();
          if (!who) return;
          void run(async () => {
            await api.banMember(server, who, reason.trim());
            setName('');
            setReason('');
          });
        }}
      >
        <input id="ban-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="ban a name" aria-label="ban a name" className={INPUT} />
        <input id="ban-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="reason, optional" aria-label="ban reason" className={INPUT} />
        <button id="ban-submit" type="submit" className="justify-self-start text-sm font-semibold text-decrease disabled:opacity-40" disabled={!name.trim()}>
          ban
        </button>
      </form>
      {bans.length === 0 ? (
        <p className="text-textTertiary">nobody is banned.</p>
      ) : (
        <ul id="group-bans" className="flex flex-col gap-1">
          {bans.map((ban) => (
            <li key={ban.name} className="flex items-center gap-2">
              <span className="font-semibold">{ban.name}</span>
              {ban.reason && <span className="truncate text-textTertiary">{ban.reason}</span>}
              <button type="button" className="ml-auto text-textTertiary" onClick={() => void run(() => api.unbanMember(server, ban.name))}>
                unban
              </button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

/** `name` moved to index `to` in `order` (held to the ends): the order that leaves. The same order when it is not there, or already at `to`. */
function movedTo(order: string[], name: string, to: number): string[] {
  const from = order.indexOf(name);
  if (from < 0) return order;
  const at = Math.max(0, Math.min(order.length - 1, to));
  if (at === from) return order;
  const next = order.filter((item) => item !== name);
  next.splice(at, 0, name);
  return next;
}

/**
 * A channel's name on its row of the channels tab and, within reach, the way to change it: a
 * pencil beside the name (up while the pointer or the keyboard is on the name) opens the name
 * as a box in its own place, typed to the name rule like the add dialog's. Enter puts the new
 * name; escape leaves the old one; the box losing focus puts a name that passes and leaves one
 * that does not. Enter on a name that cannot be keeps the box, with the fault where the about
 * line was. The row keeps its shape: the box is the name's size, with a stroke under it.
 */
function ChannelName({ item, channels, editable, onRename }: { item: Channel; channels: Channel[]; editable: boolean; onRename: (to: string) => void }) {
  const { name, about } = item;
  /** What the box holds while it is open. Null: the name is a word. */
  const [draft, setDraft] = useState<string | null>(null);
  const box = useRef<HTMLInputElement | null>(null);
  /** The box was closed by a key: the blur that may follow its unmount puts nothing. */
  const closed = useRef(false);
  const editing = draft !== null;
  const fault = editing && draft !== name ? channelNameFault(draft, channels) : '';
  const ok = editing && draft !== name && isValidName(draft) && fault === '';

  useLayoutEffect(() => {
    if (!editing) return;
    closed.current = false;
    box.current?.focus();
    box.current?.select();
  }, [editing]);

  /** The box closes; with `put`, the name in it goes to the api when it can. */
  function finish(put: boolean) {
    if (closed.current) return;
    closed.current = true;
    if (put && ok && draft) onRename(draft);
    setDraft(null);
  }

  return (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      {editing ? (
        <span className="flex min-w-0 items-center font-semibold">
          <span aria-hidden>#</span>
          <input
            ref={box}
            id={`channel-name-${name}`}
            value={draft}
            onChange={(e) =>
              setDraft(
                e.target.value
                  .toLowerCase()
                  .replace(/[^a-z0-9_-]/g, '')
                  .slice(0, 32)
              )
            }
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (ok) finish(true);
                else if (draft === name) finish(false);
              } else if (e.key === 'Escape') {
                // the manage dialog is a <dialog>: left to the browser, escape closes it, box and all
                e.preventDefault();
                e.stopPropagation();
                finish(false);
              }
            }}
            onBlur={() => finish(true)}
            aria-label={`rename #${name}`}
            aria-invalid={fault !== '' || undefined}
            maxLength={32}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            className={cn(
              'min-w-0 flex-1 border-0 border-b bg-transparent p-0 font-semibold text-textPrimary outline-none',
              fault ? 'border-decrease' : 'border-primaryBlue'
            )}
          />
        </span>
      ) : (
        <span className="group/name flex min-w-0 items-center gap-1.5">
          <span className="truncate border-b border-transparent font-semibold">#{name}</span>
          {editable && (
            <Tooltip content="rename">
              <button
                id={`channel-rename-${name}`}
                type="button"
                aria-label={`rename #${name}`}
                onClick={() => setDraft(name)}
                className={cn('flex shrink-0 text-textTertiary hover:text-textPrimary focus-visible:text-primaryBlue focus-visible:outline-none', PENCIL_HIDDEN)}
              >
                <RiPencilLine aria-hidden size={14} />
              </button>
            </Tooltip>
          )}
        </span>
      )}
      {fault ? <span className="text-xs text-decrease">{fault}</span> : about && <span className="truncate text-xs text-textTertiary">{about}</span>}
    </span>
  );
}

/**
 * The channels in their order, each a row: a handle to drag it by (the arrow keys on the
 * handle do the same, a row a press), the name with its pencil (ChannelName), the line about
 * it, and `delete` (never on `general`). A press moves the row at once and tells the api
 * (setChannelOrder, room-atoms); a drag moves it as the pointer goes and tells the api once,
 * on the drop. A rename asks the api first and lands when it says yes (renameChannel): the
 * list on the left follows under the backdrop, as does every other room open, and a page on
 * the channel moves to its new address. `add channel` opens the dialog the row under the list
 * opens. Deleting the channel on screen moves the page to `general` first, so the room under
 * the dialog stays a room. The order and the add are the channels power's: without it this
 * login is here for a channel they made (managesChannels), the rows are read, and the pencil
 * and `delete` are on theirs.
 */
function ChannelsSection({ server, channel, room, run }: ManageProps & { channel: string }) {
  const navigate = useNavigate();
  const channels = room.channels ?? [];
  const names = channels.map((item) => item.name);
  const byName = new Map(channels.map((item) => [item.name, item]));
  const orders = room.perms.channels;
  const [adding, setAdding] = useState(false);
  const [sure, setSure] = useState<string | null>(null);
  /** The order while a row is dragged: the one the drag began from, with the row where the pointer has it. Null between drags. */
  const [draft, setDraft] = useState<string[] | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const rows = useRef<HTMLUListElement | null>(null);
  const drag = useRef<{
    pointerId: number;
    name: string;
    y: number;
    from: number;
    pitch: number;
    start: string[];
    now: string[];
  } | null>(null);
  const full = channels.length >= CHANNEL_CAP;
  /** `list` over the room's channels: a channel gone since is dropped, one added since goes after, as the api puts it. */
  const settle = (list: string[]) => [...list.filter((name) => byName.has(name)), ...names.filter((name) => !list.includes(name))];
  // the rows: the draft while a row is dragged, else the room's
  const order = draft ? settle(draft) : names;

  /** The channels in `next`: moved on screen now, the api told. Nothing to tell when nothing moved. */
  function put(next: string[]) {
    if (next.length === names.length && next.every((name, i) => name === names[i])) return;
    void run(() => setChannelOrder(server, next));
  }

  function startDrag(e: PointerEvent<HTMLButtonElement>, name: string, from: number) {
    // the primary button only, and one drag at a time: a second finger on another handle takes nothing over
    if (e.button !== 0 || drag.current) return;
    const ul = rows.current;
    const items = ul ? Array.from(ul.children) : [];
    const first = items[0]?.getBoundingClientRect();
    const second = items[1]?.getBoundingClientRect();
    if (!ul || !first) return;
    e.preventDefault();
    // the list holds the pointer, not the handle: a row dragged is taken out of the document and put back
    // by the reorder, and the browser lets go of a node that leaves. the drag ends with the capture, whatever ends it
    ul.setPointerCapture(e.pointerId);
    // a row and the gap after it: the distance between two rows' tops, or the one row's height when there is one
    drag.current = {
      pointerId: e.pointerId,
      name,
      y: e.clientY,
      from,
      pitch: second ? second.top - first.top : first.height,
      start: order,
      now: order
    };
    setDragging(name);
  }
  function moveDrag(e: PointerEvent<HTMLUListElement>) {
    const d = drag.current;
    // the drag is the pointer's that began it: another finger resting on the list neither steers nor ends it
    if (!d || e.pointerId !== d.pointerId) return;
    d.now = movedTo(d.start, d.name, d.from + Math.round((e.clientY - d.y) / d.pitch));
    setDraft(d.now);
  }
  function endDrag(e: PointerEvent<HTMLUListElement>) {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    drag.current = null;
    setDragging(null);
    // the drop: the room moves to this order at once (room-atoms), so the draft can go in the same breath
    setDraft(null);
    put(settle(d.now));
  }
  function keyMove(e: KeyboardEvent<HTMLButtonElement>, name: string, at: number) {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    put(movedTo(order, name, at + (e.key === 'ArrowUp' ? -1 : 1)));
  }

  async function remove(name: string) {
    await run(async () => {
      await api.deleteChannel(server, name);
      if (name === channel) navigate(`/groups/${server}`);
    });
  }

  return (
    <Section
      title="channels"
      description={`${channels.length} of ${CHANNEL_CAP}, top to bottom as the list shows them. ${
        orders
          ? 'drag a row to move it. the pencil by a name changes it. general stays.'
          : 'the channels power moves and adds them; the ones you made are yours to rename and delete.'
      }`}
    >
      <ul
        id="manage-channels"
        ref={rows}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        className="flex flex-col gap-2"
      >
        {order.map((name, i) => {
          const item = byName.get(name);
          if (!item) return null;
          const held = dragging === name;
          return (
            <li
              key={name}
              data-channel={name}
              className={cn(
                'flex items-center gap-3 border bg-background px-3 py-2 transition-[border-color] duration-150',
                held ? 'border-primaryBlue' : 'border-primaryStroke'
              )}
            >
              {orders && (
                <Tooltip content={held ? null : 'drag to move'}>
                  <button
                    id={`channel-drag-${name}`}
                    type="button"
                    aria-label={`move #${name}: drag, or the arrow keys`}
                    aria-keyshortcuts="ArrowUp ArrowDown"
                    onPointerDown={(e) => startDrag(e, name, i)}
                    onKeyDown={(e) => keyMove(e, name, i)}
                    className={cn(
                      'shrink-0 touch-none select-none border border-transparent p-0.5 text-textTertiary hover:border-primaryStroke hover:text-textSecondary focus-visible:border-primaryBlue focus-visible:outline-none',
                      held ? 'cursor-grabbing' : 'cursor-grab'
                    )}
                  >
                    <RiDraggable aria-hidden size={18} />
                  </button>
                </Tooltip>
              )}
              {/* the api's rename rule is delete's: who made it, or the channels power, and never general */}
              <ChannelName item={item} channels={channels} editable={item.can_delete} onRename={(to) => void run(() => renameChannel(server, name, to))} />
              <KeptMark roles={keptTo(room, name)} />
              <CooldownMark item={item} canSet={orders} onPick={(seconds) => void run(() => api.setChannelCooldown(server, name, seconds))} />
              {item.can_delete && (
                <button id={`channel-remove-${name}`} type="button" className="shrink-0 text-sm text-decrease" onClick={() => setSure(name)}>
                  delete
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {orders && full && <p className="text-textTertiary">{CHANNEL_CAP} channels is the cap. delete one to add another.</p>}
      {orders && !full && (
        <button
          id="manage-channel-add"
          type="button"
          aria-haspopup="dialog"
          className="self-start text-sm font-semibold text-primaryBlue"
          onClick={() => setAdding(true)}
        >
          add channel
        </button>
      )}
      {adding && <AddChannelDialog server={server} channels={channels} onClose={() => setAdding(false)} />}
      {sure && (
        <ConfirmDialog
          id={`manage-channel-delete-${sure}`}
          title={`delete #${sure}?`}
          message="the channel goes."
          yes="yes, delete"
          onYes={() => {
            const name = sure;
            setSure(null);
            void remove(name);
          }}
          onNo={() => setSure(null)}
        />
      )}
    </Section>
  );
}

/** A role as it is being changed in place: the id it is known by, and what `save` puts. */
interface RoleDraft {
  id: string;
  name: string;
  color: string;
  perms: RolePerms;
  /** The channels kept to it, by name. */
  channels: string[];
  /** Seconds between its holders' lines; 0 none. */
  cooldown: number;
}

/** What a new role is called: `new role`, or the first of `new role 2`, `new role 3`, … that no role here has, so the add never collides. */
function freshRoleName(roles: GroupRole[]): string {
  const taken = new Set(roles.map((role) => role.name.toLowerCase()));
  if (!taken.has('new role')) return 'new role';
  let n = 2;
  while (taken.has(`new role ${n}`)) n += 1;
  return `new role ${n}`;
}

/** The words for a role in its row: the powers it carries (or `no powers`), the channels kept to it when there are any, and its cooldown when it has one. */
function roleWords(role: GroupRole): string {
  const words = [
    POWERS.filter((power) => role.perms[power.key])
      .map((power) => power.label)
      .join(', ') || 'no powers'
  ];
  const kept = role.channels ?? [];
  const cooldown = role.cooldown ?? 0;
  if (kept.length > 0) words.push(`keeps ${kept.map((name) => `#${name}`).join(', ')}`);
  if (cooldown > 0) words.push(`cooldown ${cooldownWords(cooldown)}`);
  return words.join(' · ');
}

/**
 * The roles, each a row: the name in its colour, the powers it carries and the channels kept
 * to it. A row within reach is the click: it opens in place as the name, the colour, the
 * powers, the cooldown and the channels, with save, cancel and delete; one is open at a time.
 * The channels (docs/groups.md): every channel but `general` as a word, pressed when the
 * channel is kept to this role, and then seen by its holders, the roles that also keep it, the
 * owners and the channels power, and by nobody else; a channel no role keeps is everyone's.
 * Who sees it as the draft stands is the word's tooltip. `add role` makes one right away, called `new role` (numbered when
 * that is taken), and opens it with the name selected, so what is typed next is its name. A
 * role is known by its id, not its name: a rename is a save like any other, and the open row
 * stays on its role whatever the socket says of it meanwhile; a role deleted under it closes it.
 */
function RolesSection({ server, room, run }: ManageProps) {
  const [draft, setDraft] = useState<RoleDraft | null>(null);
  /** The owner role's name as it is being changed; null while that row is closed. One row is open at a time, this one or a custom role's. */
  const [ownerDraft, setOwnerDraft] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState(false);
  /** The name box that has had its open-time select. A later focus of the same box (a click into the word) edits in place; a role opened is a new box. */
  const selected = useRef<HTMLInputElement | null>(null);
  // a power this login lacks is one it cannot put on a role; an owner and a site admin lack none
  const short = POWERS.filter((power) => !room.perms[power.key]);
  const full = room.roles.length >= ROLE_CAP;
  const ownerRole = ownerRoleOf(room);
  // the row open in place: the draft, while the role it is of is still there
  const open = draft !== null && room.roles.some((role) => role.id === draft.id) ? draft : null;
  // the channels a role can be given: the ones this login sees, general apart, since general is everyone's
  const keepable = (room.channels ?? []).filter((item) => item.name !== 'general');

  /** A role now, so it has an id to be known by, then open with the name selected. */
  async function add() {
    setAdding(true);
    try {
      await run(async () => {
        const made = await api.createRole(server, {
          name: freshRoleName(room.roles),
          color: COLORS[0],
          perms: NO_PERMS,
          channels: [],
          cooldown: 0
        });
        setOwnerDraft(null);
        setDraft({
          id: made.id,
          name: made.name,
          color: made.color,
          perms: made.perms,
          channels: made.channels ?? [],
          cooldown: made.cooldown ?? 0
        });
      });
    } finally {
      setAdding(false);
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!open || !open.name.trim()) return;
    await run(async () => {
      await api.saveRole(server, open.id, {
        name: open.name.trim(),
        color: open.color,
        perms: open.perms,
        channels: open.channels,
        cooldown: open.cooldown
      });
      setDraft(null);
    });
  }

  /** The owner role's new name. The fact brings it to every room open, this one included. */
  async function saveOwner(e: FormEvent) {
    e.preventDefault();
    if (ownerDraft === null || !ownerDraft.trim()) return;
    await run(async () => {
      await api.renameOwnerRole(server, ownerDraft.trim());
      setOwnerDraft(null);
    });
  }

  /** Who sees `channel` as the draft stands: `everyone`, or `only` the roles that keep it, this one first. */
  function seers(channel: string): string {
    const ticked = open?.channels.includes(channel) ?? false;
    const others = room.roles.filter((role) => role.id !== open?.id && (role.channels ?? []).includes(channel)).map((role) => role.name);
    const names = ticked ? ['this role', ...others] : others;
    return names.length > 0 ? `only ${names.join(', ')}` : 'everyone';
  }

  /** The open role, deleted. One call at a time, as `add`: a second click while the first is out would be a 404 said in red after the role is gone. */
  async function remove() {
    if (!open || removing) return;
    setRemoving(true);
    try {
      await run(async () => {
        await api.deleteRole(server, open.id);
        setDraft(null);
      });
    } finally {
      setRemoving(false);
    }
  }

  return (
    <Section
      title="roles"
      description={`${room.roles.length} of ${ROLE_CAP}. a name, a colour and the powers it carries; click one to change or delete it. ${
        short.length > 0 ? 'a role carries only the powers you hold. ' : ''
      }only an owner can hand the group on, or change the pictures.`}
    >
      <ul id="group-roles" className="flex flex-col gap-1">
        {/* the owner role first: every power, every channel, not a row of the api's roles. an owner renames it, nothing else changes */}
        <li data-role={ownerRole} data-owner data-open={ownerDraft !== null || undefined} className={cn(ownerDraft !== null && 'border border-primaryStroke p-3')}>
          {ownerDraft !== null ? (
            <form id="owner-role-form" onSubmit={(e) => void saveOwner(e)} className="flex flex-col gap-3">
              <input
                id="owner-role-name"
                value={ownerDraft}
                onChange={(e) => setOwnerDraft(e.target.value)}
                placeholder="owner role name"
                maxLength={32}
                aria-label="owner role name"
                autoFocus
                onFocus={(e) => e.currentTarget.select()}
                className={INPUT}
              />
              <div role="group" aria-label="powers" className="flex flex-wrap items-center gap-1">
                <span className="flex h-6 w-6 items-center justify-center text-primaryBlue">
                  <RiVipCrownLine aria-hidden size={16} />
                </span>
                <span aria-hidden className="mx-2 h-6 w-px bg-primaryStroke" />
                {POWERS.map((power) => (
                  <Tooltip key={power.key} content={`${power.label}: an owner's`}>
                    <button
                      id={`owner-role-perm-${power.key}`}
                      type="button"
                      aria-label={power.label}
                      aria-pressed
                      aria-disabled
                      className="flex h-6 w-6 cursor-default items-center justify-center text-primaryBlue"
                    >
                      {power.icon}
                    </button>
                  </Tooltip>
                ))}
              </div>
              <p className="text-xs text-textTertiary">
                an owner has every power and sees every channel. only the name changes here; who owns the group is the members tab.
              </p>
              <div className="flex items-center gap-3">
                <button id="owner-role-save" type="submit" className="text-sm font-semibold text-primaryBlue disabled:opacity-40" disabled={!ownerDraft.trim()}>
                  save
                </button>
                <button id="owner-role-cancel" type="button" className="text-sm text-textTertiary" onClick={() => setOwnerDraft(null)}>
                  cancel
                </button>
              </div>
            </form>
          ) : room.owner ? (
            <button
              type="button"
              className="flex w-full items-center gap-2 px-2 py-1 text-left hover:bg-primaryStroke/20"
              onClick={() => {
                setDraft(null);
                setOwnerDraft(ownerRole);
              }}
            >
              <span className="flex items-center gap-1.5 font-semibold text-primaryBlue">
                <RiVipCrownLine aria-hidden size={14} />
                {ownerRole}
              </span>
              <span className="truncate text-xs text-textTertiary">every power · sees every channel</span>
            </button>
          ) : (
            <span className="flex items-center gap-2 px-2 py-1">
              <span className="flex items-center gap-1.5 font-semibold text-primaryBlue">
                <RiVipCrownLine aria-hidden size={14} />
                {ownerRole}
              </span>
              <span className="truncate text-xs text-textTertiary">every power · sees every channel</span>
            </span>
          )}
        </li>
        {room.roles.map((role) => {
          // a role past this login's reach is read, not changed
          const within = reaches(room, role.perms);
          if (open?.id === role.id) {
            // and written only while the role as it is and as it would be are both within reach, the api's rule for a save and a delete:
            // a power taken from this login mid-edit greys save and delete and leaves the row open, with cancel the way out
            const mayWrite = within && reaches(room, open.perms);
            return (
              <li key={role.id} data-role={role.name} data-open className="border border-primaryStroke p-3">
                <form id="role-form" onSubmit={(e) => void save(e)} className="flex flex-col gap-3">
                  <input
                    id="role-name"
                    value={open.name}
                    onChange={(e) => setDraft({ ...open, name: e.target.value })}
                    placeholder="role name"
                    maxLength={32}
                    aria-label="role name"
                    autoFocus
                    onFocus={(e) => {
                      if (selected.current === e.currentTarget) return;
                      selected.current = e.currentTarget;
                      e.currentTarget.select();
                    }}
                    className={INPUT}
                  />
                  {/* one row: the colour, a rule, then the powers as icons. a power is a pressed icon (blue), the word its tooltip */}
                  <div className="flex flex-wrap items-center gap-1">
                    <div role="group" aria-label="colour" className="flex items-center gap-1">
                      {COLORS.map((swatch) => (
                        <button
                          key={swatch}
                          type="button"
                          aria-label={swatch}
                          aria-pressed={swatch === open.color}
                          onClick={() => setDraft({ ...open, color: swatch })}
                          style={{ backgroundColor: swatch }}
                          className={cn('h-6 w-6 border-2', swatch === open.color ? 'border-textPrimary' : 'border-transparent')}
                        />
                      ))}
                    </div>
                    <span aria-hidden className="mx-2 h-6 w-px bg-primaryStroke" />
                    <div role="group" aria-label="powers" className="flex items-center gap-1">
                      {POWERS.map((power) => {
                        const on = open.perms[power.key];
                        // a power this login lacks is not its to give: greyed, and the tooltip says so
                        const mine = room.perms[power.key];
                        return (
                          <Tooltip key={power.key} content={mine ? power.label : `${power.label}: not yours to give`}>
                            <button
                              id={`role-perm-${power.key}`}
                              type="button"
                              aria-label={power.label}
                              aria-pressed={on}
                              aria-disabled={!mine || undefined}
                              onClick={() =>
                                mine &&
                                setDraft({
                                  ...open,
                                  perms: { ...open.perms, [power.key]: !on }
                                })
                              }
                              className={cn(
                                'flex h-6 w-6 items-center justify-center border border-transparent focus-visible:border-primaryBlue focus-visible:outline-none',
                                !mine ? 'cursor-default opacity-40' : on ? 'text-primaryBlue' : 'text-textTertiary hover:text-textPrimary'
                              )}
                            >
                              {power.icon}
                            </button>
                          </Tooltip>
                        );
                      })}
                    </div>
                  </div>
                  {/* the cooldown: seconds between its holders' lines, as pressed words; off unless a role says otherwise */}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="text-sm font-semibold text-textSecondary">cooldown</span>
                    {(COOLDOWNS.includes(open.cooldown) ? COOLDOWNS : [...COOLDOWNS, open.cooldown].sort((a, b) => a - b)).map((seconds) => (
                      <button
                        key={seconds}
                        id={`role-cooldown-${seconds}`}
                        type="button"
                        aria-pressed={open.cooldown === seconds}
                        onClick={() => setDraft({ ...open, cooldown: seconds })}
                        className={cn('text-sm font-semibold', open.cooldown === seconds ? 'text-primaryBlue' : 'text-textTertiary hover:text-textPrimary')}
                      >
                        {cooldownWords(seconds)}
                      </button>
                    ))}
                  </div>
                  {/* the channels kept to this role: each a word, pressed (blue) when kept; who sees it as the draft stands is the tooltip */}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="text-sm font-semibold text-textSecondary">channels</span>
                    {keepable.length === 0 ? (
                      <span className="text-xs text-textTertiary">only #general so far</span>
                    ) : (
                      keepable.map((item) => {
                        const kept = open.channels.includes(item.name);
                        return (
                          <Tooltip key={item.name} content={seers(item.name)}>
                            <button
                              id={`role-channel-${item.name}`}
                              type="button"
                              aria-pressed={kept}
                              aria-label={`#${item.name}: ${seers(item.name)}`}
                              onClick={() => setDraft({ ...open, channels: kept ? open.channels.filter((name) => name !== item.name) : [...open.channels, item.name] })}
                              className={cn('text-sm font-semibold', kept ? 'text-primaryBlue' : 'text-textTertiary hover:text-textPrimary')}
                            >
                              #{item.name}
                            </button>
                          </Tooltip>
                        );
                      })
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <button
                      id="role-save"
                      type="submit"
                      className="text-sm font-semibold text-primaryBlue disabled:opacity-40"
                      disabled={!open.name.trim() || !mayWrite}
                    >
                      save
                    </button>
                    <button id="role-cancel" type="button" className="text-sm text-textTertiary" onClick={() => setDraft(null)}>
                      cancel
                    </button>
                    <button
                      id="role-delete"
                      type="button"
                      className="ml-auto text-sm text-decrease disabled:opacity-40"
                      disabled={removing || !mayWrite}
                      onClick={() => void remove()}
                    >
                      delete
                    </button>
                  </div>
                </form>
              </li>
            );
          }
          return (
            <li key={role.id} data-role={role.name} data-reach={within || undefined}>
              {within ? (
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-2 py-1 text-left hover:bg-primaryStroke/20"
                  onClick={() => {
                    setOwnerDraft(null);
                    setDraft({
                      id: role.id,
                      name: role.name,
                      color: role.color,
                      perms: role.perms,
                      channels: role.channels ?? [],
                      cooldown: role.cooldown ?? 0
                    });
                  }}
                >
                  <span className="font-semibold" style={{ color: role.color }}>
                    {role.name}
                  </span>
                  <span className="truncate text-xs text-textTertiary">{roleWords(role)}</span>
                </button>
              ) : (
                <span className="flex items-center gap-2 px-2 py-1">
                  <span className="font-semibold" style={{ color: role.color }}>
                    {role.name}
                  </span>
                  <span className="truncate text-xs text-textTertiary">{roleWords(role)}</span>
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {full ? (
        <p className="text-textTertiary">{ROLE_CAP} roles is the cap. delete one to add another.</p>
      ) : (
        <button
          id="role-add"
          type="button"
          className="self-start text-sm font-semibold text-primaryBlue disabled:opacity-40"
          disabled={adding}
          onClick={() => void add()}
        >
          add role
        </button>
      )}
    </Section>
  );
}

/** An owner's delete. It asks first, in its own dialog over this one; a yes goes to /groups. */
function DeleteSection({ server, run }: { server: string; run: Run }) {
  const navigate = useNavigate();
  const [sure, setSure] = useState(false);
  return (
    <Section title="delete" description="the group goes, and everyone in it is out.">
      <button id="room-delete-ask" type="button" className="self-start text-sm font-semibold text-decrease" onClick={() => setSure(true)}>
        delete group
      </button>
      {sure && (
        <ConfirmDialog
          id="room-delete"
          title="delete this group?"
          message="the group goes, and everyone in it is out."
          yes="yes, delete"
          onYes={() => {
            setSure(false);
            void run(async () => {
              await api.deleteGroup(server);
              navigate('/groups');
            });
          }}
          onNo={() => setSure(false)}
        />
      )}
    </Section>
  );
}
