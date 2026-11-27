import { RiAddLine, RiBroadcastLine, RiCloseLine, RiKickLine, RiLinkM, type RemixiconComponentType, RiTwitchLine } from '@remixicon/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';

import { api, ApiError, type Destination, type DestinationPlatform, destinationStartUrl } from '@/infra/api';
import { setRail } from '@/infra/live-dock';
import { Button } from '@/shared-components/Button';
import { INPUT } from '@/shared-components/input';
import { FOLD_BUTTON } from '@/shared-components/live/Dock';
import { RailSection } from '@/shared-components/live/RailSection';
import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

const KEY = ['destinations'];

const ICONS: Record<DestinationPlatform, RemixiconComponentType> = {
  twitch: RiTwitchLine,
  kick: RiKickLine,
  custom: RiLinkM
};

const WORDS: Record<DestinationPlatform, string> = {
  twitch: 'twitch',
  kick: 'kick',
  custom: 'custom rtmp'
};

const SMALL = 'h-7 gap-1 px-2.5 py-0 text-xs max-md:min-h-0';

function useDestinations() {
  return useQuery({
    queryKey: KEY,
    queryFn: api.destinations,
    retry: (count, e) => !(e instanceof ApiError && (e.status === 404 || e.status === 401)) && count < 1,
    staleTime: 30_000
  });
}

let back = '';

function readBack(): string {
  const q = new URLSearchParams(location.search);
  const ok = q.get('destination');
  const bad = q.get('destination_error');
  if (!ok && !bad) return back;
  q.delete('destination');
  q.delete('destination_error');
  const rest = q.toString();
  history.replaceState(history.state, '', `${location.pathname}${rest ? `?${rest}` : ''}${location.hash}`);
  back = bad ?? `${ok} connected`;
  return back;
}

function stateOf(d: Destination): string {
  if (!d.enabled) return 'off';
  return d.has_key ? 'ready' : 'no key yet';
}

function Row({ d, onStatus }: { d: Destination; onStatus: (words: string) => void }) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const Icon = ICONS[d.platform];
  const name = d.name || WORDS[d.platform];
  const disconnect = async () => {
    setBusy(true);
    try {
      await api.removeDestination(d.id);
      onStatus(`${name} disconnected`);
      await client.invalidateQueries({ queryKey: KEY });
    } catch (e) {
      onStatus(e instanceof Error ? e.message : 'could not disconnect');
    } finally {
      setBusy(false);
    }
  };
  return (
    <li id={`destination-${d.id}`} className="relative flex min-w-0 items-center gap-2 rounded-control border border-primaryStroke px-2 py-1.5">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center text-textSecondary">
        <Icon aria-hidden size={15} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm leading-tight text-textPrimary">{name}</span>
        <span className="truncate text-[11px] leading-tight text-textTertiary">
          {WORDS[d.platform]}, {stateOf(d)}
        </span>
      </span>
      <Tooltip content={`disconnect ${name}`}>
        <button
          id={`destination-remove-${d.id}`}
          type="button"
          aria-label={`disconnect ${name}`}
          disabled={busy}
          onClick={() => void disconnect()}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-control border border-transparent text-textTertiary hover:border-decrease hover:text-decrease focus-visible:border-primaryBlue focus-visible:outline-none disabled:opacity-50"
        >
          <RiCloseLine aria-hidden size={14} />
        </button>
      </Tooltip>
    </li>
  );
}

