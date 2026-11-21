import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';

import { type ModLogRow, api, messageOf } from '@/infra/api';
import { Button } from '@/shared-components/Button';
import { INPUT } from '@/shared-components/input';
import { SECTION_TITLE } from '@/shared-components/user-modal/parts';
import { cn } from '@/utils/cn';

const ROW = 'flex items-center gap-3 border-b border-primaryStroke py-1.5 last:border-b-0';

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

/** One log row's words: who did what to whom, and a deleted line's words. */
function logWords(row: ModLogRow): string {
  switch (row.action) {
    case 'delete': {
      const text = row.snapshot?.text?.trim();
      const pics = row.snapshot?.images?.length ?? 0;
      return `deleted ${row.target}'s line${text ? `: “${text.length > 80 ? `${text.slice(0, 80)}…` : text}”` : pics ? ` (${pics} picture${pics > 1 ? 's' : ''})` : ''}`;
    }
    case 'ban':
      return `banned ${row.target}${row.snapshot?.reason ? ` (${row.snapshot.reason})` : ''}`;
    case 'unban':
      return `lifted ${row.target}'s ban`;
    case 'timeout':
      return `timed out ${row.target}${row.snapshot?.seconds ? ` for ${Math.round(row.snapshot.seconds / 60)}m` : ''}`;
    case 'untimeout':
      return `lifted ${row.target}'s timeout`;
    case 'janny':
      return `made ${row.target} a janny`;
    case 'unjanny':
      return `took ${row.target}'s janny away`;
    default:
      return `${row.action} ${row.target}`;
  }
}

/**
 * The mod tab, on my own page only (docs/jannies.md): my stream's jannies (add by name, remove),
 * who is banned or timed out of my chat (lift either), and the last things done in it. A janny
 * deletes, bans and times out from the chat's lines; this is where the streamer keeps the list.
 */
export function ModTab({ name }: { name: string }) {
  const client = useQueryClient();
  const jannies = useQuery({ queryKey: ['jannies', name], queryFn: () => api.streamJannies(name), retry: false });
  const bans = useQuery({ queryKey: ['chat-bans', name], queryFn: () => api.chatBans(name), retry: false });
  const log = useQuery({ queryKey: ['mod-log', name], queryFn: () => api.modLog(name), retry: false });
  const [adding, setAdding] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

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

  const add = (e: FormEvent) => {
    e.preventDefault();
    const who = adding.trim().toLowerCase();
    if (!who) return;
    void run(() => api.addStreamJanny(name, who), `${who} is a janny now`).then(() => setAdding(''));
  };

  return (
    <div id="mod-tab" className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <h3 className={SECTION_TITLE}>jannies</h3>
        <p className="text-sm text-textSecondary">jannies can delete lines in your chat, and time out or ban people from it. not you, and not each other.</p>
        <form onSubmit={add} className="flex max-w-[420px] gap-2">
          <input
            id="mod-janny-name"
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
            placeholder="their name"
            aria-label="add a janny by name"
            maxLength={32}
            autoComplete="off"
            spellCheck={false}
            className={cn(INPUT, 'min-w-0 flex-1')}
          />
          <Button id="mod-janny-add" type="submit" variant="primary" size="sm" disabled={busy || !adding.trim()}>
            add
          </Button>
        </form>
        {status && (
          <p id="mod-status" aria-live="polite" className="text-sm text-textSecondary">
            {status}
          </p>
        )}
        {jannies.isError ? (
          <p className="text-sm text-decrease">{messageOf(jannies.error)}</p>
        ) : jannies.data && jannies.data.length === 0 ? (
          <p className="text-sm text-textTertiary">no jannies yet.</p>
        ) : (
          <ul id="mod-jannies" className="max-w-[420px]">
            {(jannies.data ?? []).map((j) => (
              <li key={j.name} className={ROW}>
                <span className="min-w-0 flex-1 truncate font-semibold">{j.name}</span>
                <span className="text-xs text-textTertiary">{ago(j.added_at)}</span>
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
        {log.isError ? (
          <p className="text-sm text-decrease">{messageOf(log.error)}</p>
        ) : log.data && log.data.length === 0 ? (
          <p className="text-sm text-textTertiary">nothing yet.</p>
        ) : (
          <ul id="mod-log">
            {(log.data ?? []).map((row, i) => (
              <li key={`${row.at}-${i}`} className={cn(ROW, 'text-sm')}>
                <span className="w-[72px] shrink-0 text-textTertiary" title={new Date(row.at).toLocaleString()}>
                  {ago(row.at)}
                </span>
                <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                  <span className="font-semibold">{row.actor}</span> {logWords(row)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
