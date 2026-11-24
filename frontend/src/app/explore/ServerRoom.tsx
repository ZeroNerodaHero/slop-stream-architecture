import {
  RiAddLine,
  RiArrowLeftSLine,
  RiArrowRightSLine,
  RiCloseLine,
  RiDeleteBinLine,
  RiEmotionLine,
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
  RiTimerLine,
  RiUnpinLine,
  RiUserUnfollowLine,
  RiVipCrownLine,
  RiVolumeUpLine,
  type RemixiconComponentType
} from '@remixicon/react';
import { useAtom, useAtomValue } from 'jotai';
import {
  Fragment,
  memo,
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

import { EmotesSection } from '@/app/explore/EmotesSection';
import { PinSheet, PinSheetButton } from '@/app/explore/PinSheet';
import { VoicePanel } from '@/app/explore/VoicePanel';
import { useVoiceView, VoiceRoom } from '@/app/explore/VoiceRoom';
import {
  api,
  canEditChannel,
  type Channel,
  CHANNEL_CAP,
  type ChannelKind,
  groupBanner,
  type GroupMember,
  type GroupRole,
  type GroupTimeout,
  groupWords,
  homeChannel,
  isVoice,
  messageOf,
  type GroupRoom,
  type PinnedLine,
  type RolePerms,
  VOICE_CHANNEL_CAP
} from '@/infra/api';
import { meAtom, openAuthDialog } from '@/infra/atoms/auth-atoms';
import { type ChatLine, reconnectChat, serverChat } from '@/infra/atoms/chat-atoms';
import { cropPicture } from '@/infra/atoms/crop-atoms';
import { loadMyEmotes } from '@/infra/emotes';
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
  setPinned,
  timeoutsTickAtom
} from '@/infra/atoms/room-atoms';
import { roomMembersOpenAtom } from '@/infra/atoms/settings-atoms';
import { leaveVoice } from '@/infra/atoms/voice-atoms';
import { useIsMobile } from '@/infra/mobile';
import { cleanName, isValidName } from '@/infra/names';
import { GROUP_BANNER, GROUP_ICON } from '@/infra/picture';
import { previewStreamsAtom, setHomePreviews } from '@/infra/preview';
import { store } from '@/infra/store';
import { Badge } from '@/shared-components/Badge';
import { Button, buttonClassName } from '@/shared-components/Button';
import { type ChatSearch, SearchField, SearchFilters, useChatSearch } from '@/shared-components/ChatSearch';
import { ConfirmDialog } from '@/shared-components/ConfirmDialog';
import { Face } from '@/shared-components/Face';
import { RailFace } from '@/shared-components/Friends';
import { GROUP_SWATCHES, GroupColorPick } from '@/shared-components/GroupColorPick';
import { GroupMark } from '@/shared-components/GroupMark';
import { GroupModHost, lineModItems, useCardMod } from '@/shared-components/GroupMod';
import { PAGE_DIALOG, SHEET_CLOSE, SHEET_DIALOG, SheetGrab, focusOnOpen, useSheetBack } from '@/shared-components/MobileSheet';
import { BAR_BUTTON, when } from '@/shared-components/ChatLine';
import { ChatImages, ChatPanel } from '@/shared-components/ChatPanel';
import { ChatVideoPlayer } from '@/shared-components/ChatVideoPlayer';
import { PageFrame } from '@/shared-components/PageFrame';
import { INPUT } from '@/shared-components/input';
import { PersonCard } from '@/shared-components/PersonCard';
import { usePeek } from '@/shared-components/peek';
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

const FACES = 4;

const TILE = 'block overflow-hidden border border-primaryStroke bg-backgroundSecondary transition-[border-color] duration-150 hover:border-primaryBlue';

const RESERVED = new Set(['before', 'search', 'by', 'around']);

const ABOUT_CAP = 200;

const ROOM_GRID = 'grid max-md:snap-start lg:snap-start items-start gap-2 py-[7px] -mb-10 max-md:mb-0 max-md:gap-0 max-md:py-0';
const roomColumns = (membersOpen: boolean) => (membersOpen ? 'lg:grid-cols-[176px_minmax(0,1fr)_224px]' : 'lg:grid-cols-[176px_minmax(0,1fr)_56px]');
const ROOM_CHAT_CONTAINER = '[container-type:inline-size]';
const pinsWidth = (membersOpen: boolean) =>
  cn('w-[max(20rem,80cqw)] max-w-[calc(100vw-2rem)]', !membersOpen && 'lg:w-[max(20rem,calc(0.8*(100cqw_-_168px)))]');
const ROOM_HEIGHT =
  'h-[calc(100dvh-var(--title-row,4rem)-14px)] max-md:h-[calc(var(--vvh,100dvh)-var(--title-row,4rem))] min-h-[420px] max-md:min-h-[min(320px,calc(var(--vvh,100dvh)-var(--title-row,4rem)))]';
