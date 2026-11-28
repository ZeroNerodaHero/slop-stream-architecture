import {
  RiArrowDownSLine,
  RiBroadcastLine,
  RiChat3Line,
  RiEyeLine,
  RiEyeOffLine,
  RiKickLine,
  RiLink,
  type RemixiconComponentType,
  RiServerLine,
  RiTwitchLine,
  RiYoutubeLine
} from '@remixicon/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAtomValue } from 'jotai';
import { type FormEvent, type KeyboardEvent, type ReactNode, useRef, useState } from 'react';

import {
  type DestinationRow,
  hiddenDestinationsAtom,
  restreamDirectAtom,
  revealHiddenDestinationsAtom,
  setDestinationHidden,
  setRevealHiddenDestinations
} from '@/infra/atoms/settings-atoms';
import { api, ApiError, type Destination, type DestinationPlatform, type Destinations, destinationStartUrl, type ExternalChat, type RelayStatus } from '@/infra/api';
import { openRailAt } from '@/infra/live-dock';
import { directStatusAtom, restreamAtom, restreamMessageAtom } from '@/infra/restream';
import { restreamBlock } from '@/infra/restream-block';
import { inTauri } from '@/infra/update-check';
import { Button } from '@/shared-components/Button';
import { INPUT } from '@/shared-components/input';
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

export function stateOf(d: Destination, r: RelayStatus | undefined = d.relay, blocked = false): string {
  if (!d.enabled) return 'off';
  if (blocked && !r) return 'on, not sending';
  if (r?.state === 'live') return r.note ? `live, ${r.note}` : 'live';
  if (r?.state === 'connecting') return 'connecting';
  if (r?.state === 'error') return r.message ? `error: ${r.message}` : 'error';
  return d.has_key ? 'ready' : 'no key yet';
}

export function chatStateOf(c: RelayStatus | undefined): string | null {
  if (!c) return null;
  if (c.state === 'live') return 'chat live';
  if (c.state === 'connecting') return c.message ? `chat connecting: ${c.message}` : 'chat connecting';
  if (c.state === 'error') return c.message ? `chat error: ${c.message}` : 'chat error';
  return null;
}

const CHAT_MODES: readonly (readonly [ExternalChat, string])[] = [
  ['everyone', 'everyone'],
  ['studio', 'just me'],
  ['off', 'off']
];

const CHAT_KEYS: Record<string, (i: number, n: number) => number> = {
  ArrowLeft: (i, n) => (i - 1 + n) % n,
  ArrowUp: (i, n) => (i - 1 + n) % n,
  ArrowRight: (i, n) => (i + 1) % n,
  ArrowDown: (i, n) => (i + 1) % n,
  Home: () => 0,
  End: (_, n) => n - 1
};

const BOX_BUTTON =
  'flex h-7 min-w-0 items-center justify-center gap-1 rounded-control border px-2 text-xs transition-colors duration-150 focus-visible:border-primaryBlue focus-visible:outline-none max-md:min-h-0';
const QUIET = 'border-primaryStroke bg-backgroundSecondary text-textSecondary hover:border-primaryBlue hover:text-primaryBlue';

