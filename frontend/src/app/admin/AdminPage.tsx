import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';

import { type ClientError, type Health, api, messageOf, statusOf } from '@/infra/api';
import { PageFrame } from '@/shared-components/PageFrame';
import { cn } from '@/utils/cn';

const POLL_MS = 10_000;
const KINDS = ['all', 'crash', 'error', 'rejection', 'soft', 'api'] as const;
/** Answers that do not change by asking again every 10s: not an admin, no admin, no debug database. */
const STOP_POLLING = [401, 404, 503];
/** Not an admin (or no admin here): no reason to poll the health either. */
const STRANGER = [401, 404];

const KIND_TONE: Record<string, string> = {
  crash: 'border-decrease text-decrease',
  error: 'border-decrease text-decrease',
  rejection: 'border-decrease text-decrease',
  soft: 'border-primaryBlue text-primaryBlue',
  api: 'border-secondaryStroke text-textSecondary'
};

/** How long before `now` (the time the list was fetched): "now", "4m", "3h", "2d". */
function ago(iso: string, now: number): string {
  const secs = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (secs < 60) return 'now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}

/** "3d 4h", "2h 05m", "12m", "40s". */
function up(secs: number | null | undefined): string {
  if (secs === null || secs === undefined) return '—';
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m`;
  return `${secs}s`;
}

function Flag({ on, label }: { on: boolean; label: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1', on ? 'text-increase' : 'text-decrease')}>
      <span aria-hidden>{on ? '✓' : '✗'}</span>
      {label}
    </span>
  );
}

/** This box, from its own /api/health. */
function HealthCard({ health, error }: { health: Health | undefined; error: unknown }) {
  if (error) {
    return (
      <p id="admin-health" className="text-decrease">
        /api/health does not answer: {messageOf(error)}
      </p>
    );
  }
  if (!health)
    return (
      <p id="admin-health" className="text-textSecondary">
        loading
      </p>
    );
  return (
    <section id="admin-health" className="flex flex-wrap items-center gap-x-5 gap-y-2 border border-primaryStroke bg-backgroundSecondary px-5 py-4 shadow-hard">
      <span className="text-xl font-semibold">{health.env}</span>
      <span className="font-mono text-textSecondary" title="the commit the api was built from">
        {health.build}
      </span>
      <Flag on={health.postgres} label="postgres" />
      <Flag on={health.redis} label="redis" />
      <Flag on={health.debug_db} label="debug db" />
      <Flag on={health.video} label="video" />
      <span className="text-textSecondary">
        live <span className="font-semibold text-textPrimary">{health.live ?? '—'}</span>
      </span>
      <span className="text-textSecondary" title="since the api process started. it going backwards means a restart">
        api up {up(health.up_secs)}
      </span>
      <span className="text-textSecondary" title="since the video process started">
        video up {up(health.video_up_secs)}
        {health.video_build && health.video_build !== health.build && <span className="ml-1 font-mono">({health.video_build})</span>}
      </span>
      {health.errors_dropped > 0 && (
        <span className="text-decrease" title="reports over the rate limit in the current 10 minute window. a page in a loop, or a flood">
          {health.errors_dropped} dropped this window
        </span>
      )}
    </section>
  );
}

function Row({ e, now }: { e: ClientError; now: number }) {
  const [open, setOpen] = useState(false);
  const extra = e.extra && Object.keys(e.extra).length ? e.extra : null;
  const when = new Date(e.at);
  return (
    <li className="border-b border-primaryStroke py-2 last:border-b-0">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full flex-wrap items-baseline gap-x-3 gap-y-1 text-left">
        <span className="w-[72px] shrink-0 text-sm text-textTertiary" title={when.toLocaleString()}>
          {ago(e.at, now)}
        </span>
        <span className={cn('border px-2 py-0.5 text-xs font-medium uppercase tracking-wide', KIND_TONE[e.kind] ?? 'border-secondaryStroke text-textSecondary')}>
          {e.kind}
        </span>
        <span className="font-mono text-sm text-textSecondary">{e.page}</span>
        <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{e.message}</span>
        {e.me && <span className="text-sm text-textTertiary">{e.me}</span>}
      </button>
      {open && (
        <div className="mt-2 space-y-2 pl-[84px] text-sm">
          <p className="text-textTertiary">
            {when.toLocaleString()} · {e.ip ?? '?'} · build {e.build ?? '?'}
            {e.stream && <> · stream {e.stream}</>}
            {e.phase && <> · phase {e.phase}</>}
          </p>
          {extra && (
            <dl className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-textSecondary">
              {Object.entries(extra).map(([k, v]) => (
                <div key={k} className="inline">
                  <dt className="inline text-textTertiary">{k}=</dt>
                  <dd className="inline">{String(v)}</dd>
                </div>
              ))}
            </dl>
          )}
          {e.stack && (
            <pre className="max-h-[320px] overflow-auto whitespace-pre-wrap border border-primaryStroke bg-backgroundTertiary p-3 font-mono text-xs text-textSecondary">
              {e.stack}
            </pre>
          )}
          {e.ua && <p className="text-textTertiary [overflow-wrap:anywhere]">{e.ua}</p>}
        </div>
      )}
    </li>
  );
}

function notice(err: unknown): string {
  switch (statusOf(err)) {
    case 401:
      return 'admins only. log in as a name in ADMIN_NAMES.';
    case 404:
      return 'this box has no admin. put ADMIN_NAMES=yourname in .env, then ./deploy.sh api.';
    case 503:
      return 'the api has no debug database right now. see docker compose logs api.';
    default:
      return `cannot load the errors: ${messageOf(err)}`;
  }
}

/**
 * /admin: this droplet's health and the failures its pages reported. For a login in
 * ADMIN_NAMES; everyone else gets told why not. See docs/debugging.md.
 */
export function AdminPage() {
  const [kind, setKind] = useState<(typeof KINDS)[number]>('all');
  const [pageFilter, setPageFilter] = useState('');
  const errors = useQuery({
    queryKey: ['errors', kind],
    queryFn: () => api.errors(kind === 'all' ? undefined : kind),
    // a 401, 404 or 503 does not change by asking again every 10s. a focus or a reload asks again
    refetchInterval: (q) => (STOP_POLLING.includes(statusOf(q.state.error) ?? 0) ? false : POLL_MS),
    retry: false
  });
  const stranger = STRANGER.includes(statusOf(errors.error) ?? 0);
  const polling = !STOP_POLLING.includes(statusOf(errors.error) ?? 0);
  const health = useQuery({ queryKey: ['health'], queryFn: api.health, refetchInterval: () => (stranger ? false : POLL_MS), retry: false });
  const rows = (errors.data ?? []).filter((e) => !pageFilter || e.page.includes(pageFilter));

  return (
    <PageFrame title="admin" aside={<Link to="/">home</Link>} wide>
      <HealthCard health={health.data} error={health.error} />

      <div className="mb-3 mt-6 flex flex-wrap items-center gap-3">
        <h2 className="text-xl font-semibold">errors from the pages</h2>
        <div className="flex flex-wrap gap-1">
          {KINDS.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              className={cn(
                'border px-3 py-1 text-sm',
                k === kind ? 'border-primaryBlue text-primaryBlue' : 'border-primaryStroke text-textSecondary hover:text-textPrimary'
              )}
            >
              {k}
            </button>
          ))}
        </div>
        <input
          id="admin-page-filter"
          value={pageFilter}
          onChange={(e) => setPageFilter(e.target.value)}
          placeholder="page contains…"
          autoComplete="off"
          spellCheck={false}
          className="w-[200px] border border-primaryStroke bg-backgroundSecondary px-3 py-1.5 text-sm text-textPrimary"
        />
        <span className="text-sm text-textTertiary">
          {[errors.data && `${rows.length} of the last ${errors.data.length}`, polling ? `refreshes every ${POLL_MS / 1000}s` : 'reload to ask again', 'kept 14 days']
            .filter(Boolean)
            .join(' · ')}
        </span>
      </div>

      {errors.isError ? (
        <p id="admin-notice" className="text-textSecondary" aria-live="polite">
          {notice(errors.error)}
          {errors.data ? ` · the list below is as of ${new Date(errors.dataUpdatedAt).toLocaleTimeString()}` : null}
        </p>
      ) : errors.data && rows.length === 0 ? (
        <p id="admin-notice" className="text-textSecondary">
          nothing. either it all works or nobody is here.
        </p>
      ) : null}
      {rows.length > 0 && (
        <ul id="admin-errors" className="border border-primaryStroke bg-backgroundSecondary px-4 shadow-hard">
          {rows.map((e) => (
            <Row key={e.id} e={e} now={errors.dataUpdatedAt} />
          ))}
        </ul>
      )}
    </PageFrame>
  );
}