const ROOM_CHAT_MOBILE =
  'max-md:min-h-0 max-md:border-0 max-md:bg-background max-md:[&>header]:px-3 max-md:[&_#chat-lines]:px-3 max-md:[&>footer]:px-3 max-md:[&>footer]:pb-[calc(0.5rem+env(safe-area-inset-bottom))] max-md:[html[data-keyboard]_&>footer]:pb-2 max-md:[&>footer]:pt-2';
const STACKED_SNAP = 'md:max-lg:snap-start md:max-lg:snap-always md:max-lg:scroll-mt-[7px]';
const ROSTER_HEIGHT = 'max-h-[calc(100dvh-var(--title-row,4rem)-14px)] lg:h-[calc(100dvh-var(--title-row,4rem)-14px)] lg:min-h-[420px]';

const TOP_VIEW = 'snap-start scroll-mt-6';

const ICON_BUTTON =
  'flex h-7 w-7 max-md:h-11 max-md:w-11 shrink-0 items-center justify-center border border-transparent focus-visible:border-primaryBlue focus-visible:outline-none disabled:cursor-default disabled:opacity-40';

const BELL_HIDDEN = 'opacity-0 transition-opacity duration-150 focus-visible:opacity-100 group-hover/channel:opacity-100 [@media(hover:none)]:opacity-100';

const COLORS = ['#5865f2', '#f85149', '#3fb950', '#f2cc60', '#bc8cff', '#ff9f43', '#39d2c0', '#ff6bcb'] as const;

const ROLE_CAP = 20;

const ORDERS = [
  { id: 'name', label: 'name' },
  { id: 'newest', label: 'newest' },
  { id: 'oldest', label: 'oldest' }
] as const;

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
  { key: 'ban', label: 'ban', short: 'ban & unban', description: 'ban and unban members', Icon: RiForbidLine },
  { key: 'emotes', label: 'emotes', short: 'add, rename, delete', description: "upload, rename and delete the group's custom emotes", Icon: RiEmotionLine }
];

function powerTip(power: (typeof POWERS)[number]): string {
  return `${power.label}: ${power.description}`;
}

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

const TILE_SPAN = POWERS.map(() => 'col-span-2 md:col-span-1');

function roleInk(color: string): string {
  return color.toLowerCase() === '#f2cc60' ? `light-dark(color-mix(in srgb, ${color} 58%, black), ${color})` : color;
}

const NO_PERMS: RolePerms = {
  appearance: false,
  roles: false,
  channels: false,
  kick: false,
  ban: false,
  emotes: false
};

const COOLDOWNS = [0, 5, 15, 30, 60, 300];

function cooldownWords(seconds: number): string {
  if (seconds === 0) return 'off';
  return seconds < 60 ? `${seconds}s` : `${Math.round(seconds / 60)}m`;
}

const TIMEOUTS: { key: string; label: string }[] = [
  { key: '60', label: '1 minute' },
  { key: '600', label: '10 minutes' },
  { key: '3600', label: 'an hour' },
  { key: '86400', label: 'a day' }
];

const EXTENDS: { key: string; label: string }[] = [
  { key: '600', label: '10 more minutes' },
  { key: '3600', label: 'an hour more' },
  { key: '86400', label: 'a day more' }
];

const TIMEOUT_MAX_SECS = 7 * 86400;

