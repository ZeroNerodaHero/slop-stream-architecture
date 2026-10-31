import {
  RiCloseLine,
  RiDeleteBinLine,
  RiForbidLine,
  RiGroupLine,
  RiInformationLine,
  RiLogoutBoxRLine,
  RiNotificationOffLine,
  RiSearchLine,
  RiSettings3Line,
  RiShieldStarLine
} from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { api, CHANNEL_CAP, groupImage, type GroupMember, type GroupRole, groupWords, messageOf, type GroupRoom, type RolePerms } from '@/infra/api';
import { meAtom } from '@/infra/atoms/auth-atoms';
import { reconnectChat } from '@/infra/atoms/chat-atoms';
import { cropPicture } from '@/infra/atoms/crop-atoms';
import { PRESENCE_WORD, presenceOfAtom } from '@/infra/atoms/presence-atoms';
import { enterRoom, leaveRoom, reloadRoom, roomAtom, roomErrorAtom, roomGoneAtom, setChannelMuted } from '@/infra/atoms/room-atoms';
import { cleanName, isValidName } from '@/infra/names';
import { GROUP_BANNER, GROUP_ICON } from '@/infra/picture';
import { previewStreamsAtom, setHomePreviews } from '@/infra/preview';
import { Badge } from '@/shared-components/Badge';
import { Button, buttonClassName } from '@/shared-components/Button';
import { SearchFilters, useChatSearch } from '@/shared-components/ChatSearch';
import { ConfirmDialog } from '@/shared-components/ConfirmDialog';
import { Face } from '@/shared-components/Face';
import { GroupMark } from '@/shared-components/GroupMark';
import { ChatPanel } from '@/shared-components/ChatPanel';
import { PageFrame } from '@/shared-components/PageFrame';
import { PresenceSquare } from '@/shared-components/PersonRow';
import { PicturePick } from '@/shared-components/PicturePick';
import { Bone, Skeleton } from '@/shared-components/Skeleton';
import { Tooltip } from '@/shared-components/Tooltip';
import { Section } from '@/shared-components/user-modal/parts';
import { cn } from '@/utils/cn';

/** Cameras played in the room. The same peers home uses, muted, and not counted as viewers. */
const FACES = 4;

const TILE = 'block overflow-hidden border border-primaryStroke bg-backgroundSecondary transition-[border-color] duration-150 hover:border-primaryBlue';

const RESERVED = new Set(['before', 'search', 'by', 'around']);

const INPUT = 'min-w-0 flex-1 border border-primaryStroke bg-background px-3 py-2 text-base text-textPrimary placeholder:text-textTertiary';

/**
 * The room is the window: its height is the window's less the title row it sits under (4rem,
 * PageFrame.tsx, which globals.css also makes the page's `scroll-padding-top`) and the page's
 * foot (`pb-10`, 2.5rem). So the room scrolled to is exactly what the window shows, and the
 * page can scroll exactly that far. The roster's column may not pass it.
 */
const ROOM_HEIGHT = 'h-[calc(100dvh-6.5rem)] min-h-[420px]';
const ROSTER_HEIGHT = 'max-h-[calc(100dvh-6.5rem)]';

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

const COLORS = ['#5865f2', '#f85149', '#3fb950', '#f2cc60', '#bc8cff', '#ff9f43', '#39d2c0', '#ff6bcb'] as const;

/** Matches `MAX_ROLES` in the api. */
const ROLE_CAP = 20;

const ORDERS = [
  { id: 'name', label: 'name' },
  { id: 'newest', label: 'newest' },
  { id: 'oldest', label: 'oldest' }
] as const;

const POWERS: { key: keyof RolePerms; label: string }[] = [
  { key: 'appearance', label: 'about and public' },
  { key: 'roles', label: 'roles' },
  { key: 'channels', label: 'channels' },
  { key: 'kick', label: 'kick' },
  { key: 'ban', label: 'ban' }
];

const NO_PERMS: RolePerms = { appearance: false, roles: false, channels: false, kick: false, ban: false };

/**
 * Whether this login may make, change, delete, give or take a role with these powers: an owner
 * and a site admin may any; anyone else only one whose every power they hold themselves. The
 * api's rule, so the page offers nothing the api refuses.
 */
