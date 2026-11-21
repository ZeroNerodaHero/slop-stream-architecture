import {
  RiAddLine,
  RiArrowLeftSLine,
  RiArrowRightSLine,
  RiCloseLine,
  RiDeleteBinLine,
  RiForbidLine,
  RiGlobalLine,
  RiGroupLine,
  RiHashtag,
  RiInformationLine,
  RiLiveLine,
  RiLockLine,
  RiLogoutBoxRLine,
  RiNotificationLine,
  RiNotificationOffLine,
  RiPaletteLine,
  RiPencilLine,
  RiPushpinFill,
  RiPushpinLine,
  RiRefreshLine,
  RiSearchLine,
  RiSettings3Line,
  RiShieldStarLine,
  RiTimeLine,
  RiUnpinLine,
  RiUserUnfollowLine,
  RiVipCrownLine,
  RiVolumeUpLine,
  type RemixiconComponentType
} from '@remixicon/react';
import { useAtom, useAtomValue } from 'jotai';
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
  type RefObject
} from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { PinSheet, PinSheetButton } from '@/app/explore/PinSheet';
import { VoicePanel } from '@/app/explore/VoicePanel';
import { useVoiceView, VoiceRoom } from '@/app/explore/VoiceRoom';
import {
  api,
  canEditChannel,
  type Channel,
  CHANNEL_CAP,
  type ChannelKind,
  groupImage,
  type GroupMember,
  type GroupRole,
  groupWords,
  homeChannel,
  isVoice,
  messageOf,
  type GroupRoom,
  type PinnedLine,
  type RolePerms
} from '@/infra/api';
import { meAtom, openAuthDialog } from '@/infra/atoms/auth-atoms';
import { type ChatLine, reconnectChat, serverChat } from '@/infra/atoms/chat-atoms';
import { cropPicture } from '@/infra/atoms/crop-atoms';
import { PRESENCE_WORD, presenceOfAtom, presencesAtom } from '@/infra/atoms/presence-atoms';
import {
  channelRenamedAtom,
  enterRoom,
  leaveRoom,
  loadMoreMembers,
  MEMBER_ROW_PX,
  pageFor,
  pinsTickAtom,
  reloadLines,
  reloadRoom,
  editChannel,
  roomAtom,
  roomErrorAtom,
  roomGoneAtom,
  rosterMoreAtom,
  setChannelMuted,
  setChannelOrder,
  setPinned
} from '@/infra/atoms/room-atoms';
import { roomMembersOpenAtom } from '@/infra/atoms/settings-atoms';
import { leaveVoice } from '@/infra/atoms/voice-atoms';
import { useIsMobile } from '@/infra/mobile';
import { cleanName, isValidName } from '@/infra/names';
import { GROUP_BANNER, GROUP_ICON } from '@/infra/picture';
import { previewStreamsAtom, setHomePreviews } from '@/infra/preview';
import { store } from '@/infra/store';
import { Badge } from '@/shared-components/Badge';
import { Button } from '@/shared-components/Button';
import { type ChatSearch, comboProps, SearchFilters, SearchSuggestions, useChatSearch } from '@/shared-components/ChatSearch';
import { ConfirmDialog } from '@/shared-components/ConfirmDialog';
import { Face } from '@/shared-components/Face';
import { RailFace } from '@/shared-components/Friends';
import { GROUP_SWATCHES, GroupColorPick } from '@/shared-components/GroupColorPick';
import { GroupMark } from '@/shared-components/GroupMark';
import { GroupModHost, lineModItems, useCardMod } from '@/shared-components/GroupMod';
import { PAGE_DIALOG, SHEET_CLOSE, SHEET_DIALOG, SheetGrab, focusOnOpen, useSheetBack } from '@/shared-components/MobileSheet';
import { BAR_BUTTON, when } from '@/shared-components/ChatLine';
import { ChatImages, ChatPanel } from '@/shared-components/ChatPanel';
import { PageFrame } from '@/shared-components/PageFrame';
import { INPUT } from '@/shared-components/input';
import { PersonCard, usePeek } from '@/shared-components/PersonCard';
import { PresenceSquare } from '@/shared-components/PresenceSquare';
import { PicturePick } from '@/shared-components/PicturePick';
import { ProfileLink } from '@/shared-components/ProfileLink';
import { DragHandle, movedTo, useReorder } from '@/shared-components/Reorderable';
import { Bone, Skeleton } from '@/shared-components/Skeleton';
import { SwipeDrawer } from '@/shared-components/SwipeDrawer';
import { Tooltip } from '@/shared-components/Tooltip';
import { useHeardUid, VoiceLevel } from '@/shared-components/VoiceLevel';
import { TypeToConfirm } from '@/shared-components/TypeToConfirm';
import { VisibilityToggle } from '@/shared-components/VisibilityToggle';
import { Field, SECTION_TITLE, Section } from '@/shared-components/user-modal/parts';
import { cn } from '@/utils/cn';
import { compactCount } from '@/utils/count';

/** Cameras played in the room. The same peers home uses, muted, and not counted as viewers. */
const FACES = 4;

const TILE = 'block overflow-hidden border border-primaryStroke bg-backgroundSecondary transition-[border-color] duration-150 hover:border-primaryBlue';

const RESERVED = new Set(['before', 'search', 'by', 'around']);

/** Matches `MAX_ABOUT_CHARS` in the api: a channel's line about it, like the group's. */
const ABOUT_CAP = 200;

/**
 * The room is the window: a 7px breath under the title row it sits under (its measured height,
 * `--title-row`: PageFrame.tsx, which globals.css also makes the page's `scroll-padding-top`;
 * 4rem until it is measured), the chat, and a 7px breath over the window's foot. The grid
 * carries both breaths as padding, so the snap puts its edge under the row and the chat 7px
 * below it, and it folds the page's foot (`pb-10`, 2.5rem) under itself. So the room scrolled
 * to is exactly what the window shows, and the page can scroll exactly that far, whether the
 * row is one line or two. The columns beside the chat, the channels and the roster, start on
 * the chat's top edge, and the roster (open or folded to its strip) ends on its foot too.
 * Stacked (md to lg: one column, the channels over the chat over the roster) the grid is taller
 * than the window, so it is not the snap area: each block is (STACKED_SNAP).
 */
const ROOM_GRID = 'grid max-md:snap-start lg:snap-start items-start gap-2 py-[7px] -mb-10 max-md:mb-0 max-md:gap-0 max-md:py-0';
/**
 * The room's three columns on a wide screen: the channels, the chat, the roster, or the roster
 * folded to a strip of faces (`MembersStrip`). The skeleton has the same, so the chat lands at its width.
 */
const roomColumns = (membersOpen: boolean) => (membersOpen ? 'lg:grid-cols-[176px_minmax(0,1fr)_224px]' : 'lg:grid-cols-[176px_minmax(0,1fr)_56px]');
/**
 * The chat's column is a size container, so the pins under its header (`ChannelPins`) are 80% of
 * the chat's width (`cqw`), never narrower than a 20rem box nor wider than the window. With the
 * roster folded the chat is wider by the roster's 224px less the strip's 56px (`roomColumns`):
 * the pins take that back off, so they keep the width they have with the roster open.
 */
const ROOM_CHAT_CONTAINER = '[container-type:inline-size]';
const pinsWidth = (membersOpen: boolean) =>
  cn('w-[max(20rem,80cqw)] max-w-[calc(100vw-2rem)]', !membersOpen && 'lg:w-[max(20rem,calc(0.8*(100cqw_-_168px)))]');
/** A phone's: what the keyboard leaves of the window under the title row (keyboard.ts, --vvh; the whole window without one), so the send row sits on the keyboard. */
const ROOM_HEIGHT =
  'h-[calc(100dvh-var(--title-row,4rem)-14px)] max-md:h-[calc(var(--vvh,100dvh)-var(--title-row,4rem))] min-h-[420px] max-md:min-h-[min(320px,calc(var(--vvh,100dvh)-var(--title-row,4rem)))]';
/**
 * A phone's room is the chat alone, edge to edge under the title row (PageFrame's `bleed`): no
 * box around it, and the safe area at the foot is the send row's padding, not a gap, but not
 * while the keyboard covers that edge (keyboard.ts's `data-keyboard`).
 */
const ROOM_CHAT_MOBILE =
  'max-md:min-h-0 max-md:border-0 max-md:bg-background max-md:[&>header]:px-3 max-md:[&_#chat-lines]:px-3 max-md:[&>footer]:px-3 max-md:[&>footer]:pb-[calc(0.5rem+env(safe-area-inset-bottom))] max-md:[html[data-keyboard]_&>footer]:pb-2 max-md:[&>footer]:pt-2';
/**
 * A block of the stacked room (md to lg) is a snap area of its own, so the page never rests
 * halfway through the channels, and a snap to the chat shows the whole of it, the composer at the
 * foot. The page's `scroll-padding-top` is already the title row, so the margin is the 7px breath
 * alone: the chat, ROOM_HEIGHT, then ends 7px over the window's foot. `snap-always`: a fling from
 * the channels stops on the chat, not past it.
 */
const STACKED_SNAP = 'md:max-lg:snap-start md:max-lg:snap-always md:max-lg:scroll-mt-[7px]';
/** The roster beside the chat: the chat's height on a wide screen; under it (a narrow screen's one column) no taller than the window. */
const ROSTER_HEIGHT = 'max-h-[calc(100dvh-var(--title-row,4rem)-14px)] lg:h-[calc(100dvh-var(--title-row,4rem)-14px)] lg:min-h-[420px]';

/**
 * The page's two views, each a snap area (`snap-start`; the type is on <html> while the page
 * is up, see ServerPage): the top, where the banner's margin above (the title row's `mb-6`) is
 * scroll margin so the snap lands at the very top of the page, not with the banner flush under
 * the row; and the room, under the title row (stacked, md to lg, its channels, chat and roster
 * each: STACKED_SNAP). The skeleton has the same.
 */
const TOP_VIEW = 'snap-start scroll-mt-6';

/** The header's icon-only buttons (the gear, leave): a tooltip for the word, a border on hover. */
const ICON_BUTTON =
  'flex h-7 w-7 max-md:h-11 max-md:w-11 shrink-0 items-center justify-center border border-transparent focus-visible:border-primaryBlue focus-visible:outline-none disabled:cursor-default disabled:opacity-40';

/**
 * The bell on a channel's row while the channel is not muted: up with the pointer on the row
 * (`group/channel`) or the keyboard focus on it, and always up on a screen with no hover,
 * which has no pointer to rest there. Muted, the bell is the mark that says so, and stays up.
 */
const BELL_HIDDEN = 'opacity-0 transition-opacity duration-150 focus-visible:opacity-100 group-hover/channel:opacity-100 [@media(hover:none)]:opacity-100';

const COLORS = ['#5865f2', '#f85149', '#3fb950', '#f2cc60', '#bc8cff', '#ff9f43', '#39d2c0', '#ff6bcb'] as const;

/** Matches `MAX_ROLES` in the api. */
const ROLE_CAP = 20;

const ORDERS = [
  { id: 'name', label: 'name' },
  { id: 'newest', label: 'newest' },
  { id: 'oldest', label: 'oldest' }
] as const;

/**
 * The five powers: the word for each (the role rows' icons, the role editor's tiles), a few words
 * for the tile, what it lets a holder do (the api's checks in `group_mod.rs` and `groups.rs`), and
 * its icon, the manage tabs' icons where a tab is that power's.
 */
const POWERS: { key: keyof RolePerms; label: string; short: string; description: string; Icon: RemixiconComponentType }[] = [
  {
    key: 'appearance',
    label: 'about',
    short: 'text, privacy, order',
    description: 'edit the about text, switch the group public or private, and set the member order',
    Icon: RiInformationLine
  },
  { key: 'roles', label: 'roles', short: 'make & assign', description: 'make, edit and hand out roles', Icon: RiShieldStarLine },
  {
    key: 'channels',
    label: 'channels',
    short: 'add, edit, cooldown',
    description: 'add, rename, reorder and delete channels, set their cooldowns and who sees them, and see every channel',
    Icon: RiHashtag
  },
  { key: 'kick', label: 'kick', short: 'kick & time out', description: 'kick members and time them out', Icon: RiUserUnfollowLine },
  { key: 'ban', label: 'ban', short: 'ban & unban', description: 'ban and unban members', Icon: RiForbidLine }
];

/** A power's name and what it does, for a tooltip. */
function powerTip(power: (typeof POWERS)[number]): string {
  return `${power.label}: ${power.description}`;
}

/**
 * The five power icons in a row, each one's name and what it does on hover: lit (`on`'s colour,
 * the row's grey unless given) where the role carries it, faint where it does not.
 */
function PowerIcons({ perms, color }: { perms: RolePerms; color?: string }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      {POWERS.map((power) => {
        const on = perms[power.key];
        return (
          <Tooltip key={power.key} content={powerTip(power)}>
            <span
              role="img"
              aria-label={on ? power.label : `no ${power.label}`}
              className={cn('flex', on ? !color && 'text-textSecondary' : 'text-textTertiary/40')}
              style={on && color ? { color } : undefined}
            >
              <power.Icon aria-hidden size={15} />
            </span>
          </Tooltip>
        );
      })}
    </span>
  );
}