function leftWords(unix: number, now: number): string {
  const secs = Math.max(0, Math.ceil(unix - now / 1000));
  if (secs < 60) return `${secs}s left`;
  if (secs < 3600) return `${Math.ceil(secs / 60)}m left`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m left`;
  return `${Math.floor(secs / 86400)}d ${Math.floor((secs % 86400) / 3600)}h left`;
}

function timedOut(member: GroupMember): boolean {
  return (member.timeout ?? 0) * 1000 > Date.now();
}

function untilWords(unix: number): string {
  const at = new Date(unix * 1000);
  const far = at.getTime() - Date.now() > 20 * 3600_000;
  return far ? at.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function reaches(room: GroupRoom, perms: RolePerms): boolean {
  return room.owner || room.admin === true || POWERS.every((power) => !perms[power.key] || room.perms[power.key]);
}

function manages(room: GroupRoom): boolean {
  return room.owner || POWERS.some((power) => power.key !== 'emotes' && room.perms[power.key]);
}

function ownerRoleOf(room: GroupRoom): string {
  return room.owner_role ?? 'owner';
}

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

interface MenuItem {
  key: string;
  label: string;
  color?: string;
}

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

function keptTo(room: GroupRoom, channel: string): GroupRole[] {
  return room.roles.filter((role) => (role.channels ?? []).includes(channel));
}

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

function managesChannels(room: GroupRoom): boolean {
  return room.perms.channels || (room.channels ?? []).some((item) => item.can_delete);
}

function ownsPictures(room: GroupRoom): boolean {
  return room.owner || room.admin === true;
}

type Run = (work: () => Promise<unknown>) => Promise<void>;

function togglePin(server: string, channel: string, id: string, on: boolean): void {
  setPinned(server, channel, id, on).catch((err: unknown) => serverChat(server).showNotice(messageOf(err)));
}

function PinMark() {
  return (
    <Tooltip content="pinned">
      <span role="img" aria-label="pinned" data-pinned-mark className="flex text-primaryBlue">
        <RiPushpinFill aria-hidden size={14} />
      </span>
    </Tooltip>
  );
}

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
                      {pictures.length > 0 && (
                        <div data-pin-pictures={pin.id} className="relative z-10">
                          <ChatImages ids={pictures} small />
                        </div>
                      )}
                      {pin.video && (
                        <div data-pin-video={pin.id} className="relative z-10">
                          <ChatVideoPlayer video={pin.video} small />
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

function LiveFace({ name }: { name: string }) {
  const stream = useAtomValue(previewStreamsAtom)[name] ?? null;
  const ref = useRef<HTMLVideoElement | null>(null);
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

function RoomSearch({ search, input, flat, className }: { search: ChatSearch; input: RefObject<HTMLInputElement | null>; flat: boolean; className?: string }) {
  return (
    <form id="group-search-form" onSubmit={search.submit} className={cn('group/search relative shrink-0', className)}>
      <SearchField
        id="group-search"
        search={search}
        input={input}
        label="search members and every channel"
        leading={
          <Tooltip content="search">
            <button
              id="group-search-go"
              type="submit"
              aria-label="search"
              className={cn(
                'flex h-6 shrink-0 items-center justify-center text-textTertiary hover:text-textPrimary focus-visible:text-primaryBlue focus-visible:outline-none',
                flat ? 'w-6' : 'w-5'
              )}
            >
              <RiSearchLine aria-hidden size={14} />
            </button>
          </Tooltip>
        }
        onKeyDown={(e) => {
          if (e.key === 'Escape') search.setQuery('');
        }}
        inputClassName="text-sm"
      />
      <SearchFilters
        id="group-search-filters"
        search={search}
        className="absolute left-0 right-0 top-full z-10 mt-1 hidden border border-primaryStroke bg-backgroundSecondary px-2 py-1 group-focus-within/search:flex"
      />
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

export function ServerPage() {
  const params = useParams<{ server: string; channel?: string }>();
  const server = cleanName(params.server);
  const me = useAtomValue(meAtom);
  const room = useAtomValue(roomAtom);
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
  const [addingVoice, setAddingVoice] = useState(false);
  const [editingVoice, setEditingVoice] = useState<Channel | null>(null);
  const mobile = useIsMobile();
  const [drawer, setDrawer] = useState(false);
  const voiceView = useVoiceView(room);
  const openVoice = (name: string) => {
    voiceView.open(name);
    setDrawer(false);
  };
  const [pinSheet, setPinSheet] = useState(false);
  const membersOpen = useAtomValue(roomMembersOpenAtom);
  const live = room?.live ?? [];
  const shown = live.slice(0, FACES);
  const previewKey = shown.join(',');
  const channels = (room?.channels ?? []).filter((item) => !isVoice(item));
  const found = channel === home || channels.some((item) => item.name === channel) || renamed?.from === channel;
  const roomRef = useRef<HTMLDivElement | null>(null);
  const landed = useRef(false);

  useEffect(() => {
    if (!ok || me === undefined) return;
    enterRoom(server);
    return () => {
      leaveRoom();
      leaveVoice();
    };
  }, [ok, server, me]);

  useLayoutEffect(() => {
    if (!renamed) return;
    if (renamed.from === channel && params.channel !== undefined)
      navigate(renamed.to === home ? `/groups/${server}` : `/groups/${server}/${renamed.to}`, { replace: true });
    else store.set(channelRenamedAtom, null);
  }, [renamed, channel]);

  const missing = room !== null && !found;
  const wasMissing = useRef(false);
  useEffect(() => {
    if (wasMissing.current && !missing) reloadLines();
    wasMissing.current = missing;
  }, [missing]);

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

  useEffect(() => {
    if (!ok) return;
    const root = document.documentElement;
    root.style.scrollSnapType = 'y mandatory';
    return () => {
      root.style.scrollSnapType = '';
    };
  }, [ok]);

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
      reconnectChat();
      void loadMyEmotes();
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
      void loadMyEmotes();
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

  async function act(work: () => Promise<unknown>) {
    setActionError('');
    try {
      await work();
    } catch (err) {
      setActionError(messageOf(err));
    }
  }

  async function pick(file: File, kind: 'icon' | 'banner') {
    const jpeg = await cropPicture(file, kind === 'icon' ? GROUP_ICON : GROUP_BANNER);
    if (!jpeg) return;
    await act(() => (kind === 'icon' ? api.saveGroupIcon(server, jpeg) : api.saveGroupBanner(server, jpeg)));
  }

  const words = groupWords(room);
  const color = room.color || '#5865f2';
  const banner = groupBanner(server, room.banner, 'wide');
  const mine = room.mine;
  const noChannel = !found;
  const power = room.owner || POWERS.some((item) => room.perms[item.key]);
  const canManage = power || managesChannels(room);
  const lastMember = mine && room.members <= 1;
  const canPicture = ownsPictures(room);
  const onAddVoice = room.perms.channels && mine ? () => setAddingVoice(true) : undefined;
  const voiceFull = (room.channels ?? []).filter(isVoice).length >= VOICE_CHANNEL_CAP;
  const membersWords = room.members === 1 ? '1 member' : `${room.members} members`;
  const liveWords = live.length === 1 ? '1 streaming now' : `${live.length} streaming now`;
  const pinnedHere = new Set(room.pins?.[channel] ?? []);

  const groupHead = (
    <>
      <div className={cn('relative mb-16', TOP_VIEW)}>
        <div id="group-banner" className="group/banner relative h-36 overflow-hidden border border-primaryStroke" style={{ backgroundColor: color }}>
          {banner && <img src={banner.src} srcSet={banner.srcSet} sizes="max(100vw, 36rem)" alt="" className="h-full w-full object-cover" />}
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
              <div className={cn('flex min-w-0 flex-col gap-3', STACKED_SNAP)}>
                {channelList}
                {liveList}
              </div>
            )}
            <div className={cn('min-w-0', ROOM_CHAT_CONTAINER, ROOM_HEIGHT, STACKED_SNAP)}>
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
                  lineMenu={(line) => lineModItems(room, me, line.channel ?? channel, line)}
                  className={cn('h-full', ROOM_CHAT_MOBILE)}
                />
              )}
            </div>
            {!mobile && (
              <div className={cn('flex min-w-0 flex-col gap-2', ROSTER_HEIGHT, STACKED_SNAP)}>
                <VoicePanel room={room} onAdd={onAddVoice} addFull={voiceFull} onEdit={setEditingVoice} onOpen={openVoice} className={cn(!membersOpen && 'lg:hidden')} />
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
                    <VoicePanel room={room} onAdd={onAddVoice} addFull={voiceFull} onEdit={setEditingVoice} onOpen={openVoice} flat />
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
  boxed: boolean;
  onError: (error: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Channel | null>(null);
  const channels = room.channels ?? [];
  const textChannels = channels.filter((item) => !isVoice(item));
  const voiceView = useVoiceView(room).view;
  const muted = room.muted ?? [];
  const canAdd = room.perms.channels && room.mine;
  const canMute = room.mine && me !== null;
  const full = textChannels.length >= CHANNEL_CAP;
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
          const here = item.name === channel && !voiceView;
          const isMuted = muted.includes(item.name);
          return (
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
          {CHANNEL_CAP} text channels is the cap. delete one to add another.
        </p>
      )}
      {canAdd && !full && (
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

function channelNameFault(clean: string, channels: Channel[]): string {
  if (!isValidName(clean)) return '';
  if (RESERVED.has(clean)) return `${clean} is a word the history routes use, so it cannot be a channel.`;
  if (channels.some((item) => item.name === clean)) return `there is a #${clean} already.`;
  return '';
}

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