function ChatMode({ data, onStatus }: { data: Destinations; onStatus: (words: string) => void }) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const mode = data.external_chat ?? 'everyone';
  const index = Math.max(
    0,
    CHAT_MODES.findIndex(([m]) => m === mode)
  );
  const pick = async (next: ExternalChat) => {
    if (next === mode || busy) return;
    setBusy(true);
    try {
      await api.setExternalChat(next);
      onStatus(`platform chat: ${CHAT_MODES.find(([m]) => m === next)?.[1] ?? next}`);
      await client.invalidateQueries({ queryKey: KEY });
      await client.invalidateQueries({ queryKey: ['chat-sources'] });
    } catch (e) {
      onStatus(e instanceof Error ? e.message : 'could not switch it');
    } finally {
      setBusy(false);
    }
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const move = CHAT_KEYS[e.key];
    if (!move || busy) return;
    e.preventDefault();
    const next = move(index, CHAT_MODES.length);
    const option = CHAT_MODES[next];
    if (!option) return;
    refs.current[next]?.focus();
    void pick(option[0]);
  };
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span id="destination-chat-label" className="flex items-center gap-1 text-[11px] leading-tight text-textTertiary">
        <RiChat3Line aria-hidden size={12} />
        platform chat
      </span>
      <div id="destination-chat-mode" role="radiogroup" aria-labelledby="destination-chat-label" onKeyDown={onKeyDown} className="grid grid-cols-3 gap-1">
        {CHAT_MODES.map(([m, label], i) => {
          const on = m === mode;
          return (
            <button
              key={m}
              ref={(el) => {
                refs.current[i] = el;
              }}
              id={`destination-chat-${m}`}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={on ? 0 : -1}
              data-mode={m}
              aria-disabled={busy || undefined}
              onClick={() => void pick(m)}
              className={cn(BOX_BUTTON, on ? 'border-primaryBlue bg-primaryBlue/10 text-primaryBlue' : QUIET)}
            >
              <span className="truncate">{label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

type Health = 'good' | 'bad' | 'off';

const HEALTH_COLOUR: Record<Health, string> = {
  good: 'text-increase',
  bad: 'text-decrease',
  off: 'text-textTertiary'
};

function healthOf(d: Destination | undefined, open: boolean, live: RelayStatus | undefined, blocked = false): Health {
  if (!d) return open ? 'bad' : 'off';
  if (!d.enabled) return 'off';
  if (!d.has_key || live?.state === 'error' || d.chat?.state === 'error' || (blocked && !live)) return 'bad';
  return 'good';
}

function Row({
  row,
  name,
  health,
  hidden,
  open,
  onOpen,
  children
}: {
  row: DestinationRow;
  name: string;
  health: Health;
  hidden: boolean;
  open: boolean;
  onOpen: () => void;
  children: ReactNode;
}) {
  const Icon = ICONS[row];
  return (
    <li
      id={`destination-row-${row}`}
      data-health={health}
      data-hidden={hidden || undefined}
      data-open={open || undefined}
      className={cn(
        'flex min-w-0 flex-col border transition-colors duration-150 has-[[data-row]:focus-visible]:border-primaryBlue has-[[data-row]:hover]:border-primaryBlue',
        open ? 'rounded-card border-primaryBlue/40' : 'rounded-control border-primaryStroke'
      )}
    >
      <button
        id={`destination-open-${row}`}
        data-row
        type="button"
        aria-expanded={open}
        aria-controls={`destination-panel-${row}`}
        onClick={onOpen}
        className={cn('flex min-w-0 items-center gap-2 px-2 py-1.5 text-left focus-visible:outline-none', hidden && 'opacity-50')}
      >
        <span id={`destination-dot-${row}`} data-dot={health} className={cn('flex h-5 w-5 shrink-0 items-center justify-center', HEALTH_COLOUR[health])}>
          <Icon aria-hidden size={15} />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm leading-tight text-textPrimary">{name}</span>
        <RiArrowDownSLine aria-hidden size={14} className={cn('shrink-0 text-textTertiary transition-transform duration-150', open && 'rotate-180')} />
      </button>
      {open && (
        <div id={`destination-panel-${row}`} role="region" aria-labelledby={`destination-open-${row}`} className="flex min-w-0 flex-col gap-2 px-2 pb-2">
          {children}
        </div>
      )}
    </li>
  );
}

function StateText({ row, words, health }: { row: DestinationRow; words: string; health: Health }) {
  return (
    <span
      id={`destination-state-${row}`}
      data-state={health}
      className={cn('min-w-0 break-words text-xs leading-tight', health === 'bad' ? 'text-decrease' : 'text-textSecondary')}
    >
      {words}
    </span>
  );
}

function Eye({ row, hidden, onHide }: { row: DestinationRow; hidden: boolean; onHide: () => void }) {
  const Icon = hidden ? RiEyeLine : RiEyeOffLine;
  const words = hidden ? 'show' : 'hide';
  return (
    <button
      id={`destination-hide-${row}`}
      type="button"
      aria-label={`${words} ${WORDS[row]}`}
      aria-pressed={hidden}
      className={cn(BOX_BUTTON, QUIET, 'ml-auto shrink-0')}
      onClick={() => {
        if (!hidden) onHide();
        setDestinationHidden(row, !hidden);
      }}
    >
      <Icon aria-hidden size={13} />
      {words}
    </button>
  );
}

function Connected({
  d,
  hidden,
  blocked,
  open,
  onOpen,
  onClose,
  onStatus
}: {
  d: Destination;
  hidden: boolean;
  blocked: boolean;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onStatus: (words: string) => void;
}) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const live = liveOf(d, useAtomValue(directStatusAtom));
  const name = d.name || WORDS[d.platform];
  const flip = async (enabled: boolean) => {
    if (busy) return;
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
  const chat = d.enabled ? chatStateOf(d.chat) : null;
  const words = `${WORDS[d.platform]}, ${stateOf(d, live, blocked)}${chat ? ` · ${chat}` : ''}`;
  const health = healthOf(d, true, live, blocked);
  return (
    <Row row={d.platform} name={name} health={health} hidden={hidden} open={open} onOpen={onOpen}>
      <StateText row={d.platform} words={words} health={health} />
      <div className="flex min-w-0 items-center gap-2">
        <Switch id={`destination-toggle-${d.platform}`} checked={d.enabled} disabled={busy} label={`stream to ${name}`} onChange={(on) => void flip(on)} />
        <span aria-hidden className="truncate text-xs text-textSecondary">
          {d.enabled ? 'streaming here' : 'not streaming here'}
        </span>
        <Eye row={d.platform} hidden={hidden} onHide={onClose} />
      </div>
    </Row>
  );
}

function Unconnected({
  row,
  available,
  hidden,
  open,
  onOpen,
  onClose,
  onStatus
}: {
  row: DestinationRow;
  available: boolean;
  hidden: boolean;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onStatus: (words: string) => void;
}) {
  const custom = row === 'custom';
  const health = healthOf(undefined, available, undefined);
  return (
    <Row row={row} name={WORDS[row]} health={health} hidden={hidden} open={open} onOpen={onOpen}>
      <StateText row={row} words={available ? (custom ? 'no server yet' : 'not connected') : 'not on here yet'} health={health} />
      {available && custom && <CustomForm onDone={onClose} onStatus={onStatus} />}
      <div className="flex min-w-0 items-center gap-2">
        {available && row !== 'custom' && (
          <button
            id={`destination-connect-${row}`}
            type="button"
            onClick={() => location.assign(destinationStartUrl(row))}
            className={cn(BOX_BUTTON, 'border-primaryBlue bg-primaryBlue/10 text-primaryBlue hover:bg-primaryBlue/20')}
          >
            <RiLink aria-hidden size={13} />
            connect {WORDS[row]}
          </button>
        )}
        <Eye row={row} hidden={hidden} onHide={onClose} />
      </div>
    </Row>
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
        placeholder="rtmp://server/app"
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
        placeholder="stream key"
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

function DestinationsBody() {
  const { data } = useDestinations();
  const [status, setStatus] = useState(readBack);
  const [open, setOpen] = useState<DestinationRow | null>(null);
  const hidden = useAtomValue(hiddenDestinationsAtom);
  const reveal = useAtomValue(revealHiddenDestinationsAtom);
  const relayWords = useAtomValue(restreamMessageAtom);
  const directOn = useAtomValue(restreamDirectAtom);
  if (!data) return null;
  const block = restreamBlock(!!data.relay, !!data.direct, inTauri(), directOn);
  const shown = ROWS.filter((r) => !hidden.includes(r));
  const tucked = ROWS.filter((r) => hidden.includes(r));
  const item = (r: DestinationRow) => {
    const d = data.destinations.find((x) => x.platform === r);
    const props = {
      hidden: hidden.includes(r),
      open: open === r,
      onOpen: () => setOpen((o) => (o === r ? null : r)),
      onClose: () => setOpen(null),
      onStatus: setStatus
    };
    return d ? <Connected key={r} d={d} blocked={!!block} {...props} /> : <Unconnected key={r} row={r} available={data.platforms.includes(r)} {...props} />;
  };
  return (
    <div className="flex flex-col gap-2">
      {shown.length > 0 && <ul className="m-0 flex list-none flex-col gap-1 p-0">{shown.map(item)}</ul>}
      {tucked.length > 0 && (
        <div className="flex flex-col gap-1">
          <button
            id="destination-show-hidden"
            type="button"
            aria-expanded={reveal}
            aria-controls="destination-hidden-list"
            onClick={() => setRevealHiddenDestinations(!reveal)}
            className="flex h-6 items-center gap-1 self-start rounded-control border border-transparent px-1 text-[11px] text-textTertiary transition-colors duration-150 hover:text-primaryBlue focus-visible:border-primaryBlue focus-visible:outline-none"
          >
            <RiArrowDownSLine aria-hidden size={13} className={cn('transition-transform duration-150', reveal && 'rotate-180')} />
            hidden ({tucked.length})
          </button>
          {reveal && (
            <ul id="destination-hidden-list" className="m-0 flex list-none flex-col gap-1 p-0">
              {tucked.map(item)}
            </ul>
          )}
        </div>
      )}
      {data.destinations.some((d) => d.platform === 'twitch' || d.platform === 'kick') && <ChatMode data={data} onStatus={setStatus} />}
      <span id="destination-status" className="min-w-0 break-words text-xs text-textSecondary empty:-mt-2" aria-live="polite">
        {status}
      </span>
      {block && data.destinations.length > 0 && (
        <span id="destination-blocked" className="min-w-0 break-words text-xs text-decrease" aria-live="polite">
          {block}
        </span>
      )}
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
            onClick={() => openRailAt('destinations')}
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