/**
 * One power in the role editor's grid: the whole tile is the toggle, the icon over the name over a
 * few words of what it does (the rest in its tooltip). Pressed, the border and the icon and name go
 * blue. `locked` is the owner role's (on, and not to be changed); `mine` false greys a power this
 * login cannot give, and says so. On a phone the five sit three over two (`className` the spans).
 */
function PowerTile({
  power,
  id,
  on,
  mine = true,
  locked = false,
  onToggle,
  className
}: {
  power: (typeof POWERS)[number];
  id: string;
  on: boolean;
  mine?: boolean;
  locked?: boolean;
  onToggle?: () => void;
  className?: string;
}) {
  const still = locked || !mine;
  return (
    <Tooltip content={mine ? powerTip(power) : `${power.label}: not yours to give`} className="max-w-72 whitespace-normal">
      <button
        id={id}
        type="button"
        aria-pressed={on}
        aria-disabled={still || undefined}
        aria-description={power.description}
        onClick={() => !still && onToggle?.()}
        className={cn(
          'flex min-w-0 flex-col items-center gap-1 border px-1 pb-1.5 pt-1.5 focus-visible:outline focus-visible:outline-1 focus-visible:outline-primaryBlue',
          on ? 'border-primaryBlue' : 'border-primaryStroke',
          still ? 'cursor-default' : 'hover:bg-primaryStroke/20',
          !mine && 'opacity-40',
          className
        )}
      >
        <power.Icon aria-hidden size={18} className={on ? 'text-primaryBlue' : 'text-textTertiary'} />
        <span className="flex max-w-full flex-col items-center gap-[2px]">
          <span className={cn('text-[13px] font-semibold leading-[15px]', on ? 'text-primaryBlue' : 'text-textPrimary')}>{power.label}</span>
          <span className="max-w-full truncate whitespace-nowrap text-[10.5px] leading-[13px] text-textTertiary">{power.short}</span>
        </span>
      </button>
    </Tooltip>
  );
}

/** Where each tile sits: one of five on a wide screen; on a phone the first three a third each, the last two a half. */
const TILE_SPAN = ['col-span-2', 'col-span-2', 'col-span-2', 'col-span-3', 'col-span-3'].map((span) => `${span} md:col-span-1`);

/**
 * A role's name as it reads: its colour, except the yellow on a light theme, where it is pulled
 * toward black to stand off the page (the colour itself, and the dot, stay as chosen).
 */
function roleInk(color: string): string {
  return color.toLowerCase() === '#f2cc60' ? `light-dark(color-mix(in srgb, ${color} 58%, black), ${color})` : color;
}

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