const PEEK_MS = 200;

const Member = memo(function Member({ member, live, ownerRole, flat }: { member: GroupMember; live: boolean; ownerRole: string; flat: boolean }) {
  const presence = useAtomValue(presenceOfAtom(member.name));
  const peek = usePeek(PEEK_MS);
  const actions = useCardMod(member.name, peek.close);
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
      {peek.at && (
        <PersonCard
          id={`roster-peek-${member.name}`}
          person={{ name: member.name, verified: true, avatar: member.avatar ?? null, presence }}
          at={peek.at}
          actions={actions}
          follow
          below={heard && <VoiceLevel id={`roster-peek-${member.name}-level`} name={member.name} uid={heard} pin={peek.hold.pin} />}
          hold={peek.hold}
        />
      )}
    </li>
  );
});

function rosterQuery(query: string): string {
  return query
    .split(/\s+/)
    .map((word) => word.replace(/^from:/i, ''))
    .filter((word) => word && !/^(has|before|after|channel|in):/i.test(word))
    .join(' ')
    .toLowerCase();
}

const ROSTER_SEARCH_MS = 250;

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

const ROSTER_FILL = 'max-h-none min-h-0 flex-1 lg:h-auto lg:min-h-0';

function Roster({ room, flat = false, fill = false }: { room: GroupRoom; flat?: boolean; fill?: boolean }) {
  const members = room.roster ?? [];
  const live = room.live ?? [];
  const presences = useAtomValue(presencesAtom);
  const input = useRef<HTMLInputElement | null>(null);
  const [membersOpen, setMembersOpen] = useAtom(roomMembersOpenAtom);
  const folded = !flat && !membersOpen;
  const hideRef = useRef<HTMLButtonElement | null>(null);
  const showRef = useRef<HTMLButtonElement | null>(null);
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
  const partial = !!room.roster_next;
  const found = useRosterSearch(room.name, partial ? q : '', listRef);
  const matched = q ? members.filter((member) => member.name.toLowerCase().includes(q) || member.roles.some((role) => role.name.toLowerCase().includes(q))) : members;
  const shown = found.hits ?? matched;
  const pending = partial && !!q && found.hits === null;
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
            {moreRow && <ul className="flex flex-col">{moreRow}</ul>}
          </>
        ) : (
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

type ManageTab = 'about' | 'channels' | 'roles' | 'emotes' | 'members' | 'timeouts' | 'bans';

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
    id: 'emotes',
    label: 'emotes',
    group: 'group',
    icon: <RiEmotionLine aria-hidden size={18} />,
    shown: (room) => room.perms.emotes === true
  },
  {
    id: 'members',
    label: 'members',
    group: 'members',
    icon: <RiGroupLine aria-hidden size={18} />,
    shown: (room) => manages(room)
  },
  {
    id: 'timeouts',
    label: 'timeouts',
    group: 'members',
    icon: <RiTimerLine aria-hidden size={18} />,
    shown: (room) => room.perms.kick
  },
  {
    id: 'bans',
    label: 'bans',
    group: 'members',
    icon: <RiForbidLine aria-hidden size={18} />,
    shown: (room) => room.perms.ban
  }
];

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

