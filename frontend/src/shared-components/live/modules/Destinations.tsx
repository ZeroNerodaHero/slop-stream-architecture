import { RiBroadcastLine, RiEyeLine, RiEyeOffLine, RiKickLine, RiLinkM, type RemixiconComponentType, RiServerLine, RiTwitchLine, RiYoutubeLine } from '@remixicon/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAtomValue } from 'jotai';
import { type FormEvent, type ReactNode, useState } from 'react';

import { type DestinationRow, hiddenDestinationsAtom, setDestinationHidden } from '@/infra/atoms/settings-atoms';
import { api, ApiError, type Destination, type DestinationPlatform, destinationStartUrl, type RelayStatus } from '@/infra/api';
import { setRail } from '@/infra/live-dock';
import { directStatusAtom, restreamAtom, restreamMessageAtom } from '@/infra/restream';
import { Button } from '@/shared-components/Button';
import { INPUT } from '@/shared-components/input';
import { ICON_BUTTON } from '@/shared-components/live/Collapsible';
import { FOLD_BUTTON } from '@/shared-components/live/Dock';
import { RailSection } from '@/shared-components/live/RailSection';
import { Switch } from '@/shared-components/Switch';
import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

export const DESTINATIONS_KEY = ['destinations'];
const KEY = DESTINATIONS_KEY;

const ICONS: Record<DestinationPlatform, RemixiconComponentType> = {
  twitch: RiTwitchLine,
  kick: RiKickLine,
  youtube: RiYoutubeLine,
  custom: RiServerLine
};

export const DESTINATION_WORDS: Record<DestinationPlatform, string> = {
  twitch: 'twitch',
  kick: 'kick',
  youtube: 'youtube',
  custom: 'custom rtmp'
};
const WORDS = DESTINATION_WORDS;
const ROWS: DestinationRow[] = ['twitch', 'kick', 'youtube', 'custom'];

const SMALL = 'h-7 gap-1 px-2.5 py-0 text-xs max-md:min-h-0';
const LINK = 'h-7 w-7 shrink-0 p-0 max-md:min-h-0';