/** A channel's cooldown on the page's list: the clock alone, the word its tooltip, and only while there is one. */
function CooldownMark({ item }: { item: Channel }) {
  const seconds = item.cooldown ?? 0;
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

/** A pin or an unpin from the page: the room moves at once (`setPinned`); a refusal (the cap among them) is said under the lines. */
function togglePin(server: string, channel: string, id: string, on: boolean): void {
  setPinned(server, channel, id, on).catch((err: unknown) => serverChat(server).showNotice(messageOf(err)));
}

/** A pinned line's mark, at its top right whatever the shape (ChatLine.tsx `mark`). */
function PinMark() {
  return (
    <Tooltip content="pinned">
      <span role="img" aria-label="pinned" data-pinned-mark className="flex text-primaryBlue">
        <RiPushpinFill aria-hidden size={14} />
      </span>
    </Tooltip>
  );
}

/** The pin and the unpin in a line's action bar (ChatLine.tsx `LineActions`, beside react and reply), for the channels power alone. */
function PinAction({ server, channel, line, pinned }: { server: string; channel: string; line: ChatLine; pinned: boolean }) {
  const word = pinned ? 'unpin' : 'pin';
  return (
    <Tooltip content={word}>
      <button
        type="button"
        id="group-msg-pin"
        aria-label={word}
        aria-pressed={pinned}
        onClick={() => togglePin(server, channel, line.id, !pinned)}
        className={cn(BAR_BUTTON, 'hover:text-primaryBlue')}
      >
        {pinned ? <RiUnpinLine aria-hidden size={14} /> : <RiPushpinLine aria-hidden size={14} />}
      </button>
    </Tooltip>
  );
}

/**
 * The channel's pins (docs/groups.md "pins"): a boxed pin in the chat's header with how many,
 * and under it, while open, the pinned lines, newest pin first. A line is a click to it in the
 * channel (`openLine`: the lines around it when it is long scrolled away); the channels power
 * has an unpin on each. The list is asked as it opens, and again on every pin or unpin while it
 * is (`pinsTickAtom`); the count is the room's (`room.pins`), kept by the facts. A line's pictures
 * are under its words, as the chat draws them (`ChatImages`, small), over the row's click: a click
 * on one opens it over the page. Escape, a click outside, or the × shut it; not while a picture is
 * open over the page, whose escape and clicks are its own.
 */
function ChannelPins({ server, channel, room }: { server: string; channel: string; room: GroupRoom }) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<PinnedLine[] | null>(null);
  const [error, setError] = useState('');
  const tick = useAtomValue(pinsTickAtom);
  const boxRef = useRef<HTMLSpanElement | null>(null);
  const membersOpen = useAtomValue(roomMembersOpenAtom);
  const count = room.pins?.[channel]?.length ?? 0;
  const canPin = room.perms.channels;
  const words = count === 0 ? 'pinned messages' : `pinned messages: ${count}`;

  // another channel is another list: put back in the render that brings it, not an effect after
  const where = `${server}/${channel}`;
  const [shownFor, setShownFor] = useState(where);
  if (shownFor !== where) {
    setShownFor(where);
    setOpen(false);
    setList(null);
  }

  useEffect(() => {
    if (!open) return;
    let live = true;
    api
      .channelPins(server, channel)
      .then((r) => {
        if (!live) return;
        setList(r.pins);
        setError('');
      })
      .catch((err: unknown) => {
        if (live) setError(messageOf(err));
      });
    return () => {
      live = false;
    };
  }, [open, server, channel, tick]);

  useEffect(() => {
    if (!open) return;
    // a picture open over the page is a modal <dialog> on the body, outside the box: its presses and its escape are its own
    const inDialog = (target: EventTarget | null) => target instanceof Element && target.closest('dialog[open]') !== null;
    const away = (e: globalThis.PointerEvent) => {
      if (e.target instanceof Node && !boxRef.current?.contains(e.target) && !inDialog(e.target)) setOpen(false);
    };
    const key = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape' && !inDialog(e.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', key);
    };
  }, [open]);

  return (
    <span ref={boxRef} className="relative flex shrink-0">
      <Tooltip content={open ? null : 'pinned messages'}>
        <button
          type="button"
          id="group-pins-open"
          aria-label={words}
          aria-expanded={open}
          aria-controls={open ? 'group-pins' : undefined}
          data-count={count}
          onClick={() => setOpen((was) => !was)}
          className={cn(
            'flex shrink-0 items-center gap-1 whitespace-nowrap border px-1.5 py-0.5 text-xs font-semibold tabular-nums transition-colors duration-150 max-md:min-h-11',
            open ? 'border-primaryBlue text-primaryBlue' : 'border-primaryStroke text-textTertiary hover:border-secondaryStroke hover:text-textSecondary'
          )}
        >
          <RiPushpinLine aria-hidden size={14} />
          {count}
        </button>
      </Tooltip>
      {open && (
        <div
          id="group-pins"
          role="region"
          aria-label="pinned messages"
          className={cn('absolute right-0 top-full z-30 mt-1 flex max-h-96 flex-col border border-primaryStroke bg-backgroundSecondary text-sm', pinsWidth(membersOpen))}
        >
          <div className="flex items-center justify-between gap-2 border-b border-primaryStroke px-3 py-1.5">
            <span className="font-semibold">pinned messages</span>
            <Tooltip content="close">
              <button
                type="button"
                id="group-pins-close"
                aria-label="close"
                onClick={() => setOpen(false)}
                className="flex h-6 w-6 items-center justify-center text-textTertiary hover:text-textPrimary focus-visible:text-primaryBlue focus-visible:outline-none max-md:h-11 max-md:w-11"
              >
                <RiCloseLine aria-hidden size={16} />
              </button>
            </Tooltip>
          </div>
          {error ? (
            <p id="group-pins-error" className="px-3 py-2 text-decrease">
              {error}
            </p>
          ) : list === null ? (
            <p className="px-3 py-2 text-textTertiary">loading…</p>
          ) : list.length === 0 ? (
            <p id="group-pins-empty" className="px-3 py-2 text-textTertiary">
              nothing pinned yet
            </p>
          ) : (
            <ul id="group-pins-list" className="flex min-h-0 flex-col overflow-y-auto overscroll-contain py-1">
              {list.map((pin) => {
                // absent on the wire when there are none
                const pictures = pin.images ?? [];
                return (
                  <li
                    key={pin.id}
                    data-id={pin.id}
                    className="relative flex items-start gap-2 px-3 py-1.5 transition-colors duration-150 focus-within:bg-backgroundTertiary hover:bg-backgroundTertiary"
                  >
                    <div className="min-w-0 flex-1">
                      <button
                        type="button"
                        data-pin-open={pin.id}
                        title={pin.pinned_by ? `pinned by ${pin.pinned_by}` : undefined}
                        onClick={() => {
                          setOpen(false);
                          void serverChat(server).openLine(pin.id, channel);
                        }}
                        className="w-full text-left [overflow-wrap:anywhere] after:absolute after:inset-0 after:content-[''] focus-visible:outline-none"
                      >
                        <span className="mr-1.5 text-xs tabular-nums text-textTertiary">{when(pin.at)}</span>
                        <span className="font-semibold text-primaryBlue">{pin.from}</span>
                        {pin.text && <span className="text-textSecondary">: {pin.text}</span>}
                      </button>
                      {/* over the row's click, so a thumbnail opens the picture and not the line */}
                      {pictures.length > 0 && (
                        <div data-pin-pictures={pin.id} className="relative z-10">
                          <ChatImages ids={pictures} small />
                        </div>
                      )}
                    </div>
                    {canPin && (
                      <Tooltip content="unpin">
                        <button
                          type="button"
                          data-pin-unpin={pin.id}
                          aria-label="unpin"
                          onClick={() => togglePin(server, channel, pin.id, false)}
                          className="relative z-10 flex h-6 w-6 shrink-0 items-center justify-center border border-primaryStroke text-textTertiary hover:border-decrease hover:text-decrease focus-visible:border-primaryBlue focus-visible:outline-none max-md:h-11 max-md:w-11"
                        >
                          <RiUnpinLine aria-hidden size={14} />
                        </button>
                      </Tooltip>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </span>
  );
}

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
function RoomSearch({ search, input, flat, className }: { search: ChatSearch; input: RefObject<HTMLInputElement | null>; flat: boolean; className?: string }) {
  return (
    <form id="group-search-form" onSubmit={search.submit} className={cn('group/search relative shrink-0', className)}>
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
        placeholder="search"
        autoCapitalize="off"
        spellCheck={false}
        className={cn('h-8 w-full border border-primaryStroke bg-background pr-2 text-sm text-textPrimary placeholder:text-textTertiary', flat ? 'pl-8' : 'pl-7')}
      />
      <Tooltip content="search">
        <button
          id="group-search-go"
          type="submit"
          aria-label="search"
          className={cn(
            'absolute left-0 top-0 flex h-8 items-center justify-center text-textTertiary hover:text-textPrimary focus-visible:text-primaryBlue focus-visible:outline-none',
            flat ? 'w-8' : 'w-7'
          )}
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
  const membersOpen = useAtomValue(roomMembersOpenAtom);
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
      <div ref={gridRef} className={cn(ROOM_GRID, roomColumns(membersOpen), 'max-md:gap-4')}>
        <div className={cn('flex flex-col border border-primaryStroke bg-backgroundSecondary p-1', STACKED_SNAP)}>
          <div className="flex h-6 items-center px-2">
            <Bone className="h-3 w-24" />
          </div>
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="flex h-7 items-center px-2">
              <Bone className="h-3.5 w-20" />
            </div>
          ))}
        </div>
        <div className={cn('flex flex-col gap-3 border border-primaryStroke bg-backgroundSecondary p-3', ROOM_HEIGHT, STACKED_SNAP)}>
          <Bone className="h-4 w-2/3" />
          <Bone className="h-4 w-1/2" />
          <Bone className="h-4 w-3/4" />
          <Bone className="mt-auto h-10" />
        </div>
        <div className={cn('flex flex-col gap-2 border border-primaryStroke bg-backgroundSecondary p-2', ROSTER_HEIGHT, STACKED_SNAP, !membersOpen && 'lg:hidden')}>
          <div className="flex shrink-0 gap-1">
            <Bone className="h-8 min-w-0 flex-1" />
            <Bone className="hidden h-8 w-8 shrink-0 lg:block" />
          </div>
          <div className="flex h-6 shrink-0 items-center">
            <Bone className="h-3 w-20" />
          </div>
          <div className="flex flex-col gap-0.5">
            {Array.from({ length: 3 }, (_, i) => (
              <div key={i} className="flex items-center gap-2 p-px">
                <Bone className="h-7 w-7 shrink-0" />
                <Bone className={cn('h-3', i === 1 ? 'w-16' : 'w-24')} />
              </div>
            ))}
          </div>
        </div>
        {!membersOpen && (
          <div className={cn('hidden w-14 flex-col items-center border border-primaryStroke bg-backgroundSecondary pt-1.5 lg:flex', ROSTER_HEIGHT)}>
            <Bone className="h-[calc(2rem+2px)] w-[calc(2rem+2px)] shrink-0" />
            <div className="my-1 h-4" />
            <div className="flex flex-col gap-1">
              {Array.from({ length: 3 }, (_, i) => (
                <Bone key={i} className="h-[calc(2rem+2px)] w-[calc(2rem+2px)]" />
              ))}
            </div>
          </div>
        )}
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
 * `snap-start` area (TOP_VIEW, `#group-room`; stacked, each block of the room). The landing is done once, on the first thing
 * with the room's shape (the skeleton, or the room itself), so the room arrives in place.
 */
export function ServerPage() {
  const params = useParams<{ server: string; channel?: string }>();
  const server = cleanName(params.server);
  const me = useAtomValue(meAtom);
  const room = useAtomValue(roomAtom);
  // no channel in the address is the home one: `general` until it is renamed, and until the room says
  const home = homeChannel(room?.name === server ? room.channels : undefined);
  const channel = params.channel === undefined ? home : cleanName(params.channel);
  const channelOk = isValidName(channel) && !RESERVED.has(channel);
  const ok = isValidName(server) && server !== 'bot' && channelOk;
  const titleId = channel === home ? 'group-title' : 'channel-title';
  const error = useAtomValue(roomErrorAtom);
  const gone = useAtomValue(roomGoneAtom);
  const renamed = useAtomValue(channelRenamedAtom);
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [leaving, setLeaving] = useState(false);
  const [managing, setManaging] = useState(false);
  /** The voice panel's `add voice channel` dialog is open. */
  const [addingVoice, setAddingVoice] = useState(false);
  /** The voice channel whose edit (the voice panel's pencil) is open. */
  const [editingVoice, setEditingVoice] = useState<Channel | null>(null);
  // a phone: the group's drawer from the right (its picture and name, the channels, who is in), the room the chat alone
  const mobile = useIsMobile();
  const [drawer, setDrawer] = useState(false);
  // a voice channel clicked: its call where the chat is (VoiceRoom.tsx), the drawer shut
  const voiceView = useVoiceView(room);
  const openVoice = (name: string) => {
    voiceView.open(name);
    setDrawer(false);
  };
  // a phone's pins: a sheet from under the title row, its pin in the row (PinSheet.tsx); a desktop's are the chat header's (ChannelPins)
  const [pinSheet, setPinSheet] = useState(false);
  // the roster beside the chat, or folded to its strip of faces (a wide screen's: the phone's drawer and a narrow screen's column always have it whole)
  const membersOpen = useAtomValue(roomMembersOpenAtom);
  const live = room?.live ?? [];
  const shown = live.slice(0, FACES);
  const previewKey = shown.join(',');
  // the chat's channels: a voice one has no lines, and is the voice panel's
  const channels = (room?.channels ?? []).filter((item) => !isVoice(item));
  // the channel just renamed is still found under its old name until the layout effect below
  // has moved the page: otherwise the room, its dialog and its chat would be taken down for
  // "no such channel" and put back empty under the new address
  const found = channel === home || channels.some((item) => item.name === channel) || renamed?.from === channel;
  /** The room's grid, or the skeleton's while the room is asked for: where the page lands. */
  const roomRef = useRef<HTMLDivElement | null>(null);
  /** Whether the page has landed on this server's own room. Until then every commit with a room's shape scrolls to it. */
  const landed = useRef(false);

  // the room, once: asked when the page arrives (and again as another login), then the
  // socket's. the channel is not an input here: changing it asks nothing
  useEffect(() => {
    if (!ok || me === undefined) return;
    enterRoom(server);
    // a voice call is the page's: off the page (or another login) it ends
    return () => {
      leaveRoom();
      leaveVoice();
    };
  }, [ok, server, me]);

  // a channel was renamed (the channels tab here, or the fact from elsewhere): the page on it is
  // the new address, and the note is cleared once the page is off the old name. not in the same
  // pass: the router lands a render later than a store write does, and clearing first would
  // leave one render with the old name in the url and no channel of that name in the room
  useLayoutEffect(() => {
    if (!renamed) return;
    // the home channel's page has no name in the address: it is the new name already
    if (renamed.from === channel && params.channel !== undefined)
      navigate(renamed.to === home ? `/groups/${server}` : `/groups/${server}/${renamed.to}`, { replace: true });
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

  // a channel picked in the drawer: the drawer shuts on its chat
  const [drawerChannel, setDrawerChannel] = useState(channel);
  if (drawerChannel !== channel) {
    setDrawerChannel(channel);
    setDrawer(false);
    setPinSheet(false);
  }

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
  // the voice panel's `add voice channel`: the channels power, as the list's `add channel`, and not at the cap
  const onAddVoice = room.perms.channels && mine && (room.channels ?? []).length < CHANNEL_CAP ? () => setAddingVoice(true) : undefined;
  const membersWords = room.members === 1 ? '1 member' : `${room.members} members`;
  const liveWords = live.length === 1 ? '1 streaming now' : `${live.length} streaming now`;
  // the lines pinned in the channel on screen: a mark on each, and the pin or unpin on its hover
  const pinnedHere = new Set(room.pins?.[channel] ?? []);

  // the banner with the picture over its foot, the name, the count, the about line, and join, leave and the gear: the top of the page,
  // or the head of a phone's drawer
  const groupHead = (
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
      <div className={cn('flex flex-wrap items-start justify-between gap-3 pl-4', mobile ? 'pr-3' : 'mb-7')}>
        <div className="min-w-0">
          <h2 className="flex flex-wrap items-center gap-2 text-xl font-semibold">
            {words.title}
            {words.tag && <span className="text-base font-normal text-textTertiary">#{words.tag}</span>}
            {room.owner && <OwnerMark name={ownerRoleOf(room)} size={18} />}
            {room.public === false && <span className="bg-primaryStroke px-1.5 py-0.5 text-xs uppercase text-textSecondary">private</span>}
            <Tooltip content={membersWords}>
              <span id="group-members-count" role="img" aria-label={membersWords} className="flex items-center gap-1 text-sm font-normal text-textTertiary">
                {room.members}
                <RiGroupLine aria-hidden size={16} />
              </span>
            </Tooltip>
            <Tooltip content={liveWords}>
              <span id="group-live-count" role="img" aria-label={liveWords} className="flex items-center gap-1 text-sm font-normal text-textTertiary">
                {live.length}
                <RiLiveLine aria-hidden size={16} />
              </span>
            </Tooltip>
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
            <Button id="group-join" variant="primary" className="px-3 py-1.5 text-sm max-md:min-h-11" disabled={busy} onClick={() => void join()}>
              join
            </Button>
          )}
          {!mine && me === null && (
            <Button id="group-login" variant="primary" className="px-3 py-1.5 text-sm max-md:min-h-11" onClick={() => openAuthDialog('login')}>
              log in to join
            </Button>
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
                className="text-sm font-semibold text-decrease disabled:opacity-40 max-md:min-h-11"
                disabled={busy}
                onClick={() => void leave()}
              >
                sure
              </button>
              <button
                type="button"
                className="text-sm text-textSecondary underline-offset-2 hover:text-textPrimary hover:underline max-md:min-h-11"
                onClick={() => setLeaving(false)}
              >
                keep
              </button>
            </span>
          )}
        </div>
      </div>
      {actionError && <p className={cn('text-sm text-decrease', mobile ? 'px-4' : 'mb-4')}>{actionError}</p>}
    </>
  );
  const channelList = <ChannelList server={server} channel={channel} room={room} me={me ?? null} boxed={!mobile} onError={setActionError} />;
  // the cameras, under the channels. with every camera off the list stands alone: nothing says so
  const liveList = shown.length > 0 && (
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
  );
  // a phone's title row: the menu (PageFrame's, every page's), the group's picture, then its name, small, over the channel; at the right end the back caret (PageFrame's, just left of `mobileEnd`), the pins, then the button that opens the drawer
  const mobileTitle = (
    <span className="flex min-w-0 items-center gap-2.5">
      <GroupMark name={server} color={color} icon={room.icon} className="h-9 w-9 shrink-0 text-sm" />
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-normal text-textSecondary">{words.title}</span>
        {voiceView.view ? (
          <span className="flex min-w-0 items-center gap-1.5 text-lg">
            <RiVolumeUpLine aria-label="voice" size={16} className="shrink-0" />
            <span className="truncate">{voiceView.view}</span>
          </span>
        ) : (
          <span className="truncate text-lg">#&nbsp;{channel}</span>
        )}
      </span>
    </span>
  );
  const drawerOpener = (
    <Tooltip content={drawer ? null : 'channels and members'}>
      <button
        id="group-drawer-open"
        type="button"
        aria-label="channels and members"
        aria-haspopup="dialog"
        aria-expanded={drawer}
        aria-controls="group-drawer"
        onClick={() => setDrawer((open) => !open)}
        className="-mr-2.5 flex h-11 w-11 shrink-0 items-center justify-center border border-transparent text-textSecondary focus-visible:border-primaryBlue focus-visible:outline-none"
      >
        <RiGroupLine aria-hidden size={22} />
      </button>
    </Tooltip>
  );

  return (
    <PageFrame
      wide
      titleId={titleId}
      mobileTitle={noChannel ? undefined : mobileTitle}
      mobileEnd={
        noChannel ? undefined : (
          <>
            <PinSheetButton count={room.pins?.[channel]?.length ?? 0} open={pinSheet} onClick={() => setPinSheet((open) => !open)} />
            {drawerOpener}
          </>
        )
      }
      bleed={!noChannel}
      title={
        <span className="flex min-w-0 items-center gap-3">
          <GroupMark name={server} color={color} icon={room.icon} className="h-8 w-8 shrink-0 text-sm" />
          <span className="truncate">
            {channel === home ? (
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
          <Badge group={{ name: server, badge: room.badge, color, icon: room.icon }} className="shrink-0" />
        </span>
      }
    >
      {noChannel ? (
        <p className="text-textSecondary">
          no such channel.{' '}
          <Link to={`/groups/${server}`} className="text-primaryBlue hover:underline">
            back to #{home}
          </Link>
        </p>
      ) : (
        <>
          {!mobile && groupHead}
          <div id="group-room" ref={roomRef} className={cn(ROOM_GRID, roomColumns(membersOpen))}>
            {!mobile && (
              // no margin over the channels' box: its top edge is the chat panel's
              <div className={cn('flex min-w-0 flex-col gap-3', STACKED_SNAP)}>
                {channelList}
                {liveList}
              </div>
            )}
            <div className={cn('min-w-0', ROOM_CHAT_CONTAINER, ROOM_HEIGHT, STACKED_SNAP)}>
              {/* the search box is the roster's (RoomSearch), for a member and a guest alike; the hits land in the panel. a search is every channel's: a hit opened in another one moves the page there */}
              {voiceView.view ? (
                <VoiceRoom room={room} channel={voiceView.view} className="h-full" />
              ) : (
                <ChatPanel
                  name={server}
                  channel={channel}
                  onChannel={(to) => navigate(to === home ? `/groups/${server}` : `/groups/${server}/${to}`)}
                  headerEnd={mobile ? undefined : <ChannelPins server={server} channel={channel} room={room} />}
                  lineMark={(line) => (pinnedHere.has(line.id) ? <PinMark /> : null)}
                  lineActions={room.perms.channels ? (line) => <PinAction server={server} channel={channel} line={line} pinned={pinnedHere.has(line.id)} /> : undefined}
                  // a search hit says its own channel
                  lineMenu={(line) => lineModItems(room, me, line.channel ?? channel, line)}
                  className={cn('h-full', ROOM_CHAT_MOBILE)}
                />
              )}
            </div>
            {!mobile && (
              // the voice channels over the roster, the column the chat's height between them
              <div className={cn('flex min-w-0 flex-col gap-2', ROSTER_HEIGHT, STACKED_SNAP)}>
                <VoicePanel room={room} onAdd={onAddVoice} onEdit={setEditingVoice} onOpen={openVoice} className={cn(!membersOpen && 'lg:hidden')} />
                <Roster room={room} fill />
              </div>
            )}
          </div>
          {mobile && (
            <PinSheet
              server={server}
              channel={channel}
              open={pinSheet}
              onOpenChange={setPinSheet}
              canPin={room.perms.channels}
              onUnpin={(id) => togglePin(server, channel, id, false)}
            />
          )}
          {/* a phone: what the page has around the chat, in a drawer from the right. no bar over it (no title, no ×: the dim sliver at the left or
              the opener shuts it), and it scrolls as one: the group's head, then the channels in a box, then who is in, in a box of its own (online first, then
              offline). the dim sliver at the left shuts it too */}
          {mobile && (
            <SwipeDrawer id="group-drawer" side="right" open={drawer} onOpenChange={setDrawer} label={`${words.title}: channels and members`}>
              {() => (
                <>
                  <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain pb-3">
                    {groupHead}
                    <div className="mx-3 flex flex-col gap-6 border border-primaryStroke bg-backgroundSecondary p-4">
                      {channelList}
                      {liveList}
                    </div>
                    <VoicePanel room={room} onAdd={onAddVoice} onEdit={setEditingVoice} onOpen={openVoice} flat />
                    <Roster room={room} flat />
                  </div>
                </>
              )}
            </SwipeDrawer>
          )}
          {managing && <ManageDialog server={server} channel={channel} room={room} me={me ?? null} onClose={() => setManaging(false)} />}
          {addingVoice && <ChannelDialog server={server} channels={room.channels ?? []} kind="voice" onClose={() => setAddingVoice(false)} />}
          {editingVoice && <ChannelDialog server={server} channels={room.channels ?? []} editing={editingVoice} onClose={() => setEditingVoice(null)} />}
          <GroupModHost server={server} />
        </>
      )}
    </PageFrame>
  );
}

/**
 * The channels, in the order the manage dialog put them (the home one, `general` until renamed, first until it is moved).
 * Adding one takes the channels power: `add channel`, a row under the last channel, asks the
 * name and a line about it in a dialog (ChannelDialog), and goes at the cap (CHANNEL_CAP,
 * the api's). Nothing here deletes: that is the manage dialog's channels tab. A channel
 * added, deleted or moved anywhere arrives on the socket and the list follows. A member mutes
 * a channel here (docs/notifications.md): a bell at the right of its row, up while the pointer
 * is on the row, with the word as a tooltip. A click mutes it, so its lines stop reaching
 * their bell, and the bell on the row is the crossed one from then on, and stays up as the
 * mark that says so, until they click it again. Who may change a channel (`can_edit`: who made
 * it, or the channels power; the home channel too) has a pencil beside the bell, up the same
 * way, that opens its edit (ChannelDialog with `editing`): the name and the line about it.
 */
function ChannelList({
  server,
  channel,
  room,
  me,
  boxed,
  onError
}: {
  server: string;
  channel: string;
  room: GroupRoom;
  me: string | null;
  /** Beside the chat: a box of its own, its top edge the chat panel's, with 28px rows. In a phone's drawer the drawer has the box. */
  boxed: boolean;
  onError: (error: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  /** The channel whose edit is open. */
  const [editing, setEditing] = useState<Channel | null>(null);
  // the cap and the names are every channel's; the list is the text ones (the voice ones are the voice panel's)
  const channels = room.channels ?? [];
  const textChannels = channels.filter((item) => !isVoice(item));
  const voiceView = useVoiceView(room).view;
  const muted = room.muted ?? [];
  const canAdd = room.perms.channels && room.mine;
  // the mute is a member's: a stranger gets no row to mute
  const canMute = room.mine && me !== null;
  const full = channels.length >= CHANNEL_CAP;
  // a row's height: 28px of line in the box, the text's own line and 4px over and under it in the drawer
  const row = boxed ? 'text-sm leading-7' : 'py-1';

  async function mute(item: string, on: boolean) {
    onError('');
    try {
      await setChannelMuted(server, item, on);
    } catch (err) {
      onError(messageOf(err));
    }
  }

  return (
    <nav aria-label="channels" className={cn(boxed && 'border border-primaryStroke bg-backgroundSecondary p-1')}>
      <h3 className={cn('text-xs font-semibold uppercase tracking-wider text-textTertiary', boxed ? 'flex h-6 items-center px-2' : 'sr-only')}>channels</h3>
      <ul id="group-channels" className={cn('flex flex-col', !boxed && 'gap-0.5')}>
        {textChannels.map((item) => {
          // with a voice channel's call on screen (VoiceRoom.tsx) no text channel is: each is a link back to its chat
          const here = item.name === channel && !voiceView;
          const isMuted = muted.includes(item.name);
          return (
            // the row is the box, the name fills it and the bell sits in it at the right: the pointer anywhere on the row brings the bell up
            <li
              key={item.name}
              data-muted={isMuted || undefined}
              className={cn('group/channel flex items-center', here ? 'bg-primaryStroke/40' : 'hover:bg-primaryStroke/20')}
            >
              {here ? (
                <span aria-current="page" className={cn('min-w-0 flex-1 truncate px-2 font-semibold max-md:py-2.5', row)}>
                  #{item.name}
                </span>
              ) : (
                <Link
                  id={`group-channel-${item.name}`}
                  to={item.home ? `/groups/${server}` : `/groups/${server}/${item.name}`}
                  className={cn('min-w-0 flex-1 truncate px-2 text-textSecondary group-hover/channel:text-textPrimary max-md:py-2.5', row)}
                >
                  #{item.name}
                </Link>
              )}
              <KeptMark roles={keptTo(room, item.name)} />
              <CooldownMark item={item} />
              {canEditChannel(item) && (
                <Tooltip content="edit">
                  <button
                    id={`channel-edit-${item.name}`}
                    type="button"
                    aria-haspopup="dialog"
                    aria-label={`edit #${item.name}`}
                    className={cn(ICON_BUTTON, 'text-textTertiary hover:text-textPrimary', BELL_HIDDEN, !canMute && 'mr-0.5')}
                    onClick={() => setEditing(item)}
                  >
                    <RiPencilLine aria-hidden size={16} />
                  </button>
                </Tooltip>
              )}
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
        <p id="group-channels-full" className={cn('text-xs text-textTertiary', boxed ? 'px-2 py-1' : 'mt-3')}>
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
          className={cn(
            'flex w-full items-center gap-1 px-2 text-left text-textTertiary hover:bg-primaryStroke/20 hover:text-textPrimary max-md:min-h-11',
            boxed ? row : 'mt-0.5 py-1'
          )}
        >
          <RiAddLine aria-hidden size={14} />
          add channel
        </button>
      )}
      {adding && <ChannelDialog server={server} channels={channels} onClose={() => setAdding(false)} />}
      {editing && <ChannelDialog server={server} channels={channels} editing={editing} onClose={() => setEditing(null)} />}
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
 * `add it` posts the channel, which goes under the last one. A text one (the row under the
 * channel list, and `add channel` on the manage dialog's channels tab) and the page is the new
 * channel; a voice one (`add voice channel` on the voice panel) has no page and shows up in
 * the panel. It is put on the page's body, not inside whatever opened it, the way the
 * confirm dialog is (a modal inside a modal closes the outer one with it), and the manage
 * dialog lets a close that is not its own pass. A refusal from the api is said in here.
 *
 * With `editing` it is that channel's edit instead (the pencil on a row of the channel list or
 * the voice panel): the name and the line start as they are, `save` sends what changed
 * (editChannel), and the room follows at once, as every other room open does on the facts. A
 * rename of the channel on screen moves the page to its new address (channelRenamedAtom).
 */
function ChannelDialog({
  server,
  channels,
  kind = 'text',
  editing,
  onClose
}: {
  server: string;
  channels: Channel[];
  kind?: ChannelKind;
  editing?: Channel;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const pressedBackdrop = useRef(false);
  const [name, setName] = useState(editing?.name ?? '');
  const [about, setAbout] = useState(editing?.about ?? '');
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState('');
  const clean = cleanName(name);
  // its own name is not a clash
  const fault = channelNameFault(clean, editing ? channels.filter((item) => item.name !== editing.name) : channels);
  const renamed = editing !== undefined && clean !== editing.name;
  const reworded = editing !== undefined && about.trim() !== editing.about;
  const ok = isValidName(clean) && fault === '' && (!editing || renamed || reworded);
  const voice = editing ? isVoice(editing) : kind === 'voice';
  const id = editing ? 'channel-edit' : voice ? 'voice-make' : 'channel-make';

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    dialog.showModal();
    focusOnOpen(dialog, `#${id}-name`);
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  // every way out goes through the element: close() hands focus back, then fires `close`, which is onClose
  const close = () => dialogRef.current?.close();
  useSheetBack(close);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ok || sending) return;
    setSending(true);
    setStatus('');
    try {
      if (editing) {
        await editChannel(server, editing.name, { ...(renamed && { name: clean }), ...(reworded && { about: about.trim() }) });
        close();
        return;
      }
      const made = await api.createChannel(server, clean, about.trim(), kind);
      close();
      // a voice channel has no page: it is in the voice panel, a click away
      if (!isVoice(made)) navigate(`/groups/${server}/${made.name}`);
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
      id={id}
      data-sheet=""
      aria-labelledby={`${id}-title`}
      onPointerDown={onPointerDown}
      onClick={onClick}
      onClose={(event) => {
        event.stopPropagation();
        onClose();
      }}
      // the dialog box is the panel: a click whose target is the dialog element landed on the backdrop. a phone's is a sheet (MobileSheet.tsx)
      className={cn(
        'm-auto w-[min(460px,calc(100vw-3rem))] border border-primaryStroke bg-backgroundSecondary px-6 py-4 text-base text-textPrimary backdrop:bg-black/60',
        SHEET_DIALOG
      )}
    >
      <SheetGrab onDismiss={close} />
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
        <div>
          <h2 id={`${id}-title`} className="border-l-4 border-primaryBlue pl-3 text-xl font-semibold leading-tight">
            {editing ? `edit ${voice ? '' : '#'}${editing.name}` : voice ? 'add a voice channel' : 'add a channel'}
          </h2>
          <p className="mt-2 text-sm text-textSecondary">
            {editing
              ? 'a new name, a new line about it, or both. everyone in the server sees the change at once.'
              : voice
                ? 'a name, and a line about it if you like. it shows in the voice panel, and a click there joins it.'
                : 'a name, and a line about it if you like. it goes under the last channel; manage moves it.'}
          </p>
        </div>
        <Field id={`${id}-name`} label="name" hint={fault || 'letters, digits, _ and -. up to 32.'}>
          <div className="relative">
            <span aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-textTertiary">
              {voice ? <RiVolumeUpLine size={14} className="block" /> : '#'}
            </span>
            <input
              id={`${id}-name`}
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
              aria-describedby={`${id}-name-hint`}
              aria-invalid={fault !== '' || undefined}
              className={cn(INPUT, voice ? 'pl-8' : 'pl-7')}
            />
          </div>
        </Field>
        <Field id={`${id}-about`} label="about" hint={`optional. up to ${ABOUT_CAP} characters.`}>
          <input
            id={`${id}-about`}
            value={about}
            onChange={(e) => setAbout(e.target.value)}
            maxLength={ABOUT_CAP}
            autoComplete="off"
            aria-describedby={`${id}-about-hint`}
            className={INPUT}
          />
        </Field>
        {status && (
          <p id={`${id}-status`} className="text-sm text-decrease">
            {status}
          </p>
        )}
        <div className="flex items-center justify-end gap-3">
          <button type="button" className="text-sm text-textTertiary" onClick={close}>
            cancel
          </button>
          <Button id={`${id}-submit`} type="submit" variant="primary" className="px-4 py-2" disabled={!ok || sending}>
            {editing ? (sending ? 'saving…' : 'save') : sending ? 'adding…' : 'add it'}
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
 * while the room is up. The whole row is one link to their page, the sidebar's row's way. A
 * click on it shows them over the room instead (ProfilePopup.tsx: who they are, their stream
 * while they are live, their page, and the button that goes there), unless this browser turned
 * that off (settings.profilePopup): then the click is the link's, as is a click with a key
 * held either way (the browser's own: their page in a tab of its own). The pointer resting on
 * the row, or the keyboard's focus landing in it, puts the person's card (PersonCard.tsx, the
 * sidebar's) beside the roster: the face with the word on it, the name, the frame while they
 * stream, their status. The row holds the name, the picture and the word; the status is the
 * card's one profile read, which the popup opens whole from.
 */
function Member({ member, live, ownerRole, flat }: { member: GroupMember; live: boolean; ownerRole: string; flat: boolean }) {
  const presence = useAtomValue(presenceOfAtom(member.name));
  const peek = usePeek(PEEK_MS);
  // a moderator's buttons on the card (GroupMod.tsx): the card waits for the pointer to cross to them
  const actions = useCardMod(member.name, peek.close);
  // in your voice channel: your own level for them at the card's foot
  const heard = useHeardUid(member.name);
  return (
    <li
      data-member={member.name}
      data-owner={member.owner || undefined}
      data-presence={presence}
      className="flex"
      onPointerEnter={(e) => peek.show(e, e.currentTarget.closest('#group-roster'))}
      onPointerLeave={(e) => peek.leave(e.currentTarget)}
      onFocus={(e) => peek.focus(e, e.currentTarget.closest('#group-roster'))}
      onBlur={peek.blur}
      onKeyDown={peek.keyDown}
    >
      <ProfileLink
        // every member is a login, so the ✓ is theirs
        person={{ name: member.name, verified: true, avatar: member.avatar ?? null }}
        live={presence === 'streaming'}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-2 border border-transparent outline-none hover:border-primaryStroke focus-visible:border-primaryBlue max-md:min-h-11',
          !flat && 'p-px'
        )}
      >
        <span className="relative flex shrink-0">
          <Face name={member.name} version={member.avatar ?? null} className={cn('shrink-0', flat ? 'h-8 w-8' : 'h-7 w-7 text-sm')} />
          <PresenceSquare status={presence} className="border-backgroundSecondary" />
          <span className="sr-only">{PRESENCE_WORD[presence]}</span>
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2">
            <span className="truncate text-sm font-semibold">{member.name}</span>
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
      </ProfileLink>
      {/* every member is a login, so the ✓ is theirs; the word is the row's, and the status the card asks for */}
      {peek.at && (
        <PersonCard
          id={`roster-peek-${member.name}`}
          person={{ name: member.name, verified: true, avatar: member.avatar ?? null, presence }}
          at={peek.at}
          actions={actions}
          below={heard && <VoiceLevel id={`roster-peek-${member.name}-level`} name={member.name} uid={heard} pin={peek.hold.pin} />}
          hold={peek.hold}
        />
      )}
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

/** How long the box rests on its words before the server is asked for the members they match. */
const ROSTER_SEARCH_MS = 250;

/**
 * The roster's words asked of the server (`GET .../members?q=`), for a roster that is not all
 * here yet: the rows loaded so far are not everyone the words may find. `hits` null until the
 * answer for these words is in (and for no words); `next` the page after it, which `more`
 * asks for, `height` the box the rows scroll in. An answer for words since changed is dropped.
 */
function useRosterSearch(server: string, q: string, box: RefObject<HTMLElement | null>) {
  const [found, setFound] = useState<{ q: string; hits: GroupMember[]; next: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const asked = useRef('');
  useEffect(() => {
    asked.current = q;
    if (!q) return;
    const timer = setTimeout(() => {
      api
        .groupMembersPage(server, { limit: pageFor(MEMBER_ROW_PX, box.current?.clientHeight), q })
        .then((page) => {
          if (asked.current === q) setFound({ q, hits: page.members, next: page.next });
        })
        // the rows loaded so far stand for the answer; the next word typed asks again
        .catch(() => undefined);
    }, ROSTER_SEARCH_MS);
    return () => clearTimeout(timer);
  }, [server, q, box]);
  const now = found && found.q === q ? found : null;
  const more = (height: number) => {
    if (!now?.next || busy) return;
    setBusy(true);
    setFailed(false);
    api
      .groupMembersPage(server, { limit: pageFor(MEMBER_ROW_PX, height), after: now.next, q })
      .then((page) => {
        if (asked.current !== q) return;
        const have = new Set(now.hits.map((m) => m.name));
        setFound({ q, hits: [...now.hits, ...page.members.filter((m) => !have.has(m.name))], next: page.next });
      })
      .catch(() => setFailed(true))
      .finally(() => setBusy(false));
  };
  return { hits: now?.hits ?? null, next: now?.next ?? null, busy, failed, more };
}

/**
 * The row under a list of members that is not all here yet: `loading…` while the next page is
 * asked for, which happens as the row comes within half a box of the bottom of `root` (the list's
 * own scroll; the window's when it has none), `onMore` given that box's height. Watched again
 * at each new page (`at`, the cursor), so a page too short to push the row out of reach asks for
 * the one after it. A refused page says so, with a way to ask again, rather than asking on and on.
 */
function MoreRow({
  id,
  root,
  at,
  busy,
  failed,
  onMore,
  compact = false
}: {
  id?: string;
  root?: RefObject<HTMLElement | null>;
  at: string;
  busy: boolean;
  failed: boolean;
  onMore: (height: number) => void;
  /** The folded strip's, a face wide: a mark for the words, which are there for a reader. */
  compact?: boolean;
}) {
  const ref = useRef<HTMLLIElement | null>(null);
  const ask = useRef(onMore);
  useLayoutEffect(() => {
    ask.current = onMore;
  });
  const height = () => (root?.current ?? document.documentElement).clientHeight;
  useEffect(() => {
    const el = ref.current;
    if (!el || failed) return;
    const box = root?.current ?? null;
    const seen = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && ask.current((box ?? document.documentElement).clientHeight), {
      root: box,
      rootMargin: '0px 0px 50% 0px'
    });
    seen.observe(el);
    return () => seen.disconnect();
  }, [root, at, failed]);
  return (
    <li ref={ref} id={id} data-more aria-busy={busy} className="flex min-h-7 shrink-0 items-center justify-center gap-2 text-xs text-textTertiary">
      {failed && compact ? (
        <Tooltip content="could not load more: try again" at="left">
          <button
            type="button"
            aria-label="could not load more: try again"
            className="flex h-7 w-7 items-center justify-center border border-primaryStroke text-textSecondary hover:border-primaryBlue hover:text-primaryBlue focus-visible:border-primaryBlue focus-visible:outline-none"
            onClick={() => ask.current(height())}
          >
            <RiRefreshLine aria-hidden size={14} />
          </button>
        </Tooltip>
      ) : failed ? (
        <>
          could not load more
          <Button size="sm" onClick={() => ask.current(height())}>
            try again
          </Button>
        </>
      ) : compact ? (
        <>
          <span aria-hidden>…</span>
          <span className="sr-only">loading</span>
        </>
      ) : (
        'loading…'
      )}
    </li>
  );
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
 * list scrolls. A click on a row shows the member over the room, or goes to their page where
 * this browser said so; their card on hover (`Member`). Nothing here acts on a member: what a
 * power does is in the manage dialog, from the header.
 *
 * A long roster comes in pages (`room.roster_next`): the room brings enough to fill the list
 * twice, and the next page is asked as the end of the list comes near (`MoreRow`). While it is
 * not all here, the words are matched by the server (`useRosterSearch`), whose hits page the same way.
 *
 * On a wide screen the arrow's square at the search box's end folds the roster to a strip of faces
 * (`MembersStrip`), kept per browser (settings.roomMembersOpen). The roster stays mounted under
 * the strip, hidden, so its search and scroll are where they were when it opens again; the
 * focus goes to the strip's arrow on the fold and back to this one on the unfold.
 */
/** Its column's rest instead of the chat's height: the voice panel is over it (ServerRoom's right column). */
const ROSTER_FILL = 'max-h-none min-h-0 flex-1 lg:h-auto lg:min-h-0';

function Roster({ room, flat = false, fill = false }: { room: GroupRoom; flat?: boolean; fill?: boolean }) {
  const members = room.roster ?? [];
  const live = room.live ?? [];
  const presences = useAtomValue(presencesAtom);
  const input = useRef<HTMLInputElement | null>(null);
  const [membersOpen, setMembersOpen] = useAtom(roomMembersOpenAtom);
  // the drawer has no strip: there the roster is always whole
  const folded = !flat && !membersOpen;
  const hideRef = useRef<HTMLButtonElement | null>(null);
  const showRef = useRef<HTMLButtonElement | null>(null);
  // where the focus goes once the fold or the unfold has rendered: only after a click here, not on the first paint
  const focusNext = useRef<RefObject<HTMLElement | null> | null>(null);
  useEffect(() => {
    focusNext.current?.current?.focus();
    focusNext.current = null;
  }, [membersOpen]);
  const setOpen = (open: boolean, focus: RefObject<HTMLElement | null>) => {
    focusNext.current = focus;
    setMembersOpen(open);
  };
  const search = useChatSearch(input, undefined, {
    people: members.map((member) => ({ name: member.name, avatar: member.avatar ?? null })),
    channels: (room.channels ?? []).map((item) => item.name)
  });
  const q = rosterQuery(search.query);
  const listRef = useRef<HTMLUListElement | null>(null);
  const more = useAtomValue(rosterMoreAtom);
  // the roster not all here yet (`roster_next`): the words are the server's to match, over every member (`found`)
  const partial = !!room.roster_next;
  const found = useRosterSearch(room.name, partial ? q : '', listRef);
  const matched = q ? members.filter((member) => member.name.toLowerCase().includes(q) || member.roles.some((role) => role.name.toLowerCase().includes(q))) : members;
  // until the server answers, the rows loaded so far that match
  const shown = found.hits ?? matched;
  const pending = partial && !!q && found.hits === null;
  // the row under the list while there is more of it: the roster's next page, or the search's
  const moreRow = q
    ? found.next && <MoreRow id="group-members-more" root={flat ? undefined : listRef} at={found.next} busy={found.busy} failed={found.failed} onMore={found.more} />
    : room.roster_next && (
        <MoreRow
          id="group-members-more"
          root={flat ? undefined : listRef}
          at={room.roster_next}
          busy={more === 'busy'}
          failed={more === 'failed'}
          onMore={(height) => void loadMoreMembers(height)}
        />
      );
  const row = (member: GroupMember) => <Member key={member.name} member={member} live={live.includes(member.name)} ownerRole={ownerRoleOf(room)} flat={flat} />;
  // a phone's drawer: the ones here first, then the rest under their own heading, each in the group's order
  const isAway = (member: GroupMember) => (presences.get(member.name) ?? 'offline') === 'offline';
  const here = shown.filter((member) => !isAway(member));
  const away = shown.filter(isAway);
  const heading = (
    <h3 className={cn('flex shrink-0 items-center gap-1 whitespace-nowrap text-xs font-semibold uppercase tracking-wider text-textTertiary', flat && 'sr-only')}>
      members <span className="font-normal normal-case tracking-normal">{room.members}</span>
    </h3>
  );

  return (
    <>
      <aside
        id="group-roster"
        aria-label="members"
        className={cn(
          'flex flex-col border border-primaryStroke bg-backgroundSecondary text-sm',
          flat ? 'mx-3 gap-3 p-4' : cn('gap-2 p-2', ROSTER_HEIGHT, STACKED_SNAP, fill && ROSTER_FILL),
          folded && 'lg:hidden'
        )}
      >
        {flat ? (
          <>
            <RoomSearch search={search} input={input} flat />
            {heading}
          </>
        ) : (
          <>
            {/* the search box's row, and at its end the square that folds the roster to its strip (a wide screen's) */}
            <div className="flex shrink-0 gap-1">
              <RoomSearch search={search} input={input} flat={false} className="min-w-0 flex-1" />
              <Tooltip content="hide members">
                <button
                  ref={hideRef}
                  id="group-members-hide"
                  type="button"
                  aria-label="hide members"
                  aria-expanded
                  aria-controls="group-roster"
                  onClick={() => setOpen(false, showRef)}
                  className="hidden h-8 w-8 shrink-0 items-center justify-center border border-primaryStroke bg-background text-textSecondary hover:border-primaryBlue hover:text-primaryBlue focus-visible:border-primaryBlue focus-visible:outline-none lg:flex"
                >
                  <RiArrowRightSLine aria-hidden size={16} />
                </button>
              </Tooltip>
            </div>
            <div className="flex h-6 shrink-0 items-center pl-0.5">{heading}</div>
          </>
        )}
        {!room.roster && (
          <p id="group-members-private" className="text-textTertiary">
            this group is private: who is in it is for its members.
          </p>
        )}
        {q && !pending && shown.length === 0 && (
          <p id="group-members-nobody" className="text-textTertiary">
            nobody by that name.
          </p>
        )}
        {flat ? (
          // in the drawer, which scrolls as one: no scroll of its own
          <>
            <ul id="group-members" className="flex flex-col gap-1 pb-1">
              {here.map(row)}
            </ul>
            {away.length > 0 && (
              <>
                <h4 className="flex items-center gap-1 border-t border-primaryStroke pt-3 text-xs font-semibold uppercase tracking-wider text-textTertiary">
                  offline <span className="font-normal normal-case tracking-normal">{away.length}</span>
                </h4>
                <ul id="group-members-offline" className="flex flex-col gap-1 pb-1">
                  {away.map(row)}
                </ul>
              </>
            )}
            {/* the drawer scrolls as one, so the next page is asked as the end of the drawer comes near */}
            {moreRow && <ul className="flex flex-col">{moreRow}</ul>}
          </>
        ) : (
          // no bar: it would take width from the rows. the padding under the last row is for its presence square, which hangs 4px below its face and would otherwise be 4px of scroll. its scroll is its own: the end of a long roster does not send the page to its other view
          <ul
            ref={listRef}
            id="group-members"
            className="flex min-h-0 flex-col gap-0.5 overflow-y-auto overscroll-contain pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {shown.map(row)}
            {moreRow}
          </ul>
        )}
      </aside>
      {folded && <MembersStrip room={room} showRef={showRef} onShow={() => setOpen(true, hideRef)} fill={fill} />}
    </>
  );
}

/**
 * The roster folded (a wide screen's, `Roster`): a strip a face wide, the chat's height. The
 * arrow's square at its head opens the roster again; then how many are in, and every member's
 * face with the presence square on its corner (the sidebar's, `RailFace`), each a way to them
 * like a roster row, the name its tooltip; the strip scrolls with no bar. A private group's
 * guest gets the arrow and the count alone.
 */
function MembersStrip({ room, showRef, onShow, fill = false }: { room: GroupRoom; showRef: RefObject<HTMLButtonElement | null>; onShow: () => void; fill?: boolean }) {
  const presences = useAtomValue(presencesAtom);
  const members = room.roster ?? [];
  const more = useAtomValue(rosterMoreAtom);
  const listRef = useRef<HTMLUListElement | null>(null);
  return (
    <aside
      id="group-members-strip"
      aria-label="members"
      className={cn('hidden w-14 flex-col border border-primaryStroke bg-backgroundSecondary lg:flex', ROSTER_HEIGHT, fill && ROSTER_FILL)}
    >
      <div className="flex shrink-0 justify-center pt-1.5">
        <Tooltip content="show members" at="left">
          <button
            ref={showRef}
            id="group-members-show"
            type="button"
            aria-label="show members"
            aria-expanded={false}
            aria-controls="group-roster"
            onClick={onShow}
            className="flex h-[calc(2rem+2px)] w-[calc(2rem+2px)] items-center justify-center border border-primaryStroke bg-backgroundSecondary text-textSecondary hover:border-primaryBlue hover:text-primaryBlue focus-visible:border-primaryBlue focus-visible:outline-none"
          >
            <RiArrowLeftSLine aria-hidden size={16} />
          </button>
        </Tooltip>
      </div>
      <Tooltip content={`${room.members} ${room.members === 1 ? 'member' : 'members'}`} at="left">
        <p className="my-1 inline-flex h-4 shrink-0 items-center justify-center gap-1 text-xs font-semibold tabular-nums text-textTertiary">
          <RiGroupLine aria-hidden size={14} />
          {compactCount(room.members)}
          <span className="sr-only">&nbsp;{room.members === 1 ? 'member' : 'members'}</span>
        </p>
      </Tooltip>
      {/* the faces 10px in from the strip's border, and room under the last one for its presence square, which hangs below its face */}
      <ul
        ref={listRef}
        className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto overscroll-contain px-2.5 pb-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {members.map((member) => {
          const presence = presences.get(member.name) ?? 'offline';
          return (
            <li key={member.name} data-member={member.name} className="flex">
              <Tooltip content={member.name} at="left">
                <ProfileLink
                  // every member is a login, so the ✓ is theirs
                  person={{ name: member.name, verified: true, avatar: member.avatar ?? null }}
                  live={presence === 'streaming'}
                  label={`${member.name} · ${PRESENCE_WORD[presence]}`}
                  className="flex border border-transparent outline-none hover:border-primaryStroke focus-visible:border-primaryBlue"
                >
                  <RailFace name={member.name} avatar={member.avatar ?? null} presence={presence} />
                </ProfileLink>
              </Tooltip>
            </li>
          );
        })}
        {room.roster_next && (
          <MoreRow root={listRef} at={room.roster_next} busy={more === 'busy'} failed={more === 'failed'} onMore={(height) => void loadMoreMembers(height)} compact />
        )}
      </ul>
    </aside>
  );
}

interface ManageProps {
  server: string;
  room: GroupRoom;
  run: Run;
}

type ManageTab = 'about' | 'channels' | 'roles' | 'members' | 'bans';

/**
 * The rail of the manage dialog, in order and in groups, each tab with the power that shows
 * it. `about` is the about line and the listing (appearance), and for an owner the pictures
 * too; `channels` is their order, and add and delete (channels; and for a channel's maker
 * without the power, the delete of their own); `members` is for anyone who manages at all,
 * since every power does something to a member. An owner's delete is not a tab: it sits at
 * the foot of the rail and asks in its own dialog.
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
    group: 'group',
    icon: <RiInformationLine aria-hidden size={18} />,
    shown: (room) => room.perms.appearance
  },
  {
    id: 'channels',
    label: 'channels',
    group: 'group',
    icon: <RiHashtag aria-hidden size={18} />,
    shown: managesChannels
  },
  {
    id: 'roles',
    label: 'roles',
    group: 'group',
    icon: <RiShieldStarLine aria-hidden size={18} />,
    shown: (room) => room.perms.roles
  },
  {
    id: 'members',
    label: 'members',
    group: 'members',
    icon: <RiGroupLine aria-hidden size={18} />,
    shown: (room) => manages(room)
  },
  {
    id: 'bans',
    label: 'bans',
    group: 'members',
    icon: <RiForbidLine aria-hidden size={18} />,
    shown: (room) => room.perms.ban
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
 * like the user modal: a rail of tabs down the left, in groups (group: about and the listing,
 * channels, roles; members: members, bans), for an owner `delete group` at the foot of the
 * rail, and the open tab's pane on the right. A tab shows for the power behind it, and the
 * first one this login may see opens.
 * The pictures are an owner's: the top of `about` here, and the pictures themselves at the
 * top of the page; the channels are put in order here, and the list on the left follows.
 * Every call lands through the socket, for this page and every other one with the room open,
 * so the dialog reads the room the page does and follows it live. A native <dialog>: the
 * browser keeps focus in it, closes it on escape and hands focus back to the button that
 * opened it; a click on the backdrop closes it too. A refusal is said in the pane, since the
 * page is under the backdrop. `channel` is the one on screen: deleting it from here moves the
 * page to the home channel first, so the room under the dialog does not turn into `no such channel`.
 */
function ManageDialog({ server, channel, room, me, onClose }: { server: string; channel: string; room: GroupRoom; me: string | null; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  /** The press that began this click was on the backdrop too: a text drag that ends outside is not a close. */
  const pressedBackdrop = useRef(false);
  const [error, setError] = useState('');
  const [picked, setPicked] = useState<ManageTab | null>(null);
  /** The owner's delete is asking, in its own dialog over this one. */
  const [deleting, setDeleting] = useState(false);
  const navigate = useNavigate();
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
  useSheetBack(close);

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
        'flex-col open:flex sm:flex-row backdrop:bg-black/60',
        // a phone's is a page over the page, its × a finger's (MobileSheet.tsx)
        PAGE_DIALOG
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
        {/* the tabs, then an owner's delete pinned to the foot: one strip that scrolls on a phone, the delete its last item */}
        <div className="flex min-h-0 flex-row overflow-x-auto sm:flex-1 sm:flex-col sm:overflow-y-auto sm:overflow-x-hidden">
          <div
            id="manage-tabs"
            role="tablist"
            aria-orientation="vertical"
            aria-label="sections"
            onKeyDown={rove}
            className="flex flex-row gap-1 p-2 sm:flex-col sm:gap-0"
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
          {room.owner && (
            // not a tab: no pane of its own, a click asks right away. a divider over it, at the very foot of the rail
            <div className="flex shrink-0 items-center border-l border-primaryStroke p-2 sm:mt-auto sm:border-l-0 sm:border-t">
              <button
                id="room-delete-ask"
                type="button"
                onClick={() => setDeleting(true)}
                className={cn(RAIL_TAB, 'border-transparent text-decrease hover:bg-decrease/10')}
              >
                <RiDeleteBinLine aria-hidden size={18} />
                delete group
              </button>
            </div>
          )}
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
            className={cn(
              'absolute right-4 top-4 z-10 flex h-8 w-8 items-center justify-center border border-primaryStroke bg-backgroundSecondary text-textSecondary transition-colors duration-150 hover:border-primaryBlue hover:text-primaryBlue focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-primaryBlue',
              SHEET_CLOSE
            )}
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
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4 [scrollbar-gutter:stable] sm:px-8 sm:py-5"
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
                <ColorSection server={server} room={room} run={run} />
                <AboutSection server={server} room={room} run={run} />
                <ListingSection server={server} room={room} run={run} />
              </div>
            )}
            {tab === 'channels' && <ChannelsSection server={server} channel={channel} room={room} run={run} />}
            {tab === 'roles' && <RolesSection server={server} room={room} run={run} />}
            {tab === 'members' && <MembersSection server={server} room={room} me={me} run={run} />}
            {tab === 'bans' && <BansSection server={server} room={room} run={run} />}
          </div>
        </div>
      </div>
      {room.owner && deleting && (
        <TypeToConfirm
          id="room-delete"
          title="delete this group?"
          message="the group goes, and everyone in it is out."
          yes="delete"
          onYes={() => {
            setDeleting(false);
            void run(async () => {
              await api.deleteGroup(server);
              navigate('/groups');
            });
          }}
          onNo={() => setDeleting(false)}
        />
      )}
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

/**
 * The group's colour (appearance): the create dialog's swatches and picker, the mark and the
 * badge drawn in the colour picked as it is picked, and `save`, as the about line saves. The
 * colour changing under it (saved here, or by another owner, the `color` fact) starts the pick
 * over from the new one.
 */
function ColorSection({ server, room, run }: ManageProps) {
  const saved = room.color || GROUP_SWATCHES[0].hex;
  const [draft, setDraft] = useState({ base: saved, color: saved });
  const color = draft.base === saved ? draft.color : saved;
  const changed = color.toLowerCase() !== saved.toLowerCase();
  return (
    <Section id="manage-color" title="color" description="the group's square, banner and badge, wherever they show.">
      <div className="flex items-center gap-3">
        <GroupMark id="manage-color-mark" name={server} color={color} icon={room.icon} className="h-12 w-12 shrink-0 border border-primaryStroke text-lg" />
        <Badge group={{ name: server, badge: room.badge, color }} preview size="md" />
      </div>
      <form
        className="flex flex-wrap items-center gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (changed) void run(() => api.saveGroupColor(server, color));
        }}
      >
        <GroupColorPick id="group-color" value={color} onChange={(hex) => setDraft({ base: saved, color: hex })} />
        <Button id="group-color-save" size="sm" variant="outline" type="submit" disabled={!changed} className="ml-auto">
          save
        </Button>
      </form>
    </Section>
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
          className={cn(INPUT, 'min-w-0 flex-1')}
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
      <VisibilityToggle isPublic={isPublic} ids={['room-public', 'room-private']} onChange={(next) => void run(() => api.setGroupPublic(server, next))} />
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
  const more = useAtomValue(rosterMoreAtom);
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
        {/* the roster's pages are the room's, so a page asked here is on the room's list too */}
        {room.roster_next && (
          <MoreRow id="manage-members-more" at={room.roster_next} busy={more === 'busy'} failed={more === 'failed'} onMore={(height) => void loadMoreMembers(height)} />
        )}
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
        <input id="ban-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="username" aria-label="ban a name" maxLength={32} className={INPUT} />
        <input
          id="ban-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="reason"
          aria-label="ban reason"
          maxLength={ABOUT_CAP}
          className={INPUT}
        />
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

/** A channel as it is being changed in place: the name it is known by now (`from`), and what `save` puts. */
interface ChannelDraft {
  from: string;
  name: string;
  /** The roles it is kept to, by id; none is everyone's. */
  roles: string[];
  /** Seconds between a member's lines; 0 none. */
  cooldown: number;
}

/** What a new channel is called: `new-channel`, or the first of `new-channel-2`, `new-channel-3`, … that no channel here has, so the add never collides. */
function freshChannelName(channels: Channel[]): string {
  const taken = new Set(channels.map((item) => item.name));
  if (!taken.has('new-channel')) return 'new-channel';
  let n = 2;
  while (taken.has(`new-channel-${n}`)) n += 1;
  return `new-channel-${n}`;
}

/** A channel's name as the list says it: `#` and the name, or the speaker and the name on a voice one. */
function ChannelWord({ item, name }: { item: Channel; name: string }) {
  return isVoice(item) ? (
    <span className="flex min-w-0 items-center gap-1">
      <RiVolumeUpLine aria-label="voice" size={14} className="shrink-0" />
      <span className="truncate">{name}</span>
    </span>
  ) : (
    <span className="truncate">#{name}</span>
  );
}

/**
 * Who sees a channel, said short: the globe and `everyone`, or the lock, the roles' dots and
 * how many, with their names as the tooltip.
 */
function SeersMark({ roles }: { roles: GroupRole[] }) {
  if (roles.length === 0)
    return (
      <span className="flex shrink-0 items-center gap-1 text-xs text-textTertiary">
        <RiGlobalLine aria-hidden size={14} />
        everyone
      </span>
    );
  const words = `only ${roles.map((role) => role.name).join(', ')}`;
  return (
    <Tooltip content={words}>
      <span aria-label={words} className="flex shrink-0 items-center gap-1 text-xs text-textTertiary">
        <RiLockLine aria-hidden size={14} />
        {roles.map((role) => (
          <span key={role.id} aria-hidden className="h-2 w-2 shrink-0" style={{ backgroundColor: role.color }} />
        ))}
        <span aria-hidden>{roles.length === 1 ? '1 role' : `${roles.length} roles`}</span>
      </span>
    </Tooltip>
  );
}

/**
 * The channels in their order, each a row: a handle to drag it by (the arrow keys on the
 * handle do the same, a row a press), the name, who sees it and its cooldown. A row within
 * reach is the click: it opens in place, one at a time, as the roles tab's do: the name in a
 * box, who sees it (`everyone`, or the roles picked: a role picked lets go of everyone, the
 * last role let go of is everyone again, and everyone lets go of every role; the owners and
 * the channels power see it whatever is picked), the cooldown (not on a voice one: it has no lines), and save, cancel and delete
 * (never on the home channel, nor the last voice one). A save sends what changed: who sees
 * it (setChannelRoles), the cooldown, then the name (editChannel), which lands when the api
 * says yes, the list on the left following under the backdrop and a page on the channel
 * moving to its new address. A drag moves the row as the pointer goes and tells the api once,
 * on the drop (setChannelOrder, room-atoms). `add channel` makes one right away, called
 * `new-channel` (numbered when that is taken), and opens it with the name selected. Deleting
 * the channel on screen moves the page to the home channel first, so the room under the
 * dialog stays a room. The order, the add, who sees it and the cooldown are the channels
 * power's: without it this login is here for a channel they made (managesChannels), and the
 * name and delete are what opens on theirs.
 */
function ChannelsSection({ server, channel, room, run }: ManageProps & { channel: string }) {
  const navigate = useNavigate();
  const channels = room.channels ?? [];
  const names = channels.map((item) => item.name);
  const byName = new Map(channels.map((item) => [item.name, item]));
  const orders = room.perms.channels;
  const home = homeChannel(channels);
  const [draft, setDraft] = useState<ChannelDraft | null>(null);
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sure, setSure] = useState<string | null>(null);
  /** The name box that has had its open-time select. A later focus of the same box edits in place; a channel opened is a new box. */
  const selected = useRef<HTMLInputElement | null>(null);
  const full = channels.length >= CHANNEL_CAP;
  // a server keeps one voice channel: the last one has no delete (the api says so too)
  const voiceCount = channels.filter(isVoice).length;
  // the row open in place: the draft, while the channel it is of is still there
  const open = draft !== null && byName.has(draft.from) ? draft : null;
  // a row by its handle (Reorderable): the rows move on a draft, and the drop tells the api.
  // the room moves to the new order at once (room-atoms), so the draft can go in the same breath
  const reorder = useReorder({
    keys: names,
    name: (name) => `#${name}`,
    onMove: (name, to) => void run(() => setChannelOrder(server, movedTo(names, name, to)))
  });

  /** The channel's draft as it stands in the room. */
  function draftOf(item: Channel): ChannelDraft {
    return { from: item.name, name: item.name, roles: keptTo(room, item.name).map((role) => role.id), cooldown: item.cooldown ?? 0 };
  }

  /** A channel now, so it has a name to be known by, then open with the name selected. */
  async function add() {
    setAdding(true);
    try {
      await run(async () => {
        const made = await api.createChannel(server, freshChannelName(channels));
        setDraft({ from: made.name, name: made.name, roles: [], cooldown: made.cooldown ?? 0 });
      });
    } finally {
      setAdding(false);
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    const item = open && byName.get(open.from);
    if (!open || !item || saving) return;
    const clean = cleanName(open.name);
    const was = draftOf(item);
    setSaving(true);
    try {
      await run(async () => {
        // by the old name first: the rename goes last
        if (orders && [...open.roles].sort().join(' ') !== [...was.roles].sort().join(' ')) await api.setChannelRoles(server, open.from, open.roles);
        if (orders && !isVoice(item) && open.cooldown !== was.cooldown) await api.setChannelCooldown(server, open.from, open.cooldown);
        if (clean !== open.from) await editChannel(server, open.from, { name: clean });
        setDraft(null);
      });
    } finally {
      setSaving(false);
    }
  }

  const sureItem = sure === null ? undefined : byName.get(sure);
  const sureVoice = sureItem !== undefined && isVoice(sureItem);

  async function remove(name: string) {
    await run(async () => {
      await api.deleteChannel(server, name);
      if (name === channel) navigate(`/groups/${server}`);
    });
  }

  return (
    <Section title="channels" description={`${channels.length} of ${CHANNEL_CAP}`}>
      <div className="relative">
        <ul id="manage-channels" {...reorder.list} className="flex flex-col gap-1">
          {reorder.order.map((name) => {
            const item = byName.get(name);
            if (!item) return null;
            const handle = orders && <DragHandle id={`channel-drag-${name}`} {...reorder.handle(name)} />;
            const isHome = name === home;
            if (open?.from === name) {
              const clean = cleanName(open.name);
              const fault = clean === name ? '' : channelNameFault(clean, channels);
              const ok = isValidName(clean) && fault === '';
              const cooldowns = COOLDOWNS.includes(open.cooldown) ? COOLDOWNS : [...COOLDOWNS, open.cooldown].sort((a, b) => a - b);
              const shown = room.roles.filter((role) => open.roles.includes(role.id));
              const everyone = open.roles.length === 0;
              const canDelete = item.can_delete && !isHome && !(isVoice(item) && voiceCount === 1);
              return (
                <li key={name} data-channel={name} data-open {...reorder.item(name)} className="border border-primaryBlue bg-background">
                  <form id="channel-form" onSubmit={(e) => void save(e)}>
                    <div className="flex items-center gap-2.5 border-b border-primaryStroke px-2.5 py-2">
                      {handle}
                      <span className="flex min-w-0 flex-1 text-[15px] font-semibold">
                        <ChannelWord item={item} name={clean || name} />
                      </span>
                      <SeersMark roles={shown} />
                      {canDelete && (
                        <Button
                          id="channel-delete"
                          size="sm"
                          variant="outline-danger"
                          className="gap-1 border-decrease/40 px-2 py-1 text-xs"
                          onClick={() => setSure(name)}
                        >
                          <RiDeleteBinLine aria-hidden size={14} />
                          delete
                        </Button>
                      )}
                    </div>
                    <div className="flex flex-col gap-2.5 p-2.5">
                      {/* the name, the `#` (a voice one's speaker) inside the box */}
                      <div className="flex flex-col gap-1">
                        <div className="relative">
                          <span aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-textTertiary">
                            {isVoice(item) ? <RiVolumeUpLine size={14} className="block" /> : '#'}
                          </span>
                          <input
                            id="channel-name"
                            value={open.name}
                            onChange={(e) =>
                              setDraft({
                                ...open,
                                name: e.target.value
                                  .toLowerCase()
                                  .replace(/[^a-z0-9_-]/g, '')
                                  .slice(0, 32)
                              })
                            }
                            placeholder="name"
                            maxLength={32}
                            aria-label="channel name"
                            aria-invalid={fault !== '' || undefined}
                            aria-describedby={fault ? 'channel-name-fault' : undefined}
                            disabled={!canEditChannel(item)}
                            autoComplete="off"
                            autoCapitalize="off"
                            spellCheck={false}
                            autoFocus
                            onFocus={(e) => {
                              if (selected.current === e.currentTarget) return;
                              selected.current = e.currentTarget;
                              e.currentTarget.select();
                            }}
                            className={cn(INPUT, isVoice(item) ? 'pl-8' : 'pl-7')}
                          />
                        </div>
                        {fault && (
                          <p id="channel-name-fault" className="text-xs text-decrease">
                            {fault}
                          </p>
                        )}
                      </div>
                      {/* who sees it: everyone, or the roles picked (and the owners, always). the home channel stays everyone's */}
                      {orders && (
                        <div className="flex flex-col gap-1">
                          <span id="channel-seers-label" className="text-xs font-semibold text-textSecondary">
                            who sees it
                          </span>
                          <div role="group" aria-labelledby="channel-seers-label" className="flex flex-wrap gap-1.5">
                            <Tooltip content={isHome ? `${name} stays everyone's` : null}>
                              <Button
                                id="channel-seers-everyone"
                                size="sm"
                                aria-pressed={everyone}
                                aria-disabled={isHome || undefined}
                                className={cn('gap-1.5 font-semibold', everyone ? 'border-primaryBlue text-primaryBlue hover:border-primaryBlue' : 'text-textTertiary')}
                                onClick={() => {
                                  if (!isHome) setDraft({ ...open, roles: [] });
                                }}
                              >
                                <RiGlobalLine aria-hidden size={14} />
                                everyone
                              </Button>
                            </Tooltip>
                            {room.roles.map((role) => {
                              const on = open.roles.includes(role.id);
                              // a role carrying a power this login lacks is out of reach, as in the roles tab
                              const why = isHome ? `${name} stays everyone's` : !reaches(room, role.perms) ? "it carries a power you don't hold" : null;
                              return (
                                <Tooltip key={role.id} content={why}>
                                  <Button
                                    id={`channel-role-${role.id}`}
                                    data-role={role.name}
                                    size="sm"
                                    aria-pressed={on}
                                    aria-disabled={why !== null || undefined}
                                    className={cn('gap-1.5 font-semibold', !on && 'text-textTertiary', why !== null && 'cursor-not-allowed opacity-50')}
                                    style={on ? { color: roleInk(role.color), borderColor: role.color } : undefined}
                                    onClick={() =>
                                      why === null &&
                                      setDraft({ ...open, roles: on ? open.roles.filter((id) => id !== role.id) : [...open.roles, role.id] })}
                                  >
                                    <span aria-hidden className="h-2 w-2 shrink-0" style={{ backgroundColor: role.color }} />
                                    {role.name}
                                  </Button>
                                </Tooltip>
                              );
                            })}
                          </div>
                        </div>
                      )}
                      {/* the cooldown: seconds between a member's lines, one segment each, as the roles tab's. a voice one has no lines */}
                      {orders && !isVoice(item) && (
                        <div className="flex flex-col gap-1">
                          <span id="channel-cooldown-label" className="text-xs font-semibold text-textSecondary">
                            cooldown
                          </span>
                          <div
                            role="group"
                            aria-labelledby="channel-cooldown-label"
                            className="grid divide-x divide-primaryStroke border border-primaryStroke"
                            style={{ gridTemplateColumns: `repeat(${cooldowns.length}, minmax(0, 1fr))` }}
                          >
                            {cooldowns.map((seconds) => (
                              <button
                                key={seconds}
                                id={`channel-cooldown-${seconds}`}
                                type="button"
                                aria-pressed={open.cooldown === seconds}
                                onClick={() => setDraft({ ...open, cooldown: seconds })}
                                className={cn(
                                  'py-1.5 text-sm font-semibold focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-primaryBlue',
                                  open.cooldown === seconds ? 'bg-primaryBlue/10 text-primaryBlue' : 'text-textTertiary hover:text-textPrimary'
                                )}
                              >
                                {cooldownWords(seconds)}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                      <div className="flex items-center justify-end gap-1.5">
                        <Button id="channel-cancel" size="sm" onClick={() => setDraft(null)}>
                          cancel
                        </Button>
                        <Button id="channel-save" type="submit" size="sm" variant="primary" className="text-white" disabled={!ok || saving}>
                          save
                        </Button>
                      </div>
                    </div>
                  </form>
                </li>
              );
            }
            // a row opens for who may change something on it: the channels power, or its maker
            const opens = orders || canEditChannel(item) || item.can_delete;
            const seconds = item.cooldown ?? 0;
            const body = (
              <>
                <span className="flex min-w-0 flex-1 font-semibold">
                  <ChannelWord item={item} name={name} />
                </span>
                <SeersMark roles={keptTo(room, name)} />
                {!isVoice(item) && (
                  <span data-cooldown={seconds} className="flex shrink-0 items-center gap-1 text-xs text-textTertiary">
                    <RiTimeLine aria-hidden size={14} />
                    <span className="sr-only">cooldown</span>
                    {cooldownWords(seconds)}
                  </span>
                )}
              </>
            );
            return (
              <li
                key={name}
                data-channel={name}
                {...reorder.item(name)}
                className={cn(
                  'flex items-center gap-2.5 border bg-background pl-2.5 transition-[border-color] duration-150',
                  reorder.held === name ? 'border-primaryBlue' : 'border-primaryStroke',
                  opens && 'hover:bg-primaryStroke/20'
                )}
              >
                {handle}
                {opens ? (
                  <button
                    id={`channel-open-${name}`}
                    type="button"
                    aria-label={`edit ${isVoice(item) ? '' : '#'}${name}`}
                    className="flex min-w-0 flex-1 items-center gap-2.5 py-1.5 pr-2.5 text-left focus-visible:outline-none focus-visible:[&>span:first-child]:text-primaryBlue"
                    onClick={() => setDraft(draftOf(item))}
                  >
                    {body}
                    <RiArrowRightSLine aria-hidden size={16} className="shrink-0 text-textTertiary" />
                  </button>
                ) : (
                  <span className="flex min-w-0 flex-1 items-center gap-2.5 py-1.5 pr-2.5">{body}</span>
                )}
              </li>
            );
          })}
        </ul>
        {reorder.status}
      </div>
      {orders &&
        (full ? (
          <p className="text-textTertiary">{CHANNEL_CAP} channels is the cap. delete one to add another.</p>
        ) : (
          <Button id="manage-channel-add" size="sm" className="w-full gap-1.5 py-2 text-primaryBlue" disabled={adding} onClick={() => void add()}>
            <RiAddLine aria-hidden size={16} />
            add channel
          </Button>
        ))}
      {sure && (
        <ConfirmDialog
          id={`manage-channel-delete-${sure}`}
          title={`delete ${sureVoice ? '' : '#'}${sure}?`}
          message="the channel goes."
          yes="yes, delete"
          onYes={() => {
            const name = sure;
            setSure(null);
            setDraft(null);
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

/**
 * The roles, each a row: the name in its colour, the powers it carries and the channels kept
 * to it. A row within reach is the click: it opens in place as the name, the colour, the
 * powers and the cooldown, with save, cancel and delete; one is open at a time. Who sees a
 * channel is said from the channel's side (the channels tab); a save here sends
 * the role's channels back as they stand. `add role` makes one right away, called `new role` (numbered when
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
  const full = room.roles.length >= ROLE_CAP;
  const ownerRole = ownerRoleOf(room);
  // the row open in place: the draft, while the role it is of is still there
  const open = draft !== null && room.roles.some((role) => role.id === draft.id) ? draft : null;

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
    // the channels kept to it as the room has them now, untouched: who sees a channel is the channels tab's. the ones
    // this login sees, as the api reads a role's body (one it does not see stays kept whatever the body says)
    const seen = new Set((room.channels ?? []).map((item) => item.name));
    const kept = (room.roles.find((role) => role.id === open.id)?.channels ?? []).filter((name) => seen.has(name));
    await run(async () => {
      await api.saveRole(server, open.id, {
        name: open.name.trim(),
        color: open.color,
        perms: open.perms,
        channels: kept,
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
    <Section title="roles" description={`${room.roles.length} of ${ROLE_CAP}`}>
      <ul id="group-roles" className="flex flex-col gap-1">
        {/* the owner role first: every power, every channel, not a row of the api's roles. an owner renames it, nothing else changes */}
        <li
          data-role={ownerRole}
          data-owner
          data-open={ownerDraft !== null || undefined}
          className={cn('border', ownerDraft !== null ? 'border-primaryBlue' : 'border-primaryStroke')}
        >
          {ownerDraft !== null ? (
            <form id="owner-role-form" onSubmit={(e) => void saveOwner(e)}>
              <div className="flex items-center gap-2.5 border-b border-primaryStroke px-2.5 py-2">
                <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[15px] font-semibold text-primaryBlue">
                  <RiVipCrownLine aria-hidden size={16} className="shrink-0" />
                  <span className="truncate">{ownerDraft.trim() || ownerRole}</span>
                </span>
                <PowerIcons perms={ALL_PERMS} color="rgb(var(--primary-color))" />
              </div>
              <div className="flex flex-col gap-2.5 p-2.5">
                <input
                  id="owner-role-name"
                  value={ownerDraft}
                  onChange={(e) => setOwnerDraft(e.target.value)}
                  placeholder="role"
                  maxLength={32}
                  aria-label="owner role name"
                  autoFocus
                  onFocus={(e) => e.currentTarget.select()}
                  className={cn(INPUT, 'min-w-0 flex-1')}
                />
                {/* the role form's tiles, every one on and locked: an owner's */}
                <div role="group" aria-label="powers" className="grid grid-cols-6 gap-1.5 md:grid-cols-[repeat(5,minmax(0,1fr))]">
                  {POWERS.map((power, i) => (
                    <PowerTile key={power.key} power={power} id={`owner-role-perm-${power.key}`} on locked className={TILE_SPAN[i]} />
                  ))}
                </div>
                <p className="text-xs text-textTertiary">
                  an owner has every power and sees every channel. only the name changes here; who owns the group is the members tab.
                </p>
                <div className="flex items-center justify-end gap-1.5">
                  <Button id="owner-role-cancel" size="sm" onClick={() => setOwnerDraft(null)}>
                    cancel
                  </Button>
                  <Button id="owner-role-save" type="submit" size="sm" variant="primary" className="text-white" disabled={!ownerDraft.trim()}>
                    save
                  </Button>
                </div>
              </div>
            </form>
          ) : room.owner ? (
            <button
              type="button"
              className={ROLE_ROW}
              onClick={() => {
                setDraft(null);
                setOwnerDraft(ownerRole);
              }}
            >
              <OwnerRowBody name={ownerRole} />
              <RiArrowRightSLine aria-hidden size={16} className="shrink-0 text-textTertiary" />
            </button>
          ) : (
            <span className={cn(ROLE_ROW, 'cursor-default hover:bg-transparent')}>
              <OwnerRowBody name={ownerRole} />
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
            const custom = !SWATCHES.includes(open.color.toLowerCase());
            const cooldowns = COOLDOWNS.includes(open.cooldown) ? COOLDOWNS : [...COOLDOWNS, open.cooldown].sort((a, b) => a - b);
            return (
              <li key={role.id} data-role={role.name} data-open className="border border-primaryBlue">
                <form id="role-form" onSubmit={(e) => void save(e)}>
                  <div className="flex items-center gap-2.5 border-b border-primaryStroke px-2.5 py-2">
                    <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[15px] font-semibold" style={{ color: roleInk(open.color) }}>
                      <span aria-hidden className="h-2 w-2 shrink-0" style={{ backgroundColor: open.color }} />
                      <span className="truncate">{open.name.trim() || role.name}</span>
                    </span>
                    <PowerIcons perms={open.perms} color={open.color} />
                    <Button
                      id="role-delete"
                      size="sm"
                      variant="outline-danger"
                      className="gap-1 border-decrease/40 px-2 py-1 text-xs"
                      disabled={removing || !mayWrite}
                      onClick={() => void remove()}
                    >
                      <RiDeleteBinLine aria-hidden size={14} />
                      delete
                    </Button>
                  </div>
                  <div className="flex flex-col gap-2.5 p-2.5">
                    {/* the name, and the colour beside it: three swatches and a square for any other */}
                    <div className="flex items-center gap-2">
                      <input
                        id="role-name"
                        value={open.name}
                        onChange={(e) => setDraft({ ...open, name: e.target.value })}
                        placeholder="role"
                        maxLength={32}
                        aria-label="role name"
                        autoFocus
                        onFocus={(e) => {
                          if (selected.current === e.currentTarget) return;
                          selected.current = e.currentTarget;
                          e.currentTarget.select();
                        }}
                        className={cn(INPUT, 'min-w-0 flex-1')}
                      />
                      <div role="group" aria-label="colour" className="flex shrink-0 items-center gap-1">
                        {SWATCHES.map((swatch) => {
                          const on = swatch === open.color.toLowerCase();
                          return (
                            <Tooltip key={swatch} content={swatch}>
                              <button
                                type="button"
                                aria-label={swatch}
                                aria-pressed={on}
                                onClick={() => setDraft({ ...open, color: swatch })}
                                style={{ backgroundColor: swatch }}
                                className={cn(SWATCH, on ? SWATCH_ON : 'border-transparent')}
                              />
                            </Tooltip>
                          );
                        })}
                        <Tooltip content="any colour">
                          {/* the native picker, unseen over the square; it opens on the click. a colour of its own shows in the square */}
                          <label
                            className={cn(
                              SWATCH,
                              'relative flex cursor-pointer items-center justify-center text-textTertiary focus-within:outline focus-within:outline-1 focus-within:outline-primaryBlue',
                              custom ? SWATCH_ON : 'border-dashed border-secondaryStroke hover:text-textPrimary'
                            )}
                            style={custom ? { backgroundColor: open.color } : undefined}
                          >
                            {!custom && <RiPaletteLine aria-hidden size={15} />}
                            <input
                              id="role-color"
                              type="color"
                              value={open.color}
                              onChange={(e) => setDraft({ ...open, color: e.target.value })}
                              aria-label="any colour"
                              className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                            />
                          </label>
                        </Tooltip>
                      </div>
                    </div>
                    {/* the powers, a tile each: the icon, the name and a few words; the tile is the toggle. one this login lacks is not its to give: greyed, and it says so */}
                    <div role="group" aria-label="powers" className="grid grid-cols-6 gap-1.5 md:grid-cols-[repeat(5,minmax(0,1fr))]">
                      {POWERS.map((power, i) => {
                        const on = open.perms[power.key];
                        return (
                          <PowerTile
                            key={power.key}
                            power={power}
                            id={`role-perm-${power.key}`}
                            on={on}
                            mine={room.perms[power.key]}
                            onToggle={() => setDraft({ ...open, perms: { ...open.perms, [power.key]: !on } })}
                            className={TILE_SPAN[i]}
                          />
                        );
                      })}
                    </div>
                    {/* the cooldown: seconds between its holders' lines, one segment each; off unless a role says otherwise */}
                    <div className="flex flex-col gap-1">
                      <span id="role-cooldown-label" className="text-xs font-semibold text-textSecondary">
                        cooldown
                      </span>
                      <div
                        role="group"
                        aria-labelledby="role-cooldown-label"
                        className="grid divide-x divide-primaryStroke border border-primaryStroke"
                        style={{ gridTemplateColumns: `repeat(${cooldowns.length}, minmax(0, 1fr))` }}
                      >
                        {cooldowns.map((seconds) => (
                          <button
                            key={seconds}
                            id={`role-cooldown-${seconds}`}
                            type="button"
                            aria-pressed={open.cooldown === seconds}
                            onClick={() => setDraft({ ...open, cooldown: seconds })}
                            className={cn(
                              'py-1.5 text-sm font-semibold focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-primaryBlue',
                              open.cooldown === seconds ? 'bg-primaryBlue/10 text-primaryBlue' : 'text-textTertiary hover:text-textPrimary'
                            )}
                          >
                            {cooldownWords(seconds)}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="flex items-center justify-end gap-1.5">
                      <Button id="role-cancel" size="sm" onClick={() => setDraft(null)}>
                        cancel
                      </Button>
                      <Button id="role-save" type="submit" size="sm" variant="primary" className="text-white" disabled={!open.name.trim() || !mayWrite}>
                        save
                      </Button>
                    </div>
                  </div>
                </form>
              </li>
            );
          }
          const body = (
            <>
              <span className="flex min-w-0 flex-1 items-center gap-1.5 font-semibold" style={{ color: roleInk(role.color) }}>
                <span aria-hidden className="h-2 w-2 shrink-0" style={{ backgroundColor: role.color }} />
                <span className="truncate">{role.name}</span>
              </span>
              <PowerIcons perms={role.perms} />
            </>
          );
          return (
            <li key={role.id} data-role={role.name} data-reach={within || undefined} className="border border-primaryStroke">
              {within ? (
                <button
                  type="button"
                  className={ROLE_ROW}
                  onClick={() => {
                    setOwnerDraft(null);
                    setDraft({
                      id: role.id,
                      name: role.name,
                      color: role.color,
                      perms: role.perms,
                      cooldown: role.cooldown ?? 0
                    });
                  }}
                >
                  {body}
                  <RiArrowRightSLine aria-hidden size={16} className="shrink-0 text-textTertiary" />
                </button>
              ) : (
                <span className={cn(ROLE_ROW, 'cursor-default hover:bg-transparent')}>{body}</span>
              )}
            </li>
          );
        })}
      </ul>
      {full ? (
        <p className="text-textTertiary">{ROLE_CAP} roles is the cap. delete one to add another.</p>
      ) : (
        <Button id="role-add" size="sm" className="w-full gap-1.5 py-2 text-primaryBlue" disabled={adding} onClick={() => void add()}>
          <RiAddLine aria-hidden size={16} />
          add role
        </Button>
      )}
    </Section>
  );
}

/** A role's row, closed: the name on the left, its power icons on the right, the chevron after when it opens. */
const ROLE_ROW = 'flex w-full items-center gap-2.5 px-2.5 py-1.5 text-left hover:bg-primaryStroke/20';

/** The owner role's row: the crown and the name in blue, every power lit. */
function OwnerRowBody({ name }: { name: string }) {
  return (
    <>
      <span className="flex min-w-0 flex-1 items-center gap-1.5 font-semibold text-primaryBlue">
        <RiVipCrownLine aria-hidden size={15} className="shrink-0" />
        <span className="truncate">{name}</span>
      </span>
      <PowerIcons perms={ALL_PERMS} color="rgb(var(--primary-color))" />
    </>
  );
}

/** The role editor's colour squares: the first three of COLORS, then one for any other. */
const SWATCHES: string[] = COLORS.slice(0, 3).map((color) => color.toLowerCase());
const SWATCH = 'h-[30px] w-[30px] shrink-0 border-2';
/** The chosen square: a dark ring, a hair of the page inside it so the ring reads on any colour. */
const SWATCH_ON = 'border-textPrimary outline outline-2 -outline-offset-4 outline-background';

const ALL_PERMS: RolePerms = { appearance: true, roles: true, channels: true, kick: true, ban: true };