function ManageDialog({ server, channel, room, me, onClose }: { server: string; channel: string; room: GroupRoom; me: string | null; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const pressedBackdrop = useRef(false);
  const [error, setError] = useState('');
  const [picked, setPicked] = useState<ManageTab | null>(null);
  const [deleting, setDeleting] = useState(false);
  const navigate = useNavigate();
  const words = groupWords(room);
  const tabs = MANAGE_TABS.filter((item) => item.shown(room));
  const tab = tabs.find((item) => item.id === picked)?.id ?? tabs[0]?.id ?? null;
  useLayoutEffect(() => setError(''), [tab]);

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    dialog.showModal();
    dialog.querySelector<HTMLElement>('#group-manage-title')?.focus();
    return () => {
      if (!dialog.open) return;
      dialog.close();
      onCloseRef.current();
    };
  }, []);

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

  function pick(next: ManageTab) {
    setPicked(next);
    setError('');
  }

  function rove(e: KeyboardEvent<HTMLDivElement>) {
    const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    const i = buttons.indexOf(e.target as HTMLButtonElement);
    if (i < 0) return;
    const step = RAIL_STEP[e.key];
    const next = step !== undefined ? (i + step + buttons.length) % buttons.length : e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : -1;
    const target = tabs[next];
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
        if (event.target !== event.currentTarget) return;
        onClose();
      }}
      className={cn(
        'm-auto h-[min(680px,calc(100dvh-3rem))] w-[min(880px,calc(100vw-3rem))] overflow-hidden border border-primaryStroke bg-backgroundSecondary p-0 text-base text-textPrimary',
        'flex-col open:flex sm:flex-row backdrop:bg-black/60',
        PAGE_DIALOG
      )}
    >
      <div className="flex shrink-0 flex-col border-b border-primaryStroke bg-background sm:w-52 sm:border-b-0 sm:border-r">
        <div className="hidden items-center gap-3 border-b border-primaryStroke px-3 py-3 sm:flex">
          <GroupMark name={server} color={room.color || '#5865f2'} icon={room.icon} className="h-9 w-9 text-base" />
          <span className="min-w-0">
            <span className="block truncate font-semibold leading-tight">{words.title}</span>
            <span className="block text-xs text-textTertiary">{words.tag ? `#${words.tag}` : 'manage'}</span>
          </span>
        </div>
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
          <p id="group-manage-error" aria-live="polite" className="min-h-[1.5em] pt-3 text-sm text-decrease">
            {error}
          </p>
          <div className="pt-1 text-sm">
            {tab === null && (
              <p className="text-textSecondary">you have no powers here now.</p>
            )}
            {tab === 'about' && (
              <div className="divide-y divide-primaryStroke">
                {ownsPictures(room) && <PicturesSection server={server} room={room} run={run} />}
                <ColorSection server={server} room={room} run={run} />
                <AboutSection server={server} room={room} run={run} />
                <ListingSection server={server} room={room} run={run} />
                {(room.owner || room.admin) && <AdultSection server={server} room={room} run={run} />}
              </div>
            )}
            {tab === 'channels' && <ChannelsSection server={server} channel={channel} room={room} run={run} />}
            {tab === 'roles' && <RolesSection server={server} room={room} run={run} />}
            {tab === 'emotes' && <EmotesSection server={server} />}
            {tab === 'members' && <MembersSection server={server} room={room} me={me} run={run} />}
            {tab === 'timeouts' && <TimeoutsSection server={server} room={room} run={run} />}
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