export function useDestinations() {
  const relaying = useAtomValue(restreamAtom) !== 'off';
  return useQuery({
    refetchInterval: relaying ? 3000 : false,
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

export function liveOf(d: Destination, direct: Record<string, RelayStatus>): RelayStatus | undefined {
  const mine = direct[d.id];
  if (!mine) return d.relay;
  const said = d.relay?.state === 'error' ? d.relay.message : d.relay?.note;
  return said && mine.state !== 'error' ? { ...mine, note: said } : mine;
}

export function stateOf(d: Destination, r: RelayStatus | undefined = d.relay): string {
  if (!d.enabled) return 'off';
  if (r?.state === 'live') return r.note ? `live, ${r.note}` : 'live';
  if (r?.state === 'connecting') return 'connecting';
  if (r?.state === 'error') return r.message ? `error: ${r.message}` : 'error';
  return d.has_key ? 'ready' : 'no key yet';
}

function RowShell({ row, hidden, wide, children }: { row: DestinationRow; hidden: boolean; wide?: ReactNode; children: ReactNode }) {
  return (
    <li
      id={`destination-row-${row}`}
      data-hidden={hidden || undefined}
      className={cn('relative flex min-w-0 flex-col gap-1.5 border border-primaryStroke px-2 py-1.5', wide ? 'rounded-card pb-2' : 'rounded-control')}
    >
      <div className={cn('flex min-w-0 items-center gap-2', hidden && 'opacity-50')}>{children}</div>
      {wide}
    </li>
  );
}

function RowText({ row, title, sub, state, tip }: { row: DestinationRow; title: string; sub: string; state?: string; tip?: string }) {
  const Icon = ICONS[row];
  const words = (
    <span
      id={`destination-state-${row}`}
      tabIndex={tip ? 0 : undefined}
      data-state={state}
      className={cn(
        'truncate text-[11px] leading-tight text-textTertiary focus-visible:outline-none',
        state === 'live' && 'text-increase',
        state === 'error' && 'text-decrease'
      )}
    >
      {sub}
    </span>
  );
  return (
    <>
      <span className="flex h-6 w-6 shrink-0 items-center justify-center text-textSecondary">
        <Icon aria-hidden size={15} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm leading-tight text-textPrimary">{title}</span>
        {tip ? <Tooltip content={tip}>{words}</Tooltip> : words}
      </span>
    </>
  );
}

function Eye({ row, hidden }: { row: DestinationRow; hidden: boolean }) {
  const Icon = hidden ? RiEyeOffLine : RiEyeLine;
  const words = hidden ? 'show' : 'hide';
  return (
    <Tooltip content={words}>
      <button
        id={`destination-hide-${row}`}
        type="button"
        aria-label={`${words} ${WORDS[row]}`}
        aria-pressed={hidden}
        className={ICON_BUTTON}
        onClick={() => setDestinationHidden(row, !hidden)}
      >
        <Icon aria-hidden size={14} />
      </button>
    </Tooltip>
  );
}

function Connected({ d, hidden, onStatus }: { d: Destination; hidden: boolean; onStatus: (words: string) => void }) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const live = liveOf(d, useAtomValue(directStatusAtom));
  const name = d.name || WORDS[d.platform];
  const flip = async (enabled: boolean) => {
    setBusy(true);
    try {
      await api.setDestinationEnabled(d.id, enabled);
      onStatus(enabled ? `${name} on: it gets the stream` : `${name} off: it sits this one out`);
      await client.invalidateQueries({ queryKey: KEY });
    } catch (e) {
      onStatus(e instanceof Error ? e.message : 'could not switch it');
    } finally {
      setBusy(false);
    }
  };
  const words = `${WORDS[d.platform]}, ${stateOf(d, live)}`;
  return (
    <RowShell row={d.platform} hidden={hidden}>
      <RowText row={d.platform} title={name} sub={words} tip={words} state={d.enabled ? (live?.state ?? 'idle') : 'off'} />
      <Eye row={d.platform} hidden={hidden} />
      <Tooltip content={d.enabled ? `${name} gets the stream: switch off to skip it` : `${name} is off: switch on to send it the stream`}>
        <Switch id={`destination-switch-${d.id}`} checked={d.enabled} disabled={busy} label={`send the stream to ${name}`} onChange={(on) => void flip(on)} />
      </Tooltip>
    </RowShell>
  );
}

function Unconnected({ row, open, hidden, onStatus }: { row: DestinationRow; open: boolean; hidden: boolean; onStatus: (words: string) => void }) {
  const [adding, setAdding] = useState(false);
  const custom = row === 'custom';
  const words = custom ? 'add server' : `connect ${WORDS[row]}`;
  const action = open && (
    <Tooltip content={words}>
      <Button
        id={`destination-connect-${row}`}
        size="sm"
        variant="outline"
        aria-label={words}
        className={LINK}
        disabled={adding}
        onClick={() => (custom ? setAdding(true) : location.assign(destinationStartUrl(row)))}
      >
        <RiLinkM aria-hidden size={14} />
      </Button>
    </Tooltip>
  );
  return (
    <RowShell row={row} hidden={hidden} wide={adding && open && custom ? <CustomForm onDone={() => setAdding(false)} onStatus={onStatus} /> : null}>
      <RowText row={row} title={WORDS[row]} sub={open ? (custom ? 'no server yet' : 'not connected') : 'not on here yet'} />
      <Eye row={row} hidden={hidden} />
      {action}
    </RowShell>
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
        placeholder="url"
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

function ShowHidden({ count, showing, onToggle }: { count: number; showing: boolean; onToggle: () => void }) {
  const Icon = showing ? RiEyeOffLine : RiEyeLine;
  const words = showing ? 'hide hidden' : `show hidden (${count})`;
  return (
    <>
      {count > 0 && (
        <span id="destination-hidden-count" aria-hidden className="text-[10px] font-medium normal-case leading-none tracking-normal tabular-nums">
          {count}
        </span>
      )}
      <Tooltip content={words}>
        <button
          id="destination-show-hidden"
          type="button"
          aria-label={words}
          aria-pressed={showing}
          onClick={onToggle}
          className={cn(FOLD_BUTTON, showing && 'border-primaryBlue text-primaryBlue')}
        >
          <Icon aria-hidden size={14} />
        </button>
      </Tooltip>
    </>
  );
}

function DestinationsBody({ reveal }: { reveal: boolean }) {
  const { data } = useDestinations();
  const [status, setStatus] = useState(readBack);
  const hidden = useAtomValue(hiddenDestinationsAtom);
  const relayWords = useAtomValue(restreamMessageAtom);
  if (!data) return null;
  const showing = reveal && hidden.length > 0;
  const rows = ROWS.filter((r) => showing || !hidden.includes(r));
  return (
    <div className="flex flex-col gap-2">
      {rows.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {rows.map((r) => {
            const d = data.destinations.find((x) => x.platform === r);
            const off = hidden.includes(r);
            return d ? (
              <Connected key={r} d={d} hidden={off} onStatus={setStatus} />
            ) : (
              <Unconnected key={r} row={r} open={data.platforms.includes(r)} hidden={off} onStatus={setStatus} />
            );
          })}
        </ul>
      )}
      <span id="destination-status" className="min-w-0 break-words text-xs text-textSecondary empty:-mt-2" aria-live="polite">
        {status}
      </span>
      {relayWords && (
        <span id="destination-relay" className="min-w-0 break-words text-xs text-textTertiary" aria-live="polite">
          {relayWords}
        </span>
      )}
    </div>
  );
}

export function DestinationsModule({ strip = false }: { strip?: boolean }) {
  const { data } = useDestinations();
  const [reveal, setReveal] = useState(false);
  const hidden = useAtomValue(hiddenDestinationsAtom).length;
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
    <RailSection
      section="destinations"
      id="live-destinations"
      title="destinations"
      aside={hidden > 0 && <ShowHidden count={hidden} showing={reveal} onToggle={() => setReveal(!reveal)} />}
      className="border-b border-primaryStroke px-3 py-2.5"
      bodyClassName="pt-2"
    >
      <DestinationsBody reveal={reveal} />
    </RailSection>
  );
}
