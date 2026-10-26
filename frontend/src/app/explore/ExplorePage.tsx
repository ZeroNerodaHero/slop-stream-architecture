import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAtomValue } from 'jotai';
import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';

import { api, messageOf, type Server } from '@/infra/api';
import { meAtom } from '@/infra/atoms/auth-atoms';
import { reconnectChat } from '@/infra/atoms/chat-atoms';
import { cleanName, isValidName } from '@/infra/names';
import { Badge } from '@/shared-components/Badge';
import { Button, buttonClassName } from '@/shared-components/Button';
import { ChatPanel } from '@/shared-components/ChatPanel';
import { PageFrame } from '@/shared-components/PageFrame';
import { cn } from '@/utils/cn';

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
        <span className="font-semibold">{server.name}</span>
        <span className="text-sm text-textTertiary">
          {server.members} {server.members === 1 ? 'member' : 'members'}
        </span>
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
            {server}
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