function reaches(room: GroupRoom, perms: RolePerms): boolean {
  return room.owner || room.admin === true || POWERS.every((power) => !perms[power.key] || room.perms[power.key]);
}

/** Whether this login has anything to manage: a power the dialog holds. Channels are the list's own, on the left. */
function manages(room: GroupRoom): boolean {
  return room.owner || room.perms.appearance || room.perms.roles || room.perms.kick || room.perms.ban;
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
 * The room's search box, in the header between the gear and leave: the channel on screen is
 * asked for the words on enter or the glass, and the filter words stand under the box while it
 * has the focus (ChatSearch.tsx). The hits are the chat panel's results list, as they would be
 * from its own box, which this page leaves out (`search={false}`).
 */
function RoomSearch({ channel }: { channel: string }) {
  const input = useRef<HTMLInputElement | null>(null);
  const search = useChatSearch(input);
  return (
    <form id="room-search-form" onSubmit={search.submit} className="group/search relative">
      <label htmlFor="room-search" className="sr-only">
        search #{channel}
      </label>
      <input
        ref={input}
        id="room-search"
        value={search.query}
        onChange={(e) => search.setQuery(e.target.value)}
        placeholder={`search #${channel}`}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        className="h-7 w-48 border border-primaryStroke bg-background pl-7 pr-2 text-sm text-textPrimary placeholder:text-textTertiary"
      />
      <button
        id="room-search-go"
        type="submit"
        aria-label="search"
        className="absolute left-0 top-0 flex h-7 w-7 items-center justify-center text-textTertiary hover:text-textPrimary focus-visible:text-primaryBlue focus-visible:outline-none"
      >
        <RiSearchLine aria-hidden size={14} />
      </button>
      <SearchFilters
        id="room-search-filters"
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

/**
 * The room's shape in grey while it is asked for: the banner with the picture over its foot,
 * the title and the line about it, then the channels beside the chat (the roster's column is
 * not guessed at: it is a member's, and the chat only narrows when it comes). The answer lands
 * on top of this instead of under a word. `gridRef` is the room's place: the page scrolls to
 * it while this shows, so the room lands where the window already is.
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
      <div className="mb-6 flex flex-col gap-2 pl-4">
        <Bone className="h-6 w-56 max-w-full" />
        <Bone className="h-4 w-80 max-w-full" />
      </div>
      <div ref={gridRef} className="grid snap-start items-start gap-4 lg:grid-cols-[200px_minmax(0,1fr)]">
        <div className="flex flex-col gap-1.5">
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
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [leaving, setLeaving] = useState(false);
  const [managing, setManaging] = useState(false);
  const live = room?.live ?? [];
  const shown = live.slice(0, FACES);
  const previewKey = shown.join(',');
  const channels = room?.channels ?? [];
  const found = channel === 'general' || channels.some((item) => item.name === channel);
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
  const roster = mine || power || !!room.roster;
  const canManage = manages(room);
  const lastMember = mine && room.members <= 1;
  // the pictures are the owner's: no role carries them. a site admin may, as with every power but naming an owner
  const canPicture = room.owner || room.admin === true;

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
          <div className="mb-6 flex flex-wrap items-start justify-between gap-3 pl-4">
            <div className="min-w-0">
              <h2 className="flex flex-wrap items-center gap-2 text-xl font-semibold">
                {words.title}
                {words.tag && <span className="text-base font-normal text-textTertiary">#{words.tag}</span>}
                {room.owner && <span className="bg-primaryBlue/15 px-1.5 py-0.5 text-xs uppercase text-primaryBlue">owner</span>}
                {room.public === false && <span className="bg-primaryStroke px-1.5 py-0.5 text-xs uppercase text-textSecondary">private</span>}
                <span id="group-members-count" className="text-sm font-normal text-textTertiary">
                  {room.members === 1 ? '1 member' : `${room.members} members`}
                </span>
              </h2>
              {room.about && (
                <p id="group-about-line" className="mt-1 max-w-xl text-textSecondary">
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
              <RoomSearch channel={channel} />
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
          <div
            id="group-room"
            ref={roomRef}
            className={cn('grid snap-start items-start gap-4', roster ? 'lg:grid-cols-[200px_minmax(0,1fr)_240px]' : 'lg:grid-cols-[200px_minmax(0,1fr)]')}
          >
            <div className="flex min-w-0 flex-col gap-6">
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
              <ChatPanel name={server} channel={channel} search={false} className="h-full" />
            </div>
            {roster && <Roster room={room} />}
          </div>
          {managing && <ManageDialog server={server} room={room} me={me ?? null} onClose={() => setManaging(false)} />}
        </>
      )}
    </PageFrame>
  );
}

/**
 * The channels, `general` first. Adding one takes the channels power, and stops at the cap
 * (CHANNEL_CAP, the api's). Who made a channel, or anyone with the power, deletes it; `general`
 * stays. A channel added or deleted anywhere arrives on the socket and the list follows. A
 * member mutes a channel here (docs/notifications.md): its lines stop reaching their bell, and
 * the bell-off mark sits by its name until they unmute it.
 */
function ChannelList({ server, channel, room, me, onError }: { server: string; channel: string; room: GroupRoom; me: string | null; onError: (error: string) => void }) {
  const [name, setName] = useState('');
  const [sure, setSure] = useState<string | null>(null);
  const clean = cleanName(name);
  const channels = room.channels ?? [];
  const muted = room.muted ?? [];
  const canAdd = room.perms.channels && room.mine;
  // the mute is a member's: a stranger gets no row to mute
  const canMute = room.mine && me !== null;
  const full = channels.length >= CHANNEL_CAP;
  const valid = isValidName(clean) && !RESERVED.has(clean) && !channels.some((item) => item.name === clean);

  async function mute(item: string, on: boolean) {
    onError('');
    try {
      await setChannelMuted(server, item, on);
    } catch (err) {
      onError(messageOf(err));
    }
  }

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!valid || full) return;
    onError('');
    try {
      await api.createChannel(server, clean);
      setName('');
    } catch (err) {
      onError(messageOf(err));
    }
  }

  async function remove(item: string) {
    onError('');
    try {
      await api.deleteChannel(server, item);
      setSure(null);
    } catch (err) {
      onError(messageOf(err));
    }
  }

  return (
    <nav aria-label="channels">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-textTertiary">
        channels{' '}
        <span id="group-channels-count" className="font-normal normal-case tracking-normal">
          {channels.length} of {CHANNEL_CAP}
        </span>
      </h3>
      <ul id="group-channels" className="flex flex-col gap-0.5">
        {channels.map((item) => {
          const here = item.name === channel;
          const isMuted = muted.includes(item.name);
          // who made it, or the channels power; never general. kept right here, as channels and powers come and go
          const canDelete = item.name !== 'general' && ((item.made_by != null && item.made_by === me) || room.perms.channels || item.can_delete);
          // the bell-off mark by a muted channel's name: this login hears nothing from it
          const mark = isMuted && <RiNotificationOffLine aria-label="muted" size={12} className="ml-1 inline-block shrink-0 align-[-1px] text-textTertiary" />;
          return (
            <li key={item.name} data-muted={isMuted || undefined} className="flex items-center gap-1">
              {here ? (
                <span aria-current="page" className="min-w-0 flex-1 truncate bg-primaryStroke/40 px-2 py-1 font-semibold">
                  #{item.name}
                  {mark}
                </span>
              ) : (
                <Link
                  id={`group-channel-${item.name}`}
                  to={item.name === 'general' ? `/groups/${server}` : `/groups/${server}/${item.name}`}
                  className="min-w-0 flex-1 truncate px-2 py-1 text-textSecondary hover:bg-primaryStroke/20 hover:text-textPrimary"
                >
                  #{item.name}
                  {mark}
                </Link>
              )}
              {canMute && (
                <button
                  id={`channel-mute-${item.name}`}
                  type="button"
                  aria-pressed={isMuted}
                  title={
                    isMuted
                      ? 'muted: its lines do not reach your bell. unmute to hear it again'
                      : 'mute: its lines stop reaching your bell. the chat itself is not touched'
                  }
                  className={cn('px-1 text-xs', isMuted ? 'text-primaryBlue' : 'text-textTertiary hover:text-textPrimary')}
                  onClick={() => void mute(item.name, !isMuted)}
                >
                  {isMuted ? 'unmute' : 'mute'}
                </button>
              )}
              {canDelete && (
                <button type="button" className="px-1 text-xs text-textTertiary" onClick={() => setSure(item.name)}>
                  delete
                </button>
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
        <form onSubmit={(e) => void add(e)} className="mt-3 flex flex-col gap-2">
          <input
            id={`channel-name-${server}`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="new channel"
            maxLength={32}
            aria-label={`new channel in ${server}`}
            className={INPUT}
          />
          <button id={`channel-create-${server}`} type="submit" className="self-start text-sm font-semibold text-primaryBlue disabled:opacity-40" disabled={!valid}>
            add
          </button>
        </form>
      )}
      {sure && (
        <ConfirmDialog
          id={`channel-delete-${server}-${sure}`}
          title={`delete #${sure}?`}
          message="the channel goes."
          yes="yes, delete"
          onYes={() => {
            const item = sure;
            setSure(null);
            void remove(item);
          }}
          onNo={() => setSure(null)}
        />
      )}
    </nav>
  );
}

/**
 * One member of the roster: the face with the presence square on its corner (the sidebar's
 * way, docs/status.md; the word for a reader), the name, `owner` on an owner, `live` on one
 * whose camera is up, the roles they hold in their colours. The word is the events socket's:
 * room-atoms holds every name on the roster while the room is up.
 */
function Member({ member, live }: { member: GroupMember; live: boolean }) {
  const presence = useAtomValue(presenceOfAtom(member.name));
  return (
    <li data-member={member.name} data-owner={member.owner || undefined} data-presence={presence} className="flex items-center gap-2">
      <span className="relative flex shrink-0">
        <Face name={member.name} version={member.avatar ?? null} className="h-8 w-8 shrink-0" />
        <PresenceSquare presence={presence} className="border-backgroundSecondary" />
        <span className="sr-only">{PRESENCE_WORD[presence]}</span>
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2">
          <span className="truncate font-semibold">{member.name}</span>
          {member.owner && <span className="text-xs uppercase text-primaryBlue">owner</span>}
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
    </li>
  );
}

/**
 * The right of the room, for a member: who is in. The heading row, with a search icon at its
 * far right; then each member (`Member`), owners first, then the group's order (room-atoms
 * sorts). The icon slides a search bar in from the right, over the names and the roles, and
 * the heading is pushed out to the left ahead of it: the two are one strip, the heading then
 * the bar, each the width of the row, slid along by a row's width. Focus leaving the row (a
 * click anywhere else, a tab past the icon), escape, or the icon again slides it back, and
 * what was typed goes with it, so the list is whole again under the heading. The row stays
 * put while the list scrolls, with no bar on it. Nothing here acts: what a power does is in
 * the manage dialog, from the header.
 */
function Roster({ room }: { room: GroupRoom }) {
  const members = room.roster ?? [];
  const live = room.live ?? [];
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const input = useRef<HTMLInputElement | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const q = query.trim().toLowerCase();
  const shown = q ? members.filter((member) => member.name.toLowerCase().includes(q) || member.roles.some((role) => role.name.toLowerCase().includes(q))) : members;

  // typed in as soon as it is on its way: once the bar is out of its inert state. no scroll:
  // the row was just clicked, so it is in view, and the bar is still off to the right
  useEffect(() => {
    if (searching) input.current?.focus({ preventScroll: true });
  }, [searching]);

  function close() {
    setSearching(false);
    setQuery('');
  }

  return (
    <aside id="group-roster" aria-label="members" className={cn('flex flex-col gap-3 border border-primaryStroke bg-backgroundSecondary p-4 text-sm', ROSTER_HEIGHT)}>
      <div
        className="flex h-8 shrink-0 items-center gap-2"
        onBlur={(e) => {
          if (searching && !e.currentTarget.contains(e.relatedTarget)) close();
        }}
      >
        {/* the window: a row's width, clipping the strip. `clip`, not `hidden`: a focus in the clipped bar must not scroll it */}
        <div className="min-w-0 flex-1 overflow-clip">
          <div className={cn('flex transition-transform duration-150 ease-out motion-reduce:transition-none', searching && '-translate-x-full')}>
            <h3 className="flex h-8 w-full shrink-0 items-center gap-1 whitespace-nowrap text-xs font-semibold uppercase tracking-wider text-textTertiary">
              members <span className="font-normal normal-case tracking-normal">{room.members}</span>
            </h3>
            {members.length > 0 && (
              // in the document while it is away, so it can slide in; inert, so it is out of the tab order and off a reader
              <div className="w-full shrink-0" inert={searching ? undefined : true}>
                <label htmlFor="group-members-search" className="sr-only">
                  find a member
                </label>
                <input
                  ref={input}
                  id="group-members-search"
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== 'Escape') return;
                    close();
                    opener.current?.focus();
                  }}
                  placeholder="search members"
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  className={cn(INPUT, 'h-8 w-full py-0 text-sm')}
                />
              </div>
            )}
          </div>
        </div>
        {members.length > 0 && (
          <Tooltip content={searching ? 'close search' : 'search members'}>
            <button
              ref={opener}
              id="group-members-search-open"
              type="button"
              aria-label={searching ? 'close search' : 'search members'}
              aria-expanded={searching}
              aria-controls="group-members-search"
              // the press takes no focus from the bar: with it open, the click closes, and does not first blur it shut and then open it again
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => (searching ? close() : setSearching(true))}
              className={cn(ICON_BUTTON, searching ? 'text-primaryBlue' : 'text-textTertiary hover:text-textPrimary')}
            >
              <RiSearchLine aria-hidden size={16} />
            </button>
          </Tooltip>
        )}
      </div>
      {room.roster === null && <p className="text-textTertiary">the roster is for members.</p>}
      {q && shown.length === 0 && (
        <p id="group-members-nobody" className="text-textTertiary">
          nobody by that name.
        </p>
      )}
      {/* no bar: it would take width from the rows. the padding under the last row is for its presence square, which hangs 4px below its face and would otherwise be 4px of scroll. its scroll is its own: the end of a long roster does not send the page to its other view */}
      <ul id="group-members" className="flex min-h-0 flex-col gap-2 overflow-y-auto overscroll-contain pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {shown.map((member) => (
          <Member key={member.name} member={member} live={live.includes(member.name)} />
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

type ManageTab = 'about' | 'roles' | 'members' | 'bans' | 'delete';

/**
 * The rail of the manage dialog, in order and in groups, each tab with the power that shows
 * it. `about` is the about line and the listing (appearance); `members` is for anyone who
 * manages at all, since every power does something to a member.
 */
const MANAGE_TABS: { id: ManageTab; label: string; group: string; icon: ReactNode; shown: (room: GroupRoom) => boolean }[] = [
  { id: 'about', label: 'about', group: 'the group', icon: <RiInformationLine aria-hidden size={18} />, shown: (room) => room.perms.appearance },
  { id: 'roles', label: 'roles', group: 'the group', icon: <RiShieldStarLine aria-hidden size={18} />, shown: (room) => room.perms.roles },
  { id: 'members', label: 'members', group: 'people', icon: <RiGroupLine aria-hidden size={18} />, shown: () => true },
  { id: 'bans', label: 'bans', group: 'people', icon: <RiForbidLine aria-hidden size={18} />, shown: (room) => room.perms.ban },
  { id: 'delete', label: 'delete', group: 'owner', icon: <RiDeleteBinLine aria-hidden size={18} />, shown: (room) => room.owner }
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
const RAIL_STEP: Record<string, number | undefined> = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };

/**
 * What a power does, in a dialog over the room (`manage`, the gear in the header), laid out
 * like the user modal: a rail of tabs down the left, in groups (the group: about and the
 * listing, roles; people: members, bans; owner: delete), and the open tab's pane on the
 * right. A tab shows for the power behind it, and the first one this login may see opens.
 * The pictures are not here: an owner changes them on the pictures themselves, at the top
 * of the page; the channels are the list's own. Every call lands through the socket, for
 * this page and every other one with the room open, so the dialog reads the room the page
 * does and follows it live. A native <dialog>: the browser keeps focus in it, closes it on
 * escape and hands focus back to the button that opened it; a click on the backdrop closes
 * it too. A refusal is said in the pane, since the page is under the backdrop.
 */
function ManageDialog({ server, room, me, onClose }: { server: string; room: GroupRoom; me: string | null; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  /** The press that began this click was on the backdrop too: a text drag that ends outside is not a close. */
  const pressedBackdrop = useRef(false);
  const [error, setError] = useState('');
  const [picked, setPicked] = useState<ManageTab | null>(null);
  const words = groupWords(room);
  const tabs = MANAGE_TABS.filter((item) => item.shown(room));
  // the tab picked while it is still one this login may see, else the first that is: a power lost while this was open moves the pane
  const tab = tabs.find((item) => item.id === picked)?.id ?? tabs[0]?.id ?? null;

  // A layout effect: its cleanup runs while the node is still in the document, which is when
  // close() hands focus back to the opener.
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    dialog.showModal();
    // the heading, not the first control: a screen reader hears what this is
    dialog.querySelector<HTMLElement>('#group-manage-title')?.focus();
    return () => {
      if (dialog.open) dialog.close();
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
                <AboutSection server={server} room={room} run={run} />
                <ListingSection server={server} room={room} run={run} />
              </div>
            )}
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

/** Every member with what a power may do to them: give or take a role, kick, ban, remove owner. Then, for an owner, naming another. */
function MembersSection({ server, room, me, run }: ManageProps & { me: string | null }) {
  const [ownerName, setOwnerName] = useState('');
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
          const acts = offer.length > 0 || (removable && (room.perms.kick || room.perms.ban || (room.owner && member.owner)));
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
                  {member.owner && <span className="text-xs uppercase text-primaryBlue">owner</span>}
                  {member.roles.map((role) => (
                    <span key={role.id} className="text-xs" style={{ color: role.color }}>
                      {role.name}
                      {touch && reaches(room, permsOf(role.id)) && (
                        <button
                          type="button"
                          className="ml-1 text-textTertiary"
                          aria-label={`take ${role.name} from ${member.name}`}
                          onClick={() => void run(() => api.takeRole(server, role.id, member.name))}
                        >
                          ×
                        </button>
                      )}
                    </span>
                  ))}
                </div>
                {acts && (
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    {offer.length > 0 && (
                      <select
                        aria-label={`role for ${member.name}`}
                        defaultValue=""
                        className="border border-primaryStroke bg-background px-1 py-0.5"
                        onChange={(e) => {
                          const id = e.target.value;
                          e.target.value = '';
                          if (id) void run(() => api.giveRole(server, id, member.name));
                        }}
                      >
                        <option value="">give a role</option>
                        {offer.map((role) => (
                          <option key={role.id} value={role.id}>
                            {role.name}
                          </option>
                        ))}
                      </select>
                    )}
                    {room.perms.kick && removable && (
                      <button type="button" className="text-textTertiary" onClick={() => void run(() => api.kickMember(server, member.name))}>
                        kick
                      </button>
                    )}
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
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {room.owner && (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const name = ownerName.trim().toLowerCase();
            if (!name) return;
            void run(async () => {
              await api.grantOwner(server, name);
              setOwnerName('');
            });
          }}
        >
          <input
            id="owner-name"
            value={ownerName}
            onChange={(e) => setOwnerName(e.target.value)}
            placeholder="name an owner"
            aria-label="name an owner"
            className={INPUT}
          />
          <button id="owner-grant" type="submit" className="text-sm font-semibold text-primaryBlue disabled:opacity-40" disabled={!ownerName.trim()}>
            owner
          </button>
        </form>
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

/** A role as it is being changed in place: the id it is known by, and what `save` puts. */
interface RoleDraft {
  id: string;
  name: string;
  color: string;
  perms: RolePerms;
}

/** What a new role is called: `new role`, or the first of `new role 2`, `new role 3`, … that no role here has, so the add never collides. */
function freshRoleName(roles: GroupRole[]): string {
  const taken = new Set(roles.map((role) => role.name.toLowerCase()));
  if (!taken.has('new role')) return 'new role';
  let n = 2;
  while (taken.has(`new role ${n}`)) n += 1;
  return `new role ${n}`;
}

/** The words for a role's powers in its row: the labels it carries, or `no powers`. */
function powerWords(perms: RolePerms): string {
  return (
    POWERS.filter((power) => perms[power.key])
      .map((power) => power.label)
      .join(', ') || 'no powers'
  );
}

/**
 * The roles, each a row: the name in its colour and the powers it carries. A row within reach
 * is the click: it opens in place as the name, the colour and the powers, with save, cancel
 * and delete; one is open at a time. `add role` makes one right away, called `new role`
 * (numbered when that is taken), and opens it with the name selected, so what is typed next
 * is its name. A role is known by its id, not its name: a rename is a save like any other,
 * and the open row stays on its role whatever the socket says of it meanwhile; a role deleted
 * under it closes it.
 */
function RolesSection({ server, room, run }: ManageProps) {
  const [draft, setDraft] = useState<RoleDraft | null>(null);
  const [adding, setAdding] = useState(false);
  // a power this login lacks is one it cannot put on a role; an owner and a site admin lack none
  const short = POWERS.filter((power) => !room.perms[power.key]);
  const full = room.roles.length >= ROLE_CAP;
  // the row open in place: the draft, while the role it is of is still there
  const open = draft !== null && room.roles.some((role) => role.id === draft.id) ? draft : null;

  /** A role now, so it has an id to be known by, then open with the name selected. */
  async function add() {
    setAdding(true);
    try {
      await run(async () => {
        const made = await api.createRole(server, { name: freshRoleName(room.roles), color: COLORS[0], perms: NO_PERMS });
        setDraft({ id: made.id, name: made.name, color: made.color, perms: made.perms });
      });
    } finally {
      setAdding(false);
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!open || !open.name.trim()) return;
    await run(async () => {
      await api.saveRole(server, open.id, { name: open.name.trim(), color: open.color, perms: open.perms });
      setDraft(null);
    });
  }

  async function remove() {
    if (!open) return;
    await run(async () => {
      await api.deleteRole(server, open.id);
      setDraft(null);
    });
  }

  return (
    <Section
      title="roles"
      description={`${room.roles.length} of ${ROLE_CAP}. a name, a colour and the powers it carries; click one to change or delete it. ${
        short.length > 0 ? 'a role carries only the powers you hold. ' : ''
      }only an owner can name another owner, or change the pictures.`}
    >
      {room.roles.length === 0 && <p className="text-textTertiary">no roles yet.</p>}
      {room.roles.length > 0 && (
        <ul id="group-roles" className="flex flex-col gap-1">
          {room.roles.map((role) => {
            // a role past this login's reach is read, not changed
            const within = reaches(room, role.perms);
            if (open?.id === role.id) {
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
                      onFocus={(e) => e.currentTarget.select()}
                      className={INPUT}
                    />
                    <div className="flex flex-wrap gap-1">
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
                    <div className="flex flex-wrap gap-x-4 gap-y-1">
                      {POWERS.map((power) => (
                        <label key={power.key} className={cn('flex items-center gap-2', !room.perms[power.key] && 'text-textTertiary')}>
                          <input
                            id={`role-perm-${power.key}`}
                            type="checkbox"
                            checked={open.perms[power.key]}
                            disabled={!room.perms[power.key]}
                            onChange={(e) => setDraft({ ...open, perms: { ...open.perms, [power.key]: e.target.checked } })}
                          />
                          {power.label}
                        </label>
                      ))}
                    </div>
                    <div className="flex items-center gap-3">
                      <button id="role-save" type="submit" className="text-sm font-semibold text-primaryBlue disabled:opacity-40" disabled={!open.name.trim()}>
                        save
                      </button>
                      <button id="role-cancel" type="button" className="text-sm text-textTertiary" onClick={() => setDraft(null)}>
                        cancel
                      </button>
                      <button id="role-delete" type="button" className="ml-auto text-sm text-decrease" onClick={() => void remove()}>
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
                    onClick={() => setDraft({ id: role.id, name: role.name, color: role.color, perms: role.perms })}
                  >
                    <span className="font-semibold" style={{ color: role.color }}>
                      {role.name}
                    </span>
                    <span className="truncate text-xs text-textTertiary">{powerWords(role.perms)}</span>
                  </button>
                ) : (
                  <span className="flex items-center gap-2 px-2 py-1">
                    <span className="font-semibold" style={{ color: role.color }}>
                      {role.name}
                    </span>
                    <span className="truncate text-xs text-textTertiary">{powerWords(role.perms)}</span>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
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
