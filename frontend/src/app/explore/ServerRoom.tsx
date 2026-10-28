import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAtomValue } from 'jotai';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { api, groupImage, groupWords, messageOf, type GroupRoom, type RolePerms, type Server } from '@/infra/api';
import { meAtom } from '@/infra/atoms/auth-atoms';
import { reconnectChat } from '@/infra/atoms/chat-atoms';
import { cropPicture } from '@/infra/atoms/crop-atoms';
import { onEvents, unwatchPresence, watchPresence } from '@/infra/events';
import { cleanName, isValidName } from '@/infra/names';
import { GROUP_BANNER, GROUP_ICON } from '@/infra/picture';
import { previewStreamsAtom, setHomePreviews } from '@/infra/preview';
import { Badge } from '@/shared-components/Badge';
import { Button, buttonClassName } from '@/shared-components/Button';
import { ConfirmDialog } from '@/shared-components/ConfirmDialog';
import { Face } from '@/shared-components/Face';
import { GroupMark } from '@/shared-components/GroupMark';
import { ChatPanel } from '@/shared-components/ChatPanel';
import { PageFrame } from '@/shared-components/PageFrame';
import { cn } from '@/utils/cn';

/** Cameras played in the room. The same peers home uses, muted, and not counted as viewers. */
const FACES = 4;

const TILE = 'block overflow-hidden border border-primaryStroke bg-backgroundSecondary transition-[border-color] duration-150 hover:border-primaryBlue';

const RESERVED = new Set(['before', 'search', 'by', 'around']);

const INPUT = 'min-w-0 flex-1 border border-primaryStroke bg-background px-3 py-2 text-base text-textPrimary placeholder:text-textTertiary';

const COLORS = ['#5865f2', '#f85149', '#3fb950', '#f2cc60', '#bc8cff', '#ff9f43', '#39d2c0', '#ff6bcb'] as const;

/** Matches `MAX_ROLES` in the api. */
const ROLE_CAP = 20;

const ORDERS = [
  { id: 'name', label: 'name' },
  { id: 'newest', label: 'newest' },
  { id: 'oldest', label: 'oldest' }
] as const;

const POWERS: { key: keyof RolePerms; label: string }[] = [
  { key: 'appearance', label: 'picture and about' },
  { key: 'roles', label: 'roles' },
  { key: 'channels', label: 'channels' },
  { key: 'kick', label: 'kick' },
  { key: 'ban', label: 'ban' }
];

const NO_PERMS: RolePerms = { appearance: false, roles: false, channels: false, kick: false, ban: false };

function liveOf(server: Server): string[] {
  return server.live ?? [];
}

/** One member's camera, muted. Click opens their stream. */
function LiveFace({ name, big }: { name: string; big: boolean }) {
  const stream = useAtomValue(previewStreamsAtom)[name] ?? null;
  const ref = useRef<HTMLVideoElement | null>(null);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    setPlaying(false);
    const el = ref.current;
    if (!el || el.srcObject === stream) return;
    el.srcObject = stream;
    if (stream) void el.play().catch(() => undefined);
  }, [stream]);

  return (
    <Link id={`group-live-${name}`} to={`/watch/${encodeURIComponent(name)}`} className={cn(TILE, big && 'sm:col-span-2')}>
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
          onPlaying={() => setPlaying(true)}
          className={cn('absolute inset-0 h-full w-full object-cover', !playing && 'opacity-0')}
        />
      </div>
      <div className="truncate px-3 py-2 text-sm font-semibold">{name}</div>
    </Link>
  );
}

/**
 * A group as a server. The banner and the picture sit over the channel list and a chat
 * that reads as a room, not as the stream's panel. An older api, with no room route, still
 * draws this from the explorer and hides the moderation.
 */
