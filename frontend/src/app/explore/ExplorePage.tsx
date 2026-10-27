import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAtomValue } from 'jotai';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';

import { api, messageOf, type Server } from '@/infra/api';
import { meAtom } from '@/infra/atoms/auth-atoms';
import { reconnectChat } from '@/infra/atoms/chat-atoms';
import { onEvents, unwatchPresence, watchPresence } from '@/infra/events';
import { cleanName, isValidName } from '@/infra/names';
import { previewStreamsAtom, setHomePreviews } from '@/infra/preview';
import { Badge } from '@/shared-components/Badge';
import { Button, buttonClassName } from '@/shared-components/Button';
import { ChatPanel } from '@/shared-components/ChatPanel';
import { PageFrame } from '@/shared-components/PageFrame';
import { cn } from '@/utils/cn';

/** Cameras played on the group page. The same peers home uses, muted, and not viewers. */
const FACES = 4;

const TILE = 'block overflow-hidden border border-primaryStroke bg-backgroundSecondary transition-[border-color] duration-150 hover:border-primaryBlue';

function liveOf(server: Server): string[] {
  return server.live ?? [];
}

/** Words the chat history routes already use, so a channel cannot be one of them. */
const RESERVED = new Set(['before', 'search', 'by', 'around']);

const INPUT = 'min-w-0 flex-1 border border-primaryStroke bg-background px-3 py-2 text-base text-textPrimary placeholder:text-textTertiary';

async function joinServer(name: string) {
  await api.joinGroup(name);
  reconnectChat();
}

/** The servers you are in, then the ones you can find. A group is a server; `bot` is not. */
export function ExplorePage() {
  const query = useQuery({ queryKey: ['explore'], queryFn: api.explore });
  return (
    <PageFrame title="servers" titleId="explore-title">
      {query.error && (
        <p className="border border-decrease/40 bg-decrease/10 px-5 py-4 text-textSecondary" aria-live="polite">
          {messageOf(query.error)}
        </p>
      )}
      {!query.data && !query.error && <p className="text-textSecondary">loading</p>}
      {query.data && (
        <div id="servers" className="flex flex-col gap-10">
          <Section id="yours" title="yours" empty="you are not in a server yet" servers={query.data.yours} />
          <Section id="discover" title="discover" empty="nothing else to find" servers={query.data.discover} />
        </div>
      )}
    </PageFrame>
  );
}

