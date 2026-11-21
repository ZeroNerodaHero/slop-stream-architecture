import { RiSearchLine } from '@remixicon/react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';

import { type ModLogRow, type SearchHit, api, messageOf } from '@/infra/api';
import { PRESENCE_WORD } from '@/infra/atoms/presence-atoms';
import { usePeopleSearch } from '@/infra/people-search';
import { Button } from '@/shared-components/Button';
import { Face } from '@/shared-components/Face';
import { Who } from '@/shared-components/PersonRow';
import { PresenceSquare } from '@/shared-components/PresenceSquare';
import { Tooltip } from '@/shared-components/Tooltip';
import { INPUT } from '@/shared-components/input';
import { SECTION_TITLE } from '@/shared-components/user-modal/parts';
import { cn } from '@/utils/cn';

const ROW = 'flex items-center gap-3 border-b border-primaryStroke py-1.5 last:border-b-0';
/** A face in a row of the tab: the jannies, the banned. */
const ROW_FACE = 'h-7 w-7 text-xs';

/** "3m ago", "2h ago", "4d ago". */
function ago(iso: string): string {
  const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

/** "in 9m", "in 3h". */
function left(iso: string): string {
  const secs = Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 1000));
  if (secs < 60) return `${secs}s left`;
  if (secs < 3600) return `${Math.ceil(secs / 60)}m left`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h left`;
  return `${Math.round(secs / 86400)}d left`;
}

/** A timeout's length: "30s", "10m", "1h", "7d". */
function length(secs: number): string {
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.round(secs / 60)}m`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h`;
  return `${Math.round(secs / 86400)}d`;
}

/** A log row's detail column: a deleted line's words (or its pictures), a ban's reason, a timeout's length. */
function detailOf(row: ModLogRow): string {
  switch (row.action) {
    case 'delete': {
      const text = row.snapshot?.text?.trim();
      if (text) return text;
      const pics = row.snapshot?.images?.length ?? 0;
      return pics ? `${pics} picture${pics > 1 ? 's' : ''}` : '';
    }
    case 'ban':
      return row.snapshot?.reason ?? '';
    case 'timeout':
      return row.snapshot?.seconds ? length(row.snapshot.seconds) : '';
    default:
      return '';
  }
}

/** The action chip's colour: a ban in the decrease colour, a timeout in caution, the rest quiet. */
function chipColor(action: string): string {
  if (action === 'ban') return 'border-decrease/60 text-decrease';
  if (action === 'timeout') return 'border-caution/60 text-caution';
  return 'border-primaryStroke text-textTertiary';
}

/** The log's filters: which actions each shows. `all` shows every one. */
const FILTERS = [
  { word: 'all', actions: null },
  { word: 'deletes', actions: ['delete'] },
  { word: 'bans', actions: ['ban', 'unban'] },
  { word: 'timeouts', actions: ['timeout', 'untimeout'] },
  { word: 'jannies', actions: ['janny', 'unjanny'] }
] as const;
type Filter = (typeof FILTERS)[number]['word'];

/**
 * The faces of the names the tab lists (jannies, the banned): each a profile read, kept a few
 * minutes. The jannies and ban answers carry no picture; until one answers, or for a name with
 * no account, the letter the name makes stands in (`Face`).
 */
function useFaces(names: string[]): Map<string, number | null> {
  const reads = useQueries({
    queries: names.map((n) => ({
      queryKey: ['face', n],
      queryFn: () => api.streamer(n).then((s) => s.avatar),
      staleTime: 5 * 60_000,
      retry: false
    }))
  });
  return new Map(names.map((n, i) => [n, reads[i]?.data ?? null]));
}

/**
 * Find a janny by name: a box like the sidebar's search (Friends.tsx) with its own letters
 * (`usePeopleSearch`, not the sidebar's atoms), and under it the people found, each with their
 * face and name. Up and down move through them, enter or a click makes that one a janny at once,
 * escape closes the list. The streamer and their jannies are left out: there is nothing to add.
 */
function JannySearch({ skip, busy, onPick }: { skip: Set<string>; busy: boolean; onPick: (who: string) => Promise<unknown> }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLInputElement | null>(null);
  const found = usePeopleSearch(query);
  const hits = found.hits.filter((h) => !skip.has(h.name));
  const shown = open && found.q !== '';
  const at = Math.min(active, Math.max(0, hits.length - 1));

  // the row the keys rest on stays in sight in a list taller than its box
  useEffect(() => {
    if (shown) document.getElementById(`mod-janny-hit-${at}`)?.scrollIntoView({ block: 'nearest' });
  }, [shown, at]);

  const pick = (hit: SearchHit) => {
    if (busy) return;
    setQuery('');
    setActive(0);
    box.current?.focus();
    void onPick(hit.name);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape' && shown) {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      return;
    }
    if (!shown || hits.length === 0) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((at + step + hits.length) % hits.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const hit = hits[at];
      if (hit) pick(hit);
    }
  };

  return (
    // its own height, not the row's: the list opens under the box, not under the jannies beside it
    <div className="relative min-w-0 self-start">
      <label htmlFor="mod-janny-search" className="sr-only">
        find someone to make a janny
      </label>
      <div className="relative">
        <RiSearchLine aria-hidden size={18} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-textTertiary max-md:left-3" />
        <input
          ref={box}
          id="mod-janny-search"
          type="search"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={shown}
          aria-controls="mod-janny-hits"
          aria-activedescendant={shown && hits.length > 0 ? `mod-janny-hit-${at}` : undefined}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
          placeholder="search"
          maxLength={32}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          className={cn(INPUT, 'h-8 pl-10 pr-3 text-sm max-md:h-10 max-md:pl-12')}
        />
      </div>
      {shown && (
        <ul
          id="mod-janny-hits"
          role="listbox"
          aria-label="people found"
          // a press leaves the focus in the box; the click picks
          onMouseDown={(e) => e.preventDefault()}
          className="absolute left-0 right-0 top-full z-20 mt-1 max-h-72 overflow-y-auto border border-primaryStroke bg-backgroundSecondary py-1"
        >
          {hits.length === 0 ? (
            <li className="px-3 py-1.5 text-sm text-textTertiary">{found.settled ? 'nobody found' : 'searching'}</li>
          ) : (
            hits.map((hit, i) => (
              <li
                key={hit.name}
                id={`mod-janny-hit-${i}`}
                role="option"
                aria-selected={i === at}
                data-name={hit.name}
                onMouseMove={() => i !== at && setActive(i)}
                onClick={() => pick(hit)}
                className={cn('flex cursor-pointer items-center gap-2 px-2 py-1', i === at ? 'bg-primaryBlue/10' : 'hover:bg-backgroundTertiary')}
              >
                <span className="relative block shrink-0">
                  <Face name={hit.name} version={hit.avatar} className="h-8 w-8 text-sm max-md:h-10 max-md:w-10 max-md:text-lg" />
                  <PresenceSquare status={hit.presence} className="border-backgroundSecondary" />
                </span>
                <span className="sr-only">{PRESENCE_WORD[hit.presence]}</span>
                <Who name={hit.name} verified={hit.verified} oauthVerified={hit.oauth_verified} className={cn('text-sm', i === at && 'text-primaryBlue')} />
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

/**
 * The mod tab, on my own page only (docs/jannies.md): my stream's jannies (found by name and
 * added in one pick, removed from the list beside), who is banned or timed out of my chat (lift
 * either), and the log of what was done in it, filtered by kind. A janny deletes, bans and times
 * out from the chat's lines; this is where the streamer keeps the list.
 */
export function ModTab({ name }: { name: string }) {
  const client = useQueryClient();
  const jannies = useQuery({ queryKey: ['jannies', name], queryFn: () => api.streamJannies(name), retry: false });
  const bans = useQuery({ queryKey: ['chat-bans', name], queryFn: () => api.chatBans(name), retry: false });
  const log = useQuery({ queryKey: ['mod-log', name], queryFn: () => api.modLog(name), retry: false });
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');

  const listed = [...(jannies.data ?? []).map((j) => j.name), ...(bans.data?.bans ?? []).map((b) => b.name), ...(bans.data?.timeouts ?? []).map((t) => t.name)];
  const faces = useFaces([...new Set(listed)]);
  const skip = new Set([name, ...(jannies.data ?? []).map((j) => j.name)]);
  const actions = FILTERS.find((f) => f.word === filter)?.actions ?? null;
  const rows = (log.data ?? []).filter((row) => !actions || (actions as readonly string[]).includes(row.action));

  const run = async (what: () => Promise<unknown>, done = '') => {
    setBusy(true);
    setStatus('');
    try {
      await what();
      setStatus(done);
    } catch (err) {
      setStatus(messageOf(err));
    } finally {
      setBusy(false);
      void client.invalidateQueries({ queryKey: ['jannies', name] });
      void client.invalidateQueries({ queryKey: ['chat-bans', name] });
      void client.invalidateQueries({ queryKey: ['mod-log', name] });
    }
  };

  return (
    <div id="mod-tab" className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <h3 className={SECTION_TITLE}>jannies</h3>
        <p className="text-sm text-textSecondary">jannies can delete lines, time out and ban. not you, not each other.</p>
        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <JannySearch skip={skip} busy={busy} onPick={(who) => run(() => api.addStreamJanny(name, who), `${who} is a janny now`)} />
          <div className="min-w-0">
            {jannies.isError ? (
              <p className="text-sm text-decrease">{messageOf(jannies.error)}</p>
            ) : jannies.data && jannies.data.length === 0 ? (
              <p className="text-sm text-textTertiary">no jannies yet.</p>
            ) : (
              <ul id="mod-jannies" aria-label="jannies">
                {(jannies.data ?? []).map((j) => (
                  <li key={j.name} className={ROW}>
                    <Face name={j.name} version={faces.get(j.name) ?? null} className={ROW_FACE} />
                    <span className="min-w-0 flex-1 truncate font-semibold">{j.name}</span>
                    <span className="shrink-0 text-xs text-textTertiary">added {ago(j.added_at)}</span>
                    <Button
                      size="sm"
                      variant="outline-danger"
                      disabled={busy}
                      onClick={() => void run(() => api.removeStreamJanny(name, j.name), `${j.name} is not a janny any more`)}
                    >
                      remove
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
        {status && (
          <p id="mod-status" aria-live="polite" className="text-sm text-textSecondary">
            {status}
          </p>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className={SECTION_TITLE}>banned and timed out</h3>
        {bans.isError ? (
          <p className="text-sm text-decrease">{messageOf(bans.error)}</p>
        ) : bans.data && bans.data.bans.length === 0 && bans.data.timeouts.length === 0 ? (
          <p className="text-sm text-textTertiary">nobody.</p>
        ) : (
          <ul id="mod-bans" className="max-w-[520px]">
            {(bans.data?.bans ?? []).map((b) => (
              <li key={`ban-${b.name}`} className={ROW}>
                <Face name={b.name} version={faces.get(b.name) ?? null} className={ROW_FACE} />
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-semibold">{b.name}</span>
                  <span className="text-sm text-textSecondary"> banned{b.by ? ` by ${b.by}` : ''}</span>
                  {b.reason && <span className="text-sm text-textTertiary"> · {b.reason}</span>}
                </span>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => api.unbanFromChat(name, b.name), `${b.name}'s ban is lifted`)}>
                  unban
                </Button>
              </li>
            ))}
            {(bans.data?.timeouts ?? []).map((t) => (
              <li key={`timeout-${t.name}`} className={ROW}>
                <Face name={t.name} version={faces.get(t.name) ?? null} className={ROW_FACE} />
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-semibold">{t.name}</span>
                  <span className="text-sm text-textSecondary"> timed out{t.by ? ` by ${t.by}` : ''}</span>
                  <span className="text-sm text-textTertiary"> · {left(t.until)}</span>
                </span>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => api.liftChatTimeout(name, t.name), `${t.name}'s timeout is lifted`)}>
                  lift
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className={SECTION_TITLE}>mod log</h3>
        <div id="mod-log-filters" role="group" aria-label="show" className="flex gap-2 overflow-x-auto">
          {FILTERS.map(({ word }) => (
            <Button
              key={word}
              size="sm"
              data-filter={word}
              aria-pressed={filter === word}
              onClick={() => setFilter(word)}
              className={cn('shrink-0', filter === word && 'border-primaryBlue text-primaryBlue')}
            >
              {word}
            </Button>
          ))}
        </div>
        {log.isError ? (
          <p className="text-sm text-decrease">{messageOf(log.error)}</p>
        ) : log.data && rows.length === 0 ? (
          <p className="text-sm text-textTertiary">nothing yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table id="mod-log" className="w-full min-w-[560px] table-fixed border-collapse text-sm">
              <colgroup>
                <col className="w-[76px]" />
                <col className="w-[120px]" />
                <col className="w-[96px]" />
                <col className="w-[120px]" />
                <col />
              </colgroup>
              <thead>
                <tr className="border-b border-primaryStroke text-left text-xs text-textTertiary">
                  <th className="py-1 pr-3 font-normal">when</th>
                  <th className="py-1 pr-3 font-normal">who</th>
                  <th className="py-1 pr-3 font-normal">action</th>
                  <th className="py-1 pr-3 font-normal">target</th>
                  <th className="py-1 font-normal">detail</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => {
                  const detail = detailOf(row);
                  return (
                    <tr key={`${row.at}-${i}`} data-action={row.action} className="border-b border-primaryStroke last:border-b-0">
                      <td className="py-1 pr-3 text-textTertiary">
                        <Tooltip content={new Date(row.at).toLocaleString()}>
                          <span tabIndex={0} className="outline-none focus-visible:text-primaryBlue">
                            {ago(row.at)}
                          </span>
                        </Tooltip>
                      </td>
                      <td className="truncate py-1 pr-3 font-semibold">{row.actor}</td>
                      <td className="py-1 pr-3">
                        <span className={cn('inline-block border px-1.5 text-xs leading-5', chipColor(row.action))}>{row.action}</span>
                      </td>
                      <td className="truncate py-1 pr-3">{row.target}</td>
                      <td className="py-1 text-textSecondary">
                        {detail && (
                          <Tooltip content={detail}>
                            <span tabIndex={0} className="block truncate outline-none focus-visible:text-primaryBlue">
                              {detail}
                            </span>
                          </Tooltip>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
