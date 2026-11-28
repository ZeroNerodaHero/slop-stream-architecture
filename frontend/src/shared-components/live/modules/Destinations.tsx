import {
  RiBroadcastLine,
  RiChat3Line,
  RiChatOffLine,
  RiEyeLine,
  RiEyeOffLine,
  RiGroupLine,
  RiKickLine,
  type RemixiconComponentType,
  RiServerLine,
  RiTwitchLine,
  RiUserLine,
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
import { ICON_BUTTON } from '@/shared-components/live/Collapsible';
import { FOLD_BUTTON } from '@/shared-components/live/Dock';
import { RailSection } from '@/shared-components/live/RailSection';
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

const CHAT_MODES: readonly (readonly [ExternalChat, RemixiconComponentType, string, string])[] = [
  ['everyone', RiGroupLine, 'everyone', 'everyone: twitch and kick chat show for everyone on your page'],
  ['studio', RiUserLine, 'just me', 'just me: twitch and kick chat only show in your studio'],
  ['off', RiChatOffLine, 'off', 'off: twitch and kick chat are not read']
];

const CHAT_KEYS: Record<string, (i: number, n: number) => number> = {
  ArrowLeft: (i, n) => (i - 1 + n) % n,
  ArrowUp: (i, n) => (i - 1 + n) % n,
  ArrowRight: (i, n) => (i + 1) % n,
  ArrowDown: (i, n) => (i + 1) % n,
  Home: () => 0,
  End: (_, n) => n - 1
};

const CHAT_BUTTON =
  'flex h-7 w-7 shrink-0 items-center justify-center rounded-control border transition-colors duration-150 focus-visible:border-primaryBlue focus-visible:outline-none max-md:min-h-0';

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
      onStatus(CHAT_MODES.find(([m]) => m === next)?.[3] ?? '');
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
    <div className="flex min-w-0 items-center gap-1.5">
      <Tooltip content="platform chat">
        <span role="img" aria-label="platform chat" className="flex h-7 w-5 shrink-0 items-center justify-center text-textTertiary">
          <RiChat3Line aria-hidden size={14} />
        </span>
      </Tooltip>
      <div id="destination-chat-mode" role="radiogroup" aria-label="platform chat" onKeyDown={onKeyDown} className="flex items-center gap-1">
        {CHAT_MODES.map(([m, Icon, label, tip], i) => {
          const on = m === mode;
          return (
            <Tooltip key={m} content={tip}>
              <button
                ref={(el) => {
                  refs.current[i] = el;
                }}
                id={`destination-chat-${m}`}
                type="button"
                role="radio"
                aria-checked={on}
                aria-label={label}
                tabIndex={on ? 0 : -1}
                data-mode={m}
                aria-disabled={busy || undefined}
                onClick={() => void pick(m)}
                className={cn(
                  CHAT_BUTTON,
                  on
                    ? 'border-primaryBlue bg-primaryBlue/10 text-primaryBlue'
                    : 'border-primaryStroke bg-backgroundSecondary text-textTertiary hover:border-primaryBlue hover:text-primaryBlue'
                )}
              >
                <Icon aria-hidden size={14} />
              </button>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
}

const ROW_BUTTON = 'flex min-w-0 items-center gap-2 px-2 py-1.5 focus-visible:outline-none';

function pressKeys(e: KeyboardEvent<HTMLElement>, act: () => void) {
  if (e.target !== e.currentTarget) return;
  if (e.key !== 'Enter' && e.key !== ' ') return;
  e.preventDefault();
  act();
}

function RowShell({
  row,
  hidden,
  wide,
  on,
  action,
  children
}: {
  row: DestinationRow;
  hidden: boolean;
  wide?: ReactNode;
  on?: boolean;
  action?: { label: string; pressed?: boolean; expanded?: boolean; busy?: boolean; describedBy?: string; id: string; run: () => void };
  children: ReactNode;
}) {
  return (
    <li
      id={`destination-row-${row}`}
      data-hidden={hidden || undefined}
      data-on={on || undefined}
      className={cn(
        'relative flex min-w-0 flex-col border transition-colors duration-150',
        wide ? 'rounded-card' : 'rounded-control',
        on ? 'border-primaryBlue/40 bg-primaryBlue/10' : 'border-primaryStroke',
        action && 'has-[[data-row]:focus-visible]:border-primaryBlue has-[[data-row]:hover]:border-primaryBlue'
      )}
    >
      {action ? (
        <div
          id={action.id}
          data-row
          role="button"
          tabIndex={0}
          aria-label={action.label}
          aria-pressed={action.pressed}
          aria-expanded={action.expanded}
          aria-disabled={action.busy || undefined}
          aria-describedby={action.describedBy}
          onClick={() => !action.busy && action.run()}
          onKeyDown={(e) => pressKeys(e, () => !action.busy && action.run())}
          className={cn(ROW_BUTTON, 'cursor-pointer', hidden && 'opacity-50')}
        >
          {children}
        </div>
      ) : (
        <div className={cn(ROW_BUTTON, hidden && 'opacity-50')}>{children}</div>
      )}
      {wide && <div className="px-2 pb-2">{wide}</div>}
    </li>
  );
}

function RowText({ row, title, sub, state, tip, dot }: { row: DestinationRow; title: string; sub: string; state?: string; tip?: string; dot?: 'on' | 'off' }) {
  const Icon = ICONS[row];
  const words = (
    <span
      id={`destination-state-${row}`}
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
      <span className="relative flex h-6 w-6 shrink-0 items-center justify-center text-textSecondary">
        <Icon aria-hidden size={15} />
        {dot && (
          <span
            id={`destination-dot-${row}`}
            aria-hidden
            data-dot={dot}
            className={cn('absolute right-0 top-0 h-2 w-2 rounded-avatar', dot === 'on' ? 'bg-increase' : 'bg-decrease')}
          />
        )}
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
        onClick={(e) => {
          e.stopPropagation();
          setDestinationHidden(row, !hidden);
        }}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <Icon aria-hidden size={14} />
      </button>
    </Tooltip>
  );
}

function Connected({ d, hidden, blocked, onStatus }: { d: Destination; hidden: boolean; blocked: boolean; onStatus: (words: string) => void }) {
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
  const dot = d.enabled && d.has_key && live?.state !== 'error' && (!blocked || !!live) ? 'on' : 'off';
  return (
    <RowShell
      row={d.platform}
      hidden={hidden}
      on={d.enabled}
      action={{
        id: `destination-toggle-${d.platform}`,
        label: `send the stream to ${name}`,
        pressed: d.enabled,
        busy,
        describedBy: `destination-state-${d.platform}`,
        run: () => void flip(!d.enabled)
      }}
    >
      <RowText row={d.platform} title={name} sub={words} tip={words} state={d.enabled ? (live?.state ?? 'idle') : 'off'} dot={dot} />
      <Eye row={d.platform} hidden={hidden} />
    </RowShell>
  );
}

function Unconnected({ row, open, hidden, onStatus }: { row: DestinationRow; open: boolean; hidden: boolean; onStatus: (words: string) => void }) {
  const [adding, setAdding] = useState(false);
  const custom = row === 'custom';
  const words = custom ? 'add server' : `connect ${WORDS[row]}`;
  return (
    <RowShell
      row={row}
      hidden={hidden}
      wide={adding && open && custom ? <CustomForm onDone={() => setAdding(false)} onStatus={onStatus} /> : null}
      action={
        open
          ? {
              id: `destination-connect-${row}`,
              label: words,
              expanded: custom ? adding : undefined,
              run: () => (custom ? setAdding((a) => !a) : location.assign(destinationStartUrl(row)))
            }
          : undefined
      }
    >
      <RowText row={row} title={WORDS[row]} sub={open ? (custom ? 'no server yet' : 'not connected') : 'not on here yet'} />
      <Eye row={row} hidden={hidden} />
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
  const directOn = useAtomValue(restreamDirectAtom);
  if (!data) return null;
  const block = restreamBlock(!!data.relay, !!data.direct, inTauri(), directOn);
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
              <Connected key={r} d={d} hidden={off} blocked={!!block} onStatus={setStatus} />
            ) : (
              <Unconnected key={r} row={r} open={data.platforms.includes(r)} hidden={off} onStatus={setStatus} />
            );
          })}
        </ul>
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
  const reveal = useAtomValue(revealHiddenDestinationsAtom);
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
    <RailSection
      section="destinations"
      id="live-destinations"
      title="destinations"
      aside={hidden > 0 && <ShowHidden count={hidden} showing={reveal} onToggle={() => setRevealHiddenDestinations(!reveal)} />}
      className="border-b border-primaryStroke px-3 py-2.5"
      bodyClassName="pt-2"
    >
      <DestinationsBody reveal={reveal} />
    </RailSection>
  );
}
