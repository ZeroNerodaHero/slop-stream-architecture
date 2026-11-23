import { RiIndeterminateCircleLine, RiSearchLine } from '@remixicon/react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react';

import { type ModLogRow, type SearchHit, api, messageOf } from '@/infra/api';
import { PRESENCE_WORD } from '@/infra/atoms/presence-atoms';
import { loadMyProfile } from '@/infra/atoms/profile-atoms';
import { usePeopleSearch } from '@/infra/people-search';
import { Button } from '@/shared-components/Button';
import { Face } from '@/shared-components/Face';
import { Who } from '@/shared-components/PersonRow';
import { PresenceSquare } from '@/shared-components/PresenceSquare';
import { Tooltip } from '@/shared-components/Tooltip';
import { INPUT } from '@/shared-components/input';
import { WELCOME_TIP, WelcomeEditor } from '@/shared-components/WelcomeEditor';
import { Info } from '@/shared-components/user-modal/parts';
import { cn } from '@/utils/cn';

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

/** The log's filters: which actions each shows. `all` shows every one, `active` what still stands (`standing`). */
const FILTERS = [
  { word: 'all', actions: null },
  { word: 'active', actions: null },
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
    // the list opens over the jannies under the box
    <div className="relative min-w-0">
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
          className={cn(INPUT, 'h-9 pl-10 pr-3 text-sm max-md:h-11 max-md:pl-12')}
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

/** What the ⓘ beside each card's title says: the lines that used to sit under the titles. */
const JANNIES_TIP = 'jannies can delete lines, time out and ban. not you, not each other';
const BANS_TIP = 'who cannot talk in your chat. a ban lasts until you lift it, a timeout ends on its own';
const LOG_TIP = 'what you and your jannies did in your chat, newest first';

/** One card of the tab: a stroke, the lifted fill, the small title with its ⓘ, a count at the right. */
function Card({ id, title, tip, count, children }: { id?: string; title: string; tip: string; count?: number; children: ReactNode }) {
  return (
    <section id={id} className="flex min-w-0 flex-col gap-3 border border-primaryStroke bg-backgroundSecondary p-3 md:p-4">
      <div className="flex items-center gap-1.5">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-textSecondary">{title}</h3>
        <Info tip={tip} />
        {count !== undefined && <span className="ml-auto text-sm tabular-nums text-textTertiary">{count}</span>}
      </div>
      {children}
    </section>
  );
}

/**
 * A row of the jannies or the banned: the face, the name, what it is, the one button. The name and
 * what it is share a line; on a phone the name sits over it. Both truncate, the button never shrinks.
 */
const ROW = 'flex items-center gap-2 border-b border-primaryStroke px-3 py-1.5 last:border-b-0 max-md:min-h-[52px] max-md:py-2';
const ROW_FACE = 'h-6 w-6 shrink-0 text-[10px]';
const ROW_TEXT = 'flex min-w-0 flex-1 items-center gap-2 max-md:flex-col max-md:items-stretch max-md:gap-0';
const ROW_NAME = 'min-w-0 truncate text-sm font-semibold';
const ROW_WHAT = 'min-w-0 flex-1 truncate text-sm text-textSecondary max-md:text-[13px]';
const ROWS = 'border border-primaryStroke bg-background';

/** My chat welcome, the profile tab's editor (WelcomeEditor.tsx): the same atoms, so a save in one shows in the other. */
function WelcomeSection() {
  // Mount only: my welcome as the api has it (the same name again keeps the draft).
  useEffect(() => {
    void loadMyProfile();
  }, []);

  return (
    <Card id="mod-welcome" title="welcome message" tip={WELCOME_TIP}>
      <div className="min-w-0">
        <WelcomeEditor id="mod-welcome" />
      </div>
    </Card>
  );
}

/**
 * The log rows whose doing still stands: the newest ban of someone still banned, the newest
 * timeout of someone still timed out, the newest add of someone still a janny.
 */
function standing(rows: ModLogRow[], banned: Set<string>, timedOut: Set<string>, jannies: Set<string>): Set<ModLogRow> {
  const newest = new Map<string, ModLogRow>();
  for (const row of rows) {
    const still =
      (row.action === 'ban' && banned.has(row.target)) || (row.action === 'timeout' && timedOut.has(row.target)) || (row.action === 'janny' && jannies.has(row.target));
    if (!still) continue;
    const key = `${row.action}:${row.target}`;
    const had = newest.get(key);
    if (!had || new Date(row.at).getTime() > new Date(had.at).getTime()) newest.set(key, row);
  }
  return new Set(newest.values());
}

/** A log row's time: "2d ago", the full date and time on hover and focus. */
function When({ at }: { at: string }) {
  return (
    <Tooltip content={new Date(at).toLocaleString()}>
      <span tabIndex={0} className="outline-none focus-visible:text-primaryBlue">
        {ago(at)}
      </span>
    </Tooltip>
  );
}

/** A log row's action, in its colour. */
function Chip({ action }: { action: string }) {
  return <span className={cn('inline-block shrink-0 border px-1.5 text-xs leading-5', chipColor(action))}>{action}</span>;
}

/** A log row's detail, the whole of it on hover and focus; `—` for none. */
function Detail({ text }: { text: string }) {
  if (!text) return <span>—</span>;
  return (
    <Tooltip content={text}>
      <span tabIndex={0} className="block truncate outline-none focus-visible:text-primaryBlue">
        {text}
      </span>
    </Tooltip>
  );
}

/**
 * The mod tab, on my own page only (docs/jannies.md): my stream's jannies (found by name and
 * added in one pick, removed from the list under the box), who is banned or timed out of my chat
 * (lift either), and the log of what was done in it, filtered by kind or to what still stands. A
 * janny deletes, bans and times out from the chat's lines; this is where the streamer keeps the
 * list. Beside them, what Eques says to each viewer who opens my chat. Two columns from md, one
 * card under another on a phone.
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
  const banCount = bans.data ? bans.data.bans.length + bans.data.timeouts.length : undefined;
  const live =
    filter === 'active'
      ? standing(
          log.data ?? [],
          new Set((bans.data?.bans ?? []).map((b) => b.name)),
          new Set((bans.data?.timeouts ?? []).map((t) => t.name)),
          new Set((jannies.data ?? []).map((j) => j.name))
        )
      : null;
  const actions = FILTERS.find((f) => f.word === filter)?.actions ?? null;
  const rows = (log.data ?? []).filter((row) => (live ? live.has(row) : !actions || (actions as readonly string[]).includes(row.action)));

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

  const chip = (word: Filter) => (
    <Button
      key={word}
      size="sm"
      data-filter={word}
      aria-pressed={filter === word}
      onClick={() => setFilter(word)}
      className={cn('shrink-0', word === 'deletes' && 'ml-auto', filter === word && 'border-primaryBlue bg-primaryBlue/10 text-primaryBlue')}
    >
      {word}
    </Button>
  );

  return (
    <div id="mod-tab" className="flex flex-col gap-4">
      <div className="grid grid-cols-1 items-stretch gap-4 md:grid-cols-2">
        <WelcomeSection />

        <div className="flex min-w-0 flex-col gap-4">
          <Card id="mod-jannies-card" title="jannies" tip={JANNIES_TIP} count={jannies.data?.length}>
            <JannySearch skip={skip} busy={busy} onPick={(who) => run(() => api.addStreamJanny(name, who), `${who} is a janny now`)} />
            {jannies.isError ? (
              <p className="text-sm text-decrease">{messageOf(jannies.error)}</p>
            ) : jannies.data && jannies.data.length === 0 ? (
              <p className="text-sm text-textTertiary">no jannies yet.</p>
            ) : (
              <ul id="mod-jannies" aria-label="jannies" className={cn(ROWS, !jannies.data && 'hidden')}>
                {(jannies.data ?? []).map((j) => (
                  <li key={j.name} className={ROW}>
                    <Face name={j.name} version={faces.get(j.name) ?? null} className={ROW_FACE} />
                    <div className={ROW_TEXT}>
                      <span className={ROW_NAME}>{j.name}</span>
                      <span className={ROW_WHAT}>added {ago(j.added_at)}</span>
                    </div>
                    <Button
                      size="sm"
                      variant="outline-danger"
                      disabled={busy}
                      onClick={() => void run(() => api.removeStreamJanny(name, j.name), `${j.name} is not a janny any more`)}
                      className="shrink-0"
                    >
                      remove
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card id="mod-bans-card" title="banned and timed out" tip={BANS_TIP} count={banCount}>
            {bans.isError ? (
              <p className="text-sm text-decrease">{messageOf(bans.error)}</p>
            ) : banCount === 0 ? (
              <p id="mod-bans-none" className="flex items-center justify-center gap-2 border border-dashed border-primaryStroke px-3 py-6 text-sm text-textSecondary">
                <RiIndeterminateCircleLine aria-hidden size={16} className="shrink-0 text-textTertiary" />
                no bans or timeouts
              </p>
            ) : (
              <ul id="mod-bans" aria-label="banned and timed out" className={cn(ROWS, !bans.data && 'hidden')}>
                {(bans.data?.bans ?? []).map((b) => (
                  <li key={`ban-${b.name}`} className={ROW}>
                    <Face name={b.name} version={faces.get(b.name) ?? null} className={ROW_FACE} />
                    <div className={ROW_TEXT}>
                      <span className={ROW_NAME}>{b.name}</span>
                      <span className={ROW_WHAT}>
                        banned{b.by ? ` by ${b.by}` : ''}
                        {b.reason && <span className="text-textTertiary"> · {b.reason}</span>}
                      </span>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void run(() => api.unbanFromChat(name, b.name), `${b.name}'s ban is lifted`)}
                      className="shrink-0"
                    >
                      unban
                    </Button>
                  </li>
                ))}
                {(bans.data?.timeouts ?? []).map((t) => (
                  <li key={`timeout-${t.name}`} className={ROW}>
                    <Face name={t.name} version={faces.get(t.name) ?? null} className={ROW_FACE} />
                    <div className={ROW_TEXT}>
                      <span className={ROW_NAME}>{t.name}</span>
                      <span className={ROW_WHAT}>
                        timed out{t.by ? ` by ${t.by}` : ''} · {left(t.until)}
                      </span>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void run(() => api.liftChatTimeout(name, t.name), `${t.name}'s timeout is lifted`)}
                      className="shrink-0"
                    >
                      untimeout
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>

      {status && (
        <p id="mod-status" aria-live="polite" className="text-sm text-textSecondary">
          {status}
        </p>
      )}

      <Card id="mod-log-card" title="mod log" tip={LOG_TIP} count={log.data ? rows.length : undefined}>
        {/* one row: all and active at the left, the kinds at the right; on a phone it scrolls sideways */}
        <div id="mod-log-filters" role="group" aria-label="show" className="flex flex-nowrap gap-2 overflow-x-auto">
          {FILTERS.map(({ word }) => chip(word))}
        </div>
        {log.isError ? (
          <p className="text-sm text-decrease">{messageOf(log.error)}</p>
        ) : log.data && rows.length === 0 ? (
          <p className="text-sm text-textTertiary">nothing yet.</p>
        ) : (
          <div className={cn(ROWS, !log.data && 'hidden')}>
            <table id="mod-log" className="w-full table-fixed border-collapse text-sm max-md:hidden">
              <colgroup>
                <col className="w-[96px]" />
                <col className="w-[22%]" />
                <col className="w-[120px]" />
                <col className="w-[22%]" />
                <col />
              </colgroup>
              <thead>
                <tr className="border-b border-primaryStroke text-left text-xs uppercase tracking-wide text-textSecondary">
                  <th className="px-3 py-2 font-semibold">when</th>
                  <th className="py-2 pr-3 font-semibold">who</th>
                  <th className="py-2 pr-3 font-semibold">action</th>
                  <th className="py-2 pr-3 font-semibold">target</th>
                  <th className="py-2 pr-3 font-semibold">detail</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={`${row.at}-${i}`} data-action={row.action} className="border-b border-primaryStroke last:border-b-0">
                    <td className="px-3 py-2 text-textTertiary">
                      <When at={row.at} />
                    </td>
                    <td className="truncate py-2 pr-3">{row.actor}</td>
                    <td className="py-2 pr-3">
                      <Chip action={row.action} />
                    </td>
                    <td className="truncate py-2 pr-3">{row.target}</td>
                    <td className="py-2 pr-3 text-textSecondary">
                      <Detail text={detailOf(row)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {/* a phone: each row two lines, who and what and when, then to whom and the detail on one line that ends in … when it runs long */}
            <ul id="mod-log-rows" aria-label="mod log" className="md:hidden">
              {rows.map((row, i) => (
                <li key={`${row.at}-${i}`} data-action={row.action} className="flex flex-col gap-0.5 border-b border-primaryStroke px-3 py-2 text-sm last:border-b-0">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 truncate font-semibold">{row.actor}</span>
                    <Chip action={row.action} />
                    <span className="ml-auto shrink-0 text-xs text-textTertiary">
                      <When at={row.at} />
                    </span>
                  </div>
                  <p className="truncate text-textSecondary">
                    {row.target}
                    {detailOf(row) && ` · ${detailOf(row)}`}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>
    </div>
  );
}