function PicturesSection({ server, room, run }: ManageProps) {
  const color = room.color || '#5865f2';
  const banner = groupBanner(server, room.banner, 'wide');

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
      <div className="flex min-w-48 flex-1 flex-col gap-2">
        <h3 className={SECTION_TITLE}>group banner</h3>
        <div id="manage-banner" className="group/banner relative h-24 overflow-hidden border border-primaryStroke" style={{ backgroundColor: color }}>
          {banner && <img src={banner.src} srcSet={banner.srcSet} sizes="max(100vw, 24rem)" alt="" className="h-full w-full object-cover" />}
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

function ListingSection({ server, room, run }: ManageProps) {
  const isPublic = room.public !== false;
  return (
    <Section title="listing" description="public is on the lists for anyone. private is off them: someone with the address can still open it and join.">
      <VisibilityToggle isPublic={isPublic} ids={['room-public', 'room-private']} onChange={(next) => void run(() => api.setGroupPublic(server, next))} />
    </Section>
  );
}

function AdultSection({ server, room, run }: ManageProps) {
  const on = room.adult === true;
  const why = on ? null : room.adult_locked ? 'a site admin turned adult content off here, so it stays off' : room.owner ? null : 'site admins can only turn adult content off';
  return (
    <Section
      title="adult content"
      description="on: sexual pictures are allowed in this group, blurred until clicked, and the group and its member list are off every list and search. only its address or an invite opens it. off: sexual pictures are refused, and those already posted are hidden."
    >
      <p className="flex flex-wrap items-center gap-2">
        <span id="group-adult-state" className="text-textSecondary">
          {on ? 'on' : room.adult_locked ? 'off, locked' : 'off'}
        </span>
        <Button
          id="group-adult"
          size="sm"
          variant={on ? 'outline-danger' : 'secondary'}
          disabled={why !== null}
          aria-describedby={why ? 'group-adult-state group-adult-why' : 'group-adult-state'}
          onClick={() => void run(() => api.setGroupAdult(server, !on))}
        >
          {on ? 'turn off' : 'turn on'}
        </Button>
        {room.admin && room.adult_locked && (
          <Button id="group-adult-unlock" size="sm" variant="secondary" onClick={() => void run(() => api.liftGroupAdultLock(server))}>
            lift lock
          </Button>
        )}
      </p>
      {why && (
        <p id="group-adult-why" className="mt-1 text-xs text-textTertiary">
          {why}
        </p>
      )}
    </Section>
  );
}

function MembersSection({ server, room, me, run }: ManageProps & { me: string | null }) {
  const [handing, setHanding] = useState<string | null>(null);
  const members = room.roster ?? [];
  const more = useAtomValue(rosterMoreAtom);
  const owners = members.filter((member) => member.owner).length;
  const order = room.member_order === 'newest' || room.member_order === 'oldest' ? room.member_order : 'name';
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
          const touch = room.perms.roles && (!member.owner || room.owner);
          const offer = touch ? room.roles.filter((role) => !member.roles.some((held) => held.id === role.id) && reaches(room, role.perms)) : [];
          const removable = member.name !== me && (!member.owner || (room.owner && owners > 1));
          const handable = room.owner && !member.owner && member.name !== me;
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

function TimeoutsSection({ server, run }: ManageProps) {
  const tick = useAtomValue(timeoutsTickAtom);
  const [list, setList] = useState<GroupTimeout[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let live = true;
    api.groupTimeouts(server).then(
      (rows) => {
        if (!live) return;
        setList(rows);
        setFailed(false);
      },
      () => live && setFailed(true)
    );
    return () => {
      live = false;
    };
  }, [server, tick]);

  const running = (list ?? []).filter((item) => item.until * 1000 > now);
  const ticking = running.length > 0;
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);

  return (
    <Section title="timeouts" description="who cannot say anything in the group's channels right now, the soonest to end first.">
      {list === null ? (
        <p className="text-textTertiary">{failed ? "couldn't load the timeouts." : 'loading…'}</p>
      ) : running.length === 0 ? (
        <p id="group-timeouts-empty" className="text-textTertiary">
          nobody is timed out.
        </p>
      ) : (
        <ul id="group-timeouts" className="flex flex-col gap-2">
          {running.map((item) => {
            const remaining = item.until - Math.floor(now / 1000);
            const more = remaining < TIMEOUT_MAX_SECS ? EXTENDS : [];
            return (
              <li key={item.name} data-timeout={item.name} className="flex items-start gap-2 border border-primaryStroke px-2 py-1.5">
                <Face name={item.name} version={item.avatar} className="h-8 w-8 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-semibold">{item.name}</span>
                    {!item.member && <span className="text-xs text-textTertiary">left the group</span>}
                  </div>
                  <p className="text-textSecondary">
                    until {untilWords(item.until)} · <span className="whitespace-nowrap tabular-nums text-decrease">{leftWords(item.until, now)}</span>
                  </p>
                  {item.reason && <p className="break-words text-textTertiary">{item.reason}</p>}
                  {item.by && <p className="text-xs text-textTertiary">by {item.by}</p>}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {item.member && more.length > 0 && (
                    <HoverMenu
                      label={`extend ${item.name}'s timeout`}
                      items={more}
                      onPick={(add) => {
                        const seconds = Math.min(TIMEOUT_MAX_SECS, Math.max(0, item.until - Math.floor(Date.now() / 1000)) + Number(add));
                        void run(() => api.timeoutMember(server, item.name, seconds, item.reason));
                      }}
                      className={buttonClassName('secondary', undefined, 'sm')}
                    >
                      extend
                    </HoverMenu>
                  )}
                  <Button id={`timeouts-lift-${item.name}`} size="sm" variant="outline" onClick={() => void run(() => api.liftTimeout(server, item.name))}>
                    lift
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
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

interface ChannelDraft {
  from: string;
  name: string;
  roles: string[];
  cooldown: number;
}

function freshChannelName(channels: Channel[], kind: ChannelKind = 'text'): string {
  const taken = new Set(channels.map((item) => item.name));
  const word = kind === 'voice' ? 'new-voice' : 'new-channel';
  if (!taken.has(word)) return word;
  let n = 2;
  while (taken.has(`${word}-${n}`)) n += 1;
  return `${word}-${n}`;
}

function withinKind(channels: Channel[], voice: boolean, kindOrder: string[]): string[] {
  let i = 0;
  return channels.map((item) => (isVoice(item) === voice ? (kindOrder[i++] ?? item.name) : item.name));
}

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

type ChannelReorder = ReturnType<typeof useReorder<string>>;

function ChannelsSection({ server, channel, room, run }: ManageProps & { channel: string }) {
  const navigate = useNavigate();
  const channels = room.channels ?? [];
  const textNames = channels.filter((item) => !isVoice(item)).map((item) => item.name);
  const voiceNames = channels.filter(isVoice).map((item) => item.name);
  const byName = new Map(channels.map((item) => [item.name, item]));
  const orders = room.perms.channels;
  const home = homeChannel(channels);
  const [draft, setDraft] = useState<ChannelDraft | null>(null);
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sure, setSure] = useState<string | null>(null);
  const selected = useRef<HTMLInputElement | null>(null);
  const textFull = textNames.length >= CHANNEL_CAP;
  const voiceFull = voiceNames.length >= VOICE_CHANNEL_CAP;
  const voiceCount = voiceNames.length;
  const open = draft !== null && byName.has(draft.from) ? draft : null;
  const textReorder = useReorder({
    keys: textNames,
    name: (name) => `#${name}`,
    onMove: (name, to) => void run(() => setChannelOrder(server, withinKind(channels, false, movedTo(textNames, name, to))))
  });
  const voiceReorder = useReorder({
    keys: voiceNames,
    name: (name) => `voice channel ${name}`,
    onMove: (name, to) => void run(() => setChannelOrder(server, withinKind(channels, true, movedTo(voiceNames, name, to))))
  });

  function draftOf(item: Channel): ChannelDraft {
    return { from: item.name, name: item.name, roles: keptTo(room, item.name).map((role) => role.id), cooldown: item.cooldown ?? 0 };
  }

  async function add(kind: ChannelKind) {
    setAdding(true);
    try {
      await run(async () => {
        const made = await api.createChannel(server, freshChannelName(channels, kind), '', kind);
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

  function row(name: string, reorder: ChannelReorder) {
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
                <Button id="channel-delete" size="sm" variant="outline-danger" className="gap-1 border-decrease/40 px-2 py-1 text-xs" onClick={() => setSure(name)}>
                  <RiDeleteBinLine aria-hidden size={14} />
                  delete
                </Button>
              )}
            </div>
            <div className="flex flex-col gap-2.5 p-2.5">
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
                            onClick={() => why === null && setDraft({ ...open, roles: on ? open.roles.filter((id) => id !== role.id) : [...open.roles, role.id] })}
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
  }

  return (
    <>
      <Section title="text channels" description={`${textNames.length} of ${CHANNEL_CAP}`}>
        <div className="relative">
          <ul id="manage-channels" {...textReorder.list} className="flex flex-col gap-1">
            {textReorder.order.map((name) => row(name, textReorder))}
          </ul>
          {textReorder.status}
        </div>
        {orders &&
          (textFull ? (
            <p id="manage-channels-full" className="text-textTertiary">
              {CHANNEL_CAP} text channels is the cap. delete one to add another.
            </p>
          ) : (
            <Button id="manage-channel-add" size="sm" className="w-full gap-1.5 py-2 text-primaryBlue" disabled={adding} onClick={() => void add('text')}>
              <RiAddLine aria-hidden size={16} />
              add channel
            </Button>
          ))}
      </Section>
      <Section title="voice channels" description={`${voiceNames.length} of ${VOICE_CHANNEL_CAP}`}>
        <div className="relative">
          <ul id="manage-voice-channels" {...voiceReorder.list} className="flex flex-col gap-1">
            {voiceReorder.order.map((name) => row(name, voiceReorder))}
          </ul>
          {voiceReorder.status}
        </div>
        {orders && (
          <Tooltip content={voiceFull ? `${VOICE_CHANNEL_CAP} voice channels at most. delete one to add another.` : null}>
            <Button
              id="manage-voice-add"
              size="sm"
              aria-disabled={voiceFull || undefined}
              className={cn('w-full gap-1.5 py-2 text-primaryBlue', voiceFull && 'cursor-not-allowed opacity-50 hover:bg-transparent')}
              disabled={adding}
              onClick={() => {
                if (!voiceFull) void add('voice');
              }}
            >
              <RiAddLine aria-hidden size={16} />
              add voice channel
            </Button>
          </Tooltip>
        )}
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
    </>
  );
}

interface RoleDraft {
  id: string;
  name: string;
  color: string;
  perms: RolePerms;
  cooldown: number;
}

function freshRoleName(roles: GroupRole[]): string {
  const taken = new Set(roles.map((role) => role.name.toLowerCase()));
  if (!taken.has('new role')) return 'new role';
  let n = 2;
  while (taken.has(`new role ${n}`)) n += 1;
  return `new role ${n}`;
}

function RolesSection({ server, room, run }: ManageProps) {
  const [draft, setDraft] = useState<RoleDraft | null>(null);
  const [ownerDraft, setOwnerDraft] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState(false);
  const selected = useRef<HTMLInputElement | null>(null);
  const full = room.roles.length >= ROLE_CAP;
  const ownerRole = ownerRoleOf(room);
  const open = draft !== null && room.roles.some((role) => role.id === draft.id) ? draft : null;

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

  async function saveOwner(e: FormEvent) {
    e.preventDefault();
    if (ownerDraft === null || !ownerDraft.trim()) return;
    await run(async () => {
      await api.renameOwnerRole(server, ownerDraft.trim());
      setOwnerDraft(null);
    });
  }

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
                <div role="group" aria-label="powers" className="grid grid-cols-6 gap-1.5 md:grid-cols-[repeat(6,minmax(0,1fr))]">
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
          const within = reaches(room, role.perms);
          if (open?.id === role.id) {
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
                    <div role="group" aria-label="powers" className="grid grid-cols-6 gap-1.5 md:grid-cols-[repeat(6,minmax(0,1fr))]">
                      {POWERS.map((power, i) => {
                        const on = open.perms[power.key] === true;
                        return (
                          <PowerTile
                            key={power.key}
                            power={power}
                            id={`role-perm-${power.key}`}
                            on={on}
                            mine={room.perms[power.key] === true}
                            onToggle={() => setDraft({ ...open, perms: { ...open.perms, [power.key]: !on } })}
                            className={TILE_SPAN[i]}
                          />
                        );
                      })}
                    </div>
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

const ROLE_ROW = 'flex w-full items-center gap-2.5 px-2.5 py-1.5 text-left hover:bg-primaryStroke/20';

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

const SWATCHES: string[] = COLORS.slice(0, 3).map((color) => color.toLowerCase());
const SWATCH = 'h-[30px] w-[30px] shrink-0 border-2';
const SWATCH_ON = 'border-textPrimary outline outline-2 -outline-offset-4 outline-background';

const ALL_PERMS: RolePerms = { appearance: true, roles: true, channels: true, kick: true, ban: true, emotes: true };