function CustomForm({ onDone, onStatus }: { onDone: () => void; onStatus: (words: string) => void }) {
  const client = useQueryClient();
  const [url, setUrl] = useState('');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const ok = /^rtmps?:\/\/\S+$/i.test(url.trim()) && key.trim().length > 0;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ok || busy) return;
    setBusy(true);
    try {
      await api.addCustomDestination(url.trim(), key.trim());
      setUrl('');
      setKey('');
      onStatus('custom rtmp added');
      await client.invalidateQueries({ queryKey: KEY });
      onDone();
    } catch (err) {
      onStatus(err instanceof Error ? err.message : 'could not add it');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form id="destination-custom" className="flex flex-col gap-1.5" onSubmit={(e) => void submit(e)}>
      <label htmlFor="destination-custom-url" className="sr-only">
        rtmp server url
      </label>
      <input
        id="destination-custom-url"
        className={cn(INPUT, 'py-1 text-sm')}
        placeholder="rtmps://server/app"
        autoComplete="off"
        spellCheck={false}
        value={url}
        onChange={(e) => setUrl(e.target.value)}
      />
      <label htmlFor="destination-custom-key" className="sr-only">
        stream key
      </label>
      <input
        id="destination-custom-key"
        type="password"
        className={cn(INPUT, 'py-1 text-sm')}
        placeholder="key"
        autoComplete="off"
        value={key}
        onChange={(e) => setKey(e.target.value)}
      />
      <div className="flex items-center gap-1.5">
        <Button id="destination-custom-add" type="submit" size="sm" variant="outline" className={SMALL} disabled={!ok || busy}>
          add
        </Button>
        <Button id="destination-custom-cancel" size="sm" className={SMALL} onClick={onDone}>
          cancel
        </Button>
      </div>
    </form>
  );
}

export function DestinationsBody() {
  const { data } = useDestinations();
  const [status, setStatus] = useState(readBack);
  const [custom, setCustom] = useState(false);
  if (!data) return null;
  const oauth = data.platforms.filter((p): p is 'twitch' | 'kick' => p !== 'custom');
  return (
    <div className="flex flex-col gap-2">
      {data.destinations.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {data.destinations.map((d) => (
            <Row key={d.id} d={d} onStatus={setStatus} />
          ))}
        </ul>
      ) : (
        <p className="flex h-12 items-center justify-center rounded-card border border-dashed border-secondaryStroke px-3 text-center text-xs text-textTertiary">
          none yet: only slop gets the stream
        </p>
      )}
      {custom ? (
        <CustomForm onDone={() => setCustom(false)} onStatus={setStatus} />
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          {oauth.map((p) => {
            const Icon = ICONS[p];
            return (
              <Tooltip key={p} content={`connect ${WORDS[p]}`}>
                <Button id={`destination-connect-${p}`} size="sm" variant="outline" className={SMALL} onClick={() => location.assign(destinationStartUrl(p))}>
                  <Icon aria-hidden size={14} />
                  {WORDS[p]}
                </Button>
              </Tooltip>
            );
          })}
          {data.platforms.includes('custom') && (
            <Tooltip content="add any rtmp server">
              <Button id="destination-connect-custom" size="sm" className={SMALL} onClick={() => setCustom(true)}>
                <RiAddLine aria-hidden size={14} />
                rtmp
              </Button>
            </Tooltip>
          )}
        </div>
      )}
      <span id="destination-status" className="min-w-0 break-words text-xs text-textSecondary empty:-mt-2" aria-live="polite">
        {status}
      </span>
    </div>
  );
}

export function DestinationsModule({ strip = false }: { strip?: boolean }) {
  const { data } = useDestinations();
  if (!data) return null;
  const count = data.destinations.length;
  if (strip) {
    const words = `open the destinations, ${count} connected`;
    return (
      <div className="flex flex-col items-center border-b border-primaryStroke py-2">
        <Tooltip content={words}>
          <button
            id="live-destinations-mini"
            type="button"
            aria-label={words}
            onClick={() => setRail(true)}
            className={cn(FOLD_BUTTON, count > 0 && 'border-primaryBlue text-primaryBlue')}
          >
            <RiBroadcastLine aria-hidden size={16} />
          </button>
        </Tooltip>
      </div>
    );
  }
  return (
    <RailSection section="destinations" id="live-destinations" title="destinations" className="border-b border-primaryStroke px-3 py-2.5" bodyClassName="pt-2">
      <DestinationsBody />
    </RailSection>
  );
}