function GroupName({ words }: { words: { title: string; tag: string | null } }) {
  return (
    <>
      {words.title}
      {words.tag && <span className="ml-1 font-normal text-textTertiary">#{words.tag}</span>}
    </>
  );
}

function ServerRoom({ channel, titleId }: { channel: string; titleId: string }) {
  const params = useParams<{ server: string }>();
  const server = cleanName(params.server);
  const channelOk = isValidName(channel) && !RESERVED.has(channel);
  const ok = isValidName(server) && server !== 'bot' && channelOk;
  const query = useQuery({ queryKey: ['explore'], queryFn: api.explore, enabled: ok });
  const room = useQuery({ queryKey: ['group', server], queryFn: () => api.group(server), enabled: ok, retry: false });
  const me = useAtomValue(meAtom);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [leaving, setLeaving] = useState(false);
  const listed = query.data ? [...query.data.yours, ...query.data.discover] : null;
  const group = listed?.find((item) => item.name === server);
  const detail = room.data;
  const live = group ? liveOf(group) : [];
  const shown = live.slice(0, FACES);
  const previewKey = shown.join(',');
  const found = channel === 'general' || !!group?.channels.some((item) => item.name === channel);

  useEffect(() => {
    if (!ok) return;
    watchPresence('*');
    let timer: number | null = null;
    const stop = onEvents((event) => {
      if (event.type !== 'live' && event.type !== 'ended') return;
      if (timer !== null) return;
      timer = window.setTimeout(() => {
        timer = null;
        void qc.invalidateQueries({ queryKey: ['explore'] });
      }, 300);
    });
    return () => {
      stop();
      unwatchPresence('*');
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [ok, qc]);

  useEffect(() => {
    const names = previewKey ? previewKey.split(',') : [];
    setHomePreviews(names);
    return () => setHomePreviews([]);
  }, [previewKey]);

  if (!ok) {
    return (
      <PageFrame title={channelOk ? 'no such group' : 'no such channel'}>
        <p className="text-textSecondary">{channelOk ? 'that is not a group.' : 'that is not a channel.'}</p>
      </PageFrame>
    );
  }

  if (!query.data && !query.error) {
    return (
      <PageFrame title={server || 'group'} titleId={titleId}>
        <p className="text-textSecondary">loading</p>
      </PageFrame>
    );
  }

  if (query.error && !group) {
    return (
      <PageFrame title={server || 'group'} titleId={titleId}>
        <p className="text-textSecondary">{messageOf(query.error)}</p>
      </PageFrame>
    );
  }

  async function refresh() {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['explore'] }),
      qc.invalidateQueries({ queryKey: ['group', server] }),
      qc.invalidateQueries({ queryKey: ['group-members', server] }),
      qc.invalidateQueries({ queryKey: ['group-bans', server] })
    ]);
  }

  async function setListed(isPublic: boolean) {
    setError('');
    try {
      await api.setGroupPublic(server, isPublic);
      await refresh();
    } catch (err) {
      setError(messageOf(err));
    }
  }

  async function join() {
    setBusy(true);
    setError('');
    try {
      await api.joinGroup(server);
      reconnectChat();
      await refresh();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  async function leave() {
    const lastOne = (detail?.members ?? group?.members ?? 0) <= 1;
    setBusy(true);
    setError('');
    try {
      await api.leaveGroup(server);
      reconnectChat();
      await qc.invalidateQueries({ queryKey: ['explore'] });
      if (lastOne) {
        navigate('/groups');
        return;
      }
      await refresh();
      setLeaving(false);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  const words = groupWords({ name: server, title: detail?.title ?? group?.title, tag: detail?.tag ?? group?.tag });
  const color = detail?.color ?? group?.color ?? '#5865f2';
  const icon = detail?.icon ?? group?.icon;
  const banner = detail?.banner ?? group?.banner;
  const bannerSrc = groupImage(server, 'banner', banner);
  const about = detail?.about ?? group?.about ?? '';
  const mine = detail?.mine ?? group?.mine ?? false;
  const canChannels = detail ? detail.perms.channels : (group?.can_channels ?? !!group?.mine);
  const missing = query.isSuccess && !group;
  const noChannel = query.isSuccess && !!group && !found;
  const power = !!detail && (detail.owner || POWERS.some((power) => detail.perms[power.key]));
  const roster = !!detail && (mine || power);
  const lastMember = mine && (detail?.members ?? group?.members ?? 0) <= 1;

  return (
    <PageFrame
      wide
      titleId={titleId}
      title={
        <span className="flex min-w-0 items-center gap-3">
          {(detail || group) && <Badge group={{ name: server, badge: detail?.badge ?? group?.badge ?? '', color }} />}
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
      {missing ? (
        <p className="text-textSecondary">no such group.</p>
      ) : noChannel ? (
        <p className="text-textSecondary">no such channel.</p>
      ) : (
        <>
          <div className="relative mb-16">
            <div id="group-banner" className="h-36 overflow-hidden border border-primaryStroke" style={{ backgroundColor: color }}>
              {bannerSrc && <img src={bannerSrc} alt="" className="h-full w-full object-cover" />}
            </div>
            <div className="absolute -bottom-12 left-4 flex items-end gap-4">
              <GroupMark id="group-icon" name={words.title} color={color} icon={icon} className="h-24 w-24 border-4 border-background text-3xl" />
            </div>
          </div>
          <div className="mb-6 flex flex-wrap items-start justify-between gap-3 pl-4">
            <div className="min-w-0">
              <h2 className="flex flex-wrap items-center gap-2 text-xl font-semibold">
                {words.title}
                {words.tag && <span className="text-base font-normal text-textTertiary">#{words.tag}</span>}
                {detail?.owner && <span className="bg-primaryBlue/15 px-1.5 py-0.5 text-xs uppercase text-primaryBlue">owner</span>}
                {detail?.public === false && <span className="bg-primaryStroke px-1.5 py-0.5 text-xs uppercase text-textSecondary">private</span>}
                <span className="text-sm font-normal text-textTertiary">
                  {(detail?.members ?? group?.members ?? 0) === 1 ? '1 member' : `${detail?.members ?? group?.members ?? 0} members`}
                </span>
              </h2>
              {about && <p className="mt-1 max-w-xl text-textSecondary">{about}</p>}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {detail?.perms?.appearance && (
                <span className="flex flex-wrap items-center gap-2">
                  <button
                    id="room-public"
                    type="button"
                    title="on the lists"
                    aria-pressed={detail.public !== false}
                    className={cn('border px-3 py-1.5 text-sm', detail.public !== false ? 'border-primaryBlue text-primaryBlue' : 'border-primaryStroke text-textTertiary')}
                    onClick={() => void setListed(true)}
                  >
                    public
                  </button>
                  <button
                    id="room-private"
                    type="button"
                    title="off the lists. anyone with the address can still open it and join"
                    aria-pressed={detail.public === false}
                    className={cn('border px-3 py-1.5 text-sm', detail.public === false ? 'border-primaryBlue text-primaryBlue' : 'border-primaryStroke text-textTertiary')}
                    onClick={() => void setListed(false)}
                  >
                    private
                  </button>
                </span>
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
                <button
                  id="room-leave"
                  type="button"
                  className={cn('text-sm font-semibold', lastMember ? 'text-decrease' : 'text-textSecondary hover:text-textPrimary')}
                  disabled={busy}
                  onClick={() => setLeaving(true)}
                >
                  {lastMember ? 'leave and delete' : 'leave'}
                </button>
              )}
              {mine && leaving && (
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-textSecondary">{lastMember ? 'this deletes the group' : 'leave this group?'}</span>
                  <button id="room-leave-yes" type="button" className="text-sm font-semibold text-decrease disabled:opacity-40" disabled={busy} onClick={() => void leave()}>
                    sure
                  </button>
                  <button type="button" className="text-sm text-textSecondary underline-offset-2 hover:text-textPrimary hover:underline" onClick={() => setLeaving(false)}>
                    keep
                  </button>
                </span>
              )}
            </div>
          </div>
          {error && <p className="mb-4 text-sm text-decrease">{error}</p>}
          <div id="group-room" className={cn('grid items-start gap-4', roster ? 'lg:grid-cols-[200px_minmax(0,1fr)_280px]' : 'lg:grid-cols-[200px_minmax(0,1fr)]')}>
            {group && (
              <ChannelList server={server} channel={channel} group={group} canAdd={canChannels} onError={setError} />
            )}
            <div className="min-w-0">
              {query.isSuccess && shown.length === 0 && (
                <p id="group-empty" className="mb-3 text-sm text-textSecondary">
                  nobody's camera is up.
                </p>
              )}
              {shown.length > 0 && (
                <div className="mb-4 grid grid-cols-2 gap-3">
                  {shown.map((name, i) => (
                    <LiveFace key={name} name={name} big={i === 0 && shown.length > 1} />
                  ))}
                </div>
              )}
              {live.length > FACES && <p className="mb-3 text-sm text-textTertiary">{live.length - FACES} more live</p>}
              <div className="h-[70vh] min-h-[420px]">
                <ChatPanel server name={`${server}/${channel}`} className="h-full" />
              </div>
            </div>
            {roster && detail && <Moderation server={server} detail={detail} me={me ?? null} onDone={refresh} onError={setError} />}
          </div>
        </>
      )}
    </PageFrame>
  );
}

function ChannelList({
  server,
  channel,
  group,
  canAdd,
  onError
}: {
  server: string;
  channel: string;
  group: Server;
  canAdd: boolean;
  onError: (error: string) => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [sure, setSure] = useState<string | null>(null);
  const clean = cleanName(name);

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!isValidName(clean) || RESERVED.has(clean)) return;
    onError('');
    try {
      await api.createChannel(server, clean);
      setName('');
      await qc.invalidateQueries({ queryKey: ['explore'] });
    } catch (err) {
      onError(messageOf(err));
    }
  }

  async function remove(item: string) {
    onError('');
    try {
      await api.deleteChannel(server, item);
      setSure(null);
      await qc.invalidateQueries({ queryKey: ['explore'] });
    } catch (err) {
      onError(messageOf(err));
    }
  }

  return (
    <nav aria-label="channels">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-textTertiary">channels</h3>
      <ul id="group-channels" className="flex flex-col gap-0.5">
        {group.channels.map((item) => {
          const here = item.name === channel;
          return (
            <li key={item.name} className="flex items-center gap-1">
              {here ? (
                <span aria-current="page" className="min-w-0 flex-1 truncate bg-primaryStroke/40 px-2 py-1 font-semibold">
                  #{item.name}
                </span>
              ) : (
                <Link
                  id={`group-channel-${item.name}`}
                  to={item.name === 'general' ? `/groups/${server}` : `/groups/${server}/${item.name}`}
                  className="min-w-0 flex-1 truncate px-2 py-1 text-textSecondary hover:bg-primaryStroke/20 hover:text-textPrimary"
                >
                  #{item.name}
                </Link>
              )}
              {item.can_delete && (
                <button type="button" className="px-1 text-xs text-textTertiary" onClick={() => setSure(item.name)}>
                  delete
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {canAdd && (
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
          <button id={`channel-create-${server}`} type="submit" className="self-start text-sm font-semibold text-primaryBlue disabled:opacity-40" disabled={!isValidName(clean) || RESERVED.has(clean)}>
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

function Moderation({
  server,
  detail,
  me,
  onDone,
  onError
}: {
  server: string;
  detail: GroupRoom;
  me: string | null;
  onDone: () => Promise<void>;
  onError: (error: string) => void;
}) {
  const members = useQuery({ queryKey: ['group-members', server], queryFn: () => api.groupMembers(server), retry: false });
  const bans = useQuery({
    queryKey: ['group-bans', server],
    queryFn: () => api.groupBans(server),
    enabled: detail.perms.ban,
    retry: false
  });
  const navigate = useNavigate();
  const [about, setAbout] = useState(detail.about);
  const [roleName, setRoleName] = useState('');
  const [roleColor, setRoleColor] = useState<string>(COLORS[0]);
  const [rolePerms, setRolePerms] = useState<RolePerms>(NO_PERMS);
  const [editing, setEditing] = useState<number | null>(null);
  const [ownerName, setOwnerName] = useState('');
  const [banName, setBanName] = useState('');
  const [banReason, setBanReason] = useState('');
  const [sure, setSure] = useState(false);
  const owners = members.data?.filter((member) => member.owner).length ?? 0;

  useEffect(() => {
    setAbout(detail.about);
  }, [detail.about]);

  async function run(work: () => Promise<unknown>) {
    onError('');
    try {
      await work();
      await onDone();
    } catch (err) {
      onError(messageOf(err));
    }
  }

  async function pick(file: File | undefined, kind: 'icon' | 'banner') {
    if (!file) return;
    const jpeg = await cropPicture(file, kind === 'icon' ? GROUP_ICON : GROUP_BANNER);
    if (!jpeg) return;
    await run(() => (kind === 'icon' ? api.saveGroupIcon(server, jpeg) : api.saveGroupBanner(server, jpeg)));
  }

  function editRole(id: number) {
    const role = detail.roles.find((item) => item.id === id);
    if (!role) return;
    setEditing(id);
    setRoleName(role.name);
    setRoleColor(role.color);
    setRolePerms(role.perms);
  }

  async function saveRole(e: FormEvent) {
    e.preventDefault();
    const body = { name: roleName.trim(), color: roleColor, perms: rolePerms };
    await run(async () => {
      if (editing === null) await api.createRole(server, body);
      else await api.saveRole(server, editing, body);
      setEditing(null);
      setRoleName('');
      setRolePerms(NO_PERMS);
    });
  }

  return (
    <aside id="group-mod" className="flex max-h-[70vh] flex-col gap-6 overflow-y-auto border border-primaryStroke bg-backgroundSecondary p-4 text-sm">
      {detail.perms.appearance && (
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-textTertiary">look</h3>
          <div className="flex flex-wrap gap-2">
            <label className="cursor-pointer text-sm font-semibold text-primaryBlue">
              picture
              <input
                type="file"
                accept="image/*"
                className="sr-only"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  void pick(file, 'icon');
                }}
              />
            </label>
            <label className="cursor-pointer text-sm font-semibold text-primaryBlue">
              banner
              <input
                type="file"
                accept="image/*"
                className="sr-only"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  void pick(file, 'banner');
                }}
              />
            </label>
            {detail.icon !== null && (
              <button type="button" className="text-textTertiary" onClick={() => void run(() => api.deleteGroupIcon(server))}>
                remove picture
              </button>
            )}
            {detail.banner !== null && (
              <button type="button" className="text-textTertiary" onClick={() => void run(() => api.deleteGroupBanner(server))}>
                remove banner
              </button>
            )}
          </div>
          <form
            className="mt-3 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void run(() => api.saveGroupAbout(server, about.trim()));
            }}
          >
            <input id="group-about" value={about} onChange={(e) => setAbout(e.target.value)} maxLength={200} aria-label="about" className={INPUT} />
            <button type="submit" className="text-sm font-semibold text-primaryBlue">
              save
            </button>
          </form>
        </section>
      )}

      <section>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-textTertiary">members</h3>
          {detail.perms.appearance && detail.member_order !== undefined && (
            <span className="flex flex-wrap gap-1">
              {ORDERS.map((order) => {
                const on = (detail.member_order === 'newest' || detail.member_order === 'oldest' ? detail.member_order : 'name') === order.id;
                return (
                  <button
                    key={order.id}
                    id={`member-order-${order.id}`}
                    type="button"
                    aria-pressed={on}
                    className={cn('text-xs', on ? 'font-semibold text-primaryBlue' : 'text-textTertiary hover:text-textPrimary')}
                    onClick={() => void run(() => api.setMemberOrder(server, order.id))}
                  >
                    {order.label}
                  </button>
                );
              })}
            </span>
          )}
        </div>
        {members.error && <p className="text-decrease">{messageOf(members.error)}</p>}
        <ul id="group-members" className="flex flex-col gap-2">
          {members.data?.map((member) => (
            <li key={member.name} className="flex items-start gap-2 border border-primaryStroke px-2 py-1.5">
              <Face name={member.name} version={member.avatar ?? null} className="h-8 w-8" />
              <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{member.name}</span>
                {member.owner && <span className="text-xs uppercase text-primaryBlue">owner</span>}
                {member.roles.map((role) => (
                  <span key={role.id} className="text-xs" style={{ color: role.color }}>
                    {role.name}
                    {detail.perms.roles && (
                      <button type="button" className="ml-1 text-textTertiary" aria-label={`take ${role.name} from ${member.name}`} onClick={() => void run(() => api.takeRole(server, role.id, member.name))}>
                        ×
                      </button>
                    )}
                  </span>
                ))}
              </div>
              <div className="mt-1 flex flex-wrap gap-2">
                {detail.perms.roles && detail.roles.some((role) => !member.roles.some((held) => held.id === role.id)) && (
                  <select
                    aria-label={`role for ${member.name}`}
                    defaultValue=""
                    className="border border-primaryStroke bg-background px-1 py-0.5"
                    onChange={(e) => {
                      const id = Number(e.target.value);
                      e.target.value = '';
                      if (id) void run(() => api.giveRole(server, id, member.name));
                    }}
                  >
                    <option value="">give a role</option>
                    {detail.roles
                      .filter((role) => !member.roles.some((held) => held.id === role.id))
                      .map((role) => (
                        <option key={role.id} value={role.id}>
                          {role.name}
                        </option>
                      ))}
                  </select>
                )}
                {detail.perms.kick && member.name !== me && (!member.owner || (detail.owner && owners > 1)) && (
                  <button type="button" className="text-textTertiary" onClick={() => void run(() => api.kickMember(server, member.name))}>
                    kick
                  </button>
                )}
                {detail.perms.ban && member.name !== me && (!member.owner || (detail.owner && owners > 1)) && (
                  <button type="button" className="text-decrease" onClick={() => void run(() => api.banMember(server, member.name, ''))}>
                    ban
                  </button>
                )}
                {detail.owner && member.owner && member.name !== me && owners > 1 && (
                  <button type="button" className="text-textTertiary" onClick={() => void run(() => api.revokeOwner(server, member.name))}>
                    remove owner
                  </button>
                )}
              </div>
              </div>
            </li>
          ))}
        </ul>
        {detail.owner && (
          <form
            className="mt-3 flex gap-2"
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
            <input id="owner-name" value={ownerName} onChange={(e) => setOwnerName(e.target.value)} placeholder="name an owner" aria-label="name an owner" className={INPUT} />
            <button id="owner-grant" type="submit" className="text-sm font-semibold text-primaryBlue disabled:opacity-40" disabled={!ownerName.trim()}>
              owner
            </button>
          </form>
        )}
        {detail.perms.ban && (
          <form
            className="mt-3 flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const name = banName.trim().toLowerCase();
              if (!name) return;
              void run(async () => {
                await api.banMember(server, name, banReason.trim());
                setBanName('');
                setBanReason('');
              });
            }}
          >
            <input id="ban-name" value={banName} onChange={(e) => setBanName(e.target.value)} placeholder="ban a name" aria-label="ban a name" className={INPUT} />
            <input id="ban-reason" value={banReason} onChange={(e) => setBanReason(e.target.value)} placeholder="reason, optional" aria-label="ban reason" className={INPUT} />
            <button id="ban-submit" type="submit" className="self-start text-sm font-semibold text-decrease disabled:opacity-40" disabled={!banName.trim()}>
              ban
            </button>
          </form>
        )}
        {detail.perms.ban && bans.data && bans.data.length > 0 && (
          <ul id="group-bans" className="mt-2 flex flex-col gap-1">
            {bans.data.map((ban) => (
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
      </section>

      {detail.perms.roles && (
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-textTertiary">
            roles <span className="font-normal normal-case tracking-normal text-textTertiary">{detail.roles.length} of {ROLE_CAP}</span>
          </h3>
          <ul id="group-roles" className="mb-3 flex flex-col gap-1">
            {detail.roles.map((role) => (
              <li key={role.id} className="flex items-center gap-2">
                <button type="button" className="font-semibold" style={{ color: role.color }} onClick={() => editRole(role.id)}>
                  {role.name}
                </button>
                <span className="truncate text-xs text-textTertiary">{POWERS.filter((power) => role.perms[power.key]).map((power) => power.label).join(', ') || 'no powers'}</span>
                <button type="button" className="ml-auto text-textTertiary" onClick={() => void run(() => api.deleteRole(server, role.id))}>
                  delete
                </button>
              </li>
            ))}
          </ul>
          {editing === null && detail.roles.length >= ROLE_CAP ? (
            <p className="text-textTertiary">{ROLE_CAP} roles is the cap.</p>
          ) : (
          <form id="role-form" onSubmit={(e) => void saveRole(e)} className="flex flex-col gap-2">
            <input id="role-name" value={roleName} onChange={(e) => setRoleName(e.target.value)} placeholder="role name" maxLength={32} aria-label="role name" className={INPUT} />
            <div className="flex flex-wrap gap-1">
              {COLORS.map((swatch) => (
                <button
                  key={swatch}
                  type="button"
                  aria-label={swatch}
                  aria-pressed={swatch === roleColor}
                  onClick={() => setRoleColor(swatch)}
                  style={{ backgroundColor: swatch }}
                  className={cn('h-6 w-6 border-2', swatch === roleColor ? 'border-textPrimary' : 'border-transparent')}
                />
              ))}
            </div>
            {POWERS.map((power) => (
              <label key={power.key} className="flex items-center gap-2">
                <input
                  id={`role-perm-${power.key}`}
                  type="checkbox"
                  checked={rolePerms[power.key]}
                  onChange={(e) => setRolePerms({ ...rolePerms, [power.key]: e.target.checked })}
                />
                {power.label}
              </label>
            ))}
            <div className="flex gap-2">
              <button id="role-save" type="submit" className="text-sm font-semibold text-primaryBlue disabled:opacity-40" disabled={!roleName.trim() || (editing === null && detail.roles.length >= ROLE_CAP)}>
                {editing === null ? 'add role' : 'save role'}
              </button>
              {editing !== null && (
                <button
                  type="button"
                  className="text-textTertiary"
                  onClick={() => {
                    setEditing(null);
                    setRoleName('');
                    setRolePerms(NO_PERMS);
                  }}
                >
                  cancel
                </button>
              )}
            </div>
          </form>
          )}
          <p className="mt-2 text-xs text-textTertiary">only an owner can name another owner.</p>
        </section>
      )}

      {detail.owner && (
        <button type="button" className="self-start text-sm text-decrease" onClick={() => setSure(true)}>
          delete group
        </button>
      )}
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
    </aside>
  );
}

/** The group, on `general`. */
export function GroupPage() {
  return <ServerRoom channel="general" titleId="group-title" />;
}

/** One channel's chat. Reading is open. Talking takes a login that has joined. */
export function ChannelPage() {
  const params = useParams<{ channel: string }>();
  return <ServerRoom channel={cleanName(params.channel)} titleId="channel-title" />;
}