function Section({ id, title, empty, servers }: { id: string; title: string; empty: string; servers: Server[] }) {
  return (
    <section id={id} aria-label={title}>
      <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-textTertiary">{title}</h2>
      {servers.length === 0 ? (
        <p className="text-textSecondary">{empty}</p>
      ) : (
        <ul className="flex flex-col gap-4">
          {servers.map((server) => (
            <ServerCard key={server.name} server={server} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ServerCard({ server }: { server: Server }) {
  const qc = useQueryClient();
  const me = useAtomValue(meAtom);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sure, setSure] = useState<string | null>(null);

  async function join() {
    setBusy(true);
    setError('');
    try {
      await joinServer(server.name);
      await qc.invalidateQueries({ queryKey: ['explore'] });
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(channel: string) {
    setError('');
    try {
      await api.deleteChannel(server.name, channel);
      setSure(null);
      await qc.invalidateQueries({ queryKey: ['explore'] });
    } catch (err) {
      setError(messageOf(err));
    }
  }

  return (
    <li id={`server-${server.name}`} className="border border-primaryStroke bg-backgroundSecondary px-5 py-4">
      <div className="flex flex-wrap items-center gap-3">
        <Badge group={server} />
        <Link id={`server-open-${server.name}`} to={`/explore/${server.name}`} className="font-semibold hover:text-primaryBlue">
          {server.name}
        </Link>
        <span className="text-sm text-textTertiary">
          {server.members} {server.members === 1 ? 'member' : 'members'}
        </span>
        {liveOf(server).length > 0 && <span className="text-sm text-increase">{liveOf(server).length} live</span>}
        {!server.mine && me && (
          <Button id={`server-join-${server.name}`} className="ml-auto px-3 py-1.5 text-sm" disabled={busy} onClick={() => void join()}>
            join
          </Button>
        )}
        {!server.mine && me === null && (
          <Link to="/login" className={buttonClassName('secondary', 'ml-auto px-3 py-1.5 text-sm')}>
            log in to join
          </Link>
        )}
      </div>
      {server.about && <p className="mt-2 text-textSecondary">{server.about}</p>}
      <ul className="mt-3 flex flex-col gap-1">
        {server.channels.map((channel) => (
          <li key={channel.name} className="flex items-center gap-3">
            <Link
              id={`channel-${server.name}-${channel.name}`}
              to={`/explore/${server.name}/${channel.name}`}
              className="font-semibold text-primaryBlue"
            >
              #{channel.name}
            </Link>
            {channel.about && <span className="truncate text-sm text-textTertiary">{channel.about}</span>}
            {channel.can_delete && sure !== channel.name && (
              <button type="button" className="ml-auto text-sm text-textTertiary" onClick={() => setSure(channel.name)}>
                delete
              </button>
            )}
            {channel.can_delete && sure === channel.name && (
              <button
                type="button"
                id={`channel-delete-${server.name}-${channel.name}`}
                className="ml-auto text-sm text-decrease"
                onClick={() => void remove(channel.name)}
              >
                sure?
              </button>
            )}
          </li>
        ))}
      </ul>
      {server.mine && <AddChannel server={server.name} />}
      {error && <p className="mt-2 text-sm text-decrease">{error}</p>}
    </li>
  );
}

function AddChannel({ server }: { server: string }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const clean = cleanName(name);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!isValidName(clean) || RESERVED.has(clean)) return;
    setError('');
    try {
      await api.createChannel(server, clean);
      setName('');
      await qc.invalidateQueries({ queryKey: ['explore'] });
    } catch (err) {
      setError(messageOf(err));
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="mt-3 flex flex-wrap items-center gap-2">
      <input
        id={`channel-name-${server}`}
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="new channel"
        maxLength={32}
        className={INPUT}
        aria-label={`new channel in ${server}`}
      />
      <Button id={`channel-create-${server}`} type="submit" className="px-3 py-1.5 text-sm" disabled={!isValidName(clean) || RESERVED.has(clean)}>
        add
      </Button>
      {error && <p className="w-full text-sm text-decrease">{error}</p>}
    </form>
  );
}

/** One channel's chat. Reading is open. Talking takes a login that has joined the server. */
export function ChannelPage() {
  const params = useParams<{ server: string; channel: string }>();
  const server = cleanName(params.server);
  const channel = cleanName(params.channel);
  const ok = isValidName(server) && server !== 'bot' && isValidName(channel) && !RESERVED.has(channel);
  const query = useQuery({ queryKey: ['explore'], queryFn: api.explore, enabled: ok });
  const me = useAtomValue(meAtom);
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const listed = query.data ? [...query.data.yours, ...query.data.discover] : null;
  const group = listed?.find((item) => item.name === server);
  const found = !!group?.channels.some((item) => item.name === channel);

  if (!ok) {
    return (
      <PageFrame title="no such channel">
        <p className="text-textSecondary">that is not a channel.</p>
      </PageFrame>
    );
  }

  async function join() {
    setBusy(true);
    setError('');
    try {
      await joinServer(server);
      await qc.invalidateQueries({ queryKey: ['explore'] });
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <PageFrame
      wide
      titleId="channel-title"
      title={
        <span className="flex min-w-0 items-center gap-3">
          {group && <Badge group={group} />}
          <span className="truncate">
            <Link to={`/explore/${server}`} className="hover:text-primaryBlue">
              {server}
            </Link>
            <span className="text-textTertiary"> / {channel}</span>
          </span>
        </span>
      }
    >
      {query.isSuccess && !found ? (
        <p className="text-textSecondary">no such channel.</p>
      ) : (
        <>
          {group && !group.mine && (
            <div className="mb-4 flex flex-wrap items-center gap-3">
              <p className="text-textSecondary">you can read this. join to talk.</p>
              {me && (
                <Button id="channel-join" className="px-3 py-1.5 text-sm" disabled={busy} onClick={() => void join()}>
                  join
                </Button>
              )}
              {me === null && (
                <Link to="/login" className={buttonClassName('primary', 'px-3 py-1.5 text-sm')}>
                  log in to join
                </Link>
              )}
              {error && <p className="text-sm text-decrease">{error}</p>}
            </div>
          )}
          <div className={cn('h-[70vh] min-h-[420px]')}>
            <ChatPanel name={`${server}/${channel}`} className="h-full" />
          </div>
        </>
      )}
    </PageFrame>
  );
}

/** One member's camera, muted, the same preview home plays. Click opens their stream. */
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
      <div className="truncate px-3 py-2 font-semibold">{name}</div>
    </Link>
  );
}

/**
 * The group as a room. Whoever in it is live shows as a tile, the first one big, and `general`
 * is the chat beside them. A night with every camera off is still the room. Reading is open.
 */
export function GroupPage() {
  const params = useParams<{ server: string }>();
  const server = cleanName(params.server);
  const ok = isValidName(server) && server !== 'bot';
  const query = useQuery({ queryKey: ['explore'], queryFn: api.explore, enabled: ok });
  const me = useAtomValue(meAtom);
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const listed = query.data ? [...query.data.yours, ...query.data.discover] : null;
  const group = listed?.find((item) => item.name === server);
  const live = group ? liveOf(group) : [];
  const shown = live.slice(0, FACES);
  const previewKey = shown.join(',');

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
      <PageFrame title="no such server">
        <p className="text-textSecondary">that is not a server.</p>
      </PageFrame>
    );
  }

  async function join() {
    setBusy(true);
    setError('');
    try {
      await joinServer(server);
      await qc.invalidateQueries({ queryKey: ['explore'] });
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <PageFrame
      wide
      titleId="group-title"
      title={
        <span className="flex min-w-0 items-center gap-3">
          {group && <Badge group={group} />}
          <span className="truncate">{server}</span>
        </span>
      }
    >
      {query.isSuccess && !group ? (
        <p className="text-textSecondary">no such server.</p>
      ) : (
        <>
          {group && !group.mine && (
            <div className="mb-4 flex flex-wrap items-center gap-3">
              <p className="text-textSecondary">you can read this. join to talk.</p>
              {me && (
                <Button id="group-join" className="px-3 py-1.5 text-sm" disabled={busy} onClick={() => void join()}>
                  join
                </Button>
              )}
              {me === null && (
                <Link to="/login" className={buttonClassName('primary', 'px-3 py-1.5 text-sm')}>
                  log in to join
                </Link>
              )}
              {error && <p className="text-sm text-decrease">{error}</p>}
            </div>
          )}
          <div id="group-room" className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div>
              {query.isSuccess && group && shown.length === 0 && <p id="group-empty" className="text-textSecondary">nobody's camera is up.</p>}
              {shown.length > 0 && (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {shown.map((name, i) => (
                    <LiveFace key={name} name={name} big={i === 0 && shown.length > 1} />
                  ))}
                </div>
              )}
              {live.length > FACES && <p className="mt-3 text-sm text-textTertiary">{live.length - FACES} more live</p>}
              {group && group.channels.length > 0 && (
                <ul id="group-channels" className="mt-4 flex flex-wrap gap-x-4 gap-y-1">
                  {group.channels.map((item) => (
                    <li key={item.name}>
                      {item.name === 'general' ? (
                        <span className="font-semibold">#general</span>
                      ) : (
                        <Link id={`group-channel-${item.name}`} to={`/explore/${server}/${item.name}`} className="font-semibold text-primaryBlue">
                          #{item.name}
                        </Link>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="h-[70vh] min-h-[420px]">
              <ChatPanel name={`${server}/general`} className="h-full" />
            </div>
          </div>
        </>
      )}
    </PageFrame>
  );
}
