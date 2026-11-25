import { useAtomValue } from 'jotai';
import { type PointerEvent, useEffect, useId, useState } from 'react';

import { api, messageOf, type Stats, type StatsDays, type StreamDetail, type StreamStatsRow } from '@/infra/api';
import { meAtom } from '@/infra/atoms/auth-atoms';
import { pickTab } from '@/infra/atoms/user-modal-atoms';
import { Button } from '@/shared-components/Button';
import { Bone, Skeleton } from '@/shared-components/Skeleton';
import { Block, Status } from '@/shared-components/user-modal/parts';
import { cn } from '@/utils/cn';

const RANGES: readonly StatsDays[] = [7, 30];
const CHIP_ON = 'border-primaryBlue text-primaryBlue';
const TILES = 'grid grid-cols-2 gap-2 md:grid-cols-4';

export function lengthWords(secs: number): string {
  const s = Math.max(0, Math.round(secs));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

function watchWords(secs: number): string {
  return secs >= 3600 ? `${(secs / 3600).toFixed(1)}h` : `${Math.round(secs / 60)}m`;
}

function avgWords(avg: number | null): string {
  return avg === null ? '–' : avg.toFixed(1);
}

function dayWords(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function StatsTab() {
  const me = useAtomValue(meAtom);
  if (!me)
    return (
      <div className="divide-y divide-primaryStroke">
        <Block title="your stream stats">
          <p id="stats-need-account" className="mb-3 text-textSecondary">
            stats are kept for accounts only. make an account to see your viewers over time, peak and average viewers, watch time and new follows for every stream.
          </p>
          <Button id="stats-sign-up" size="sm" variant="outline" onClick={() => pickTab('security')}>
            create account
          </Button>
        </Block>
      </div>
    );
  return <MyStats />;
}

function MyStats() {
  const [days, setDays] = useState<StatsDays>(7);
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState('');
  const [picked, setPicked] = useState<number | null>(null);
  const [detail, setDetail] = useState<StreamDetail | null>(null);

  useEffect(() => {
    let on = true;
    api
      .stats(days)
      .then((s) => on && setStats(s))
      .catch((e: unknown) => on && setError(`not loaded: ${messageOf(e)}`));
    return () => {
      on = false;
    };
  }, [days]);

  const wantDetail = picked !== null && picked !== stats?.last?.id;
  useEffect(() => {
    if (!wantDetail || picked === null) return;
    let on = true;
    api
      .statsStream(picked)
      .then((d) => on && setDetail(d))
      .catch((e: unknown) => on && setError(`not loaded: ${messageOf(e)}`));
    return () => {
      on = false;
    };
  }, [wantDetail, picked]);

  const shown = wantDetail ? (detail?.id === picked ? detail : null) : (stats?.last ?? null);

  function pickDays(d: StatsDays) {
    setError('');
    setDays(d);
  }

  return (
    <div className="divide-y divide-primaryStroke">
      <Block title="range" tip="every stream started in the range, together. follows count every follow in the range, live or not.">
        <div role="group" aria-label="range" className="mb-3 flex gap-2">
          {RANGES.map((d) => (
            <Button key={d} id={`stats-days-${d}`} size="sm" aria-pressed={days === d} onClick={() => pickDays(d)} className={cn(days === d && CHIP_ON)}>
              {d} days
            </Button>
          ))}
        </div>
        {stats ? (
          <div id="stats-summary" className={TILES}>
            <Tile label="streams" value={String(stats.summary.streams)} />
            <Tile label="live for" value={lengthWords(stats.summary.live_secs)} />
            <Tile label="avg viewers" value={avgWords(stats.summary.avg_viewers)} />
            <Tile label="peak viewers" value={String(stats.summary.peak_viewers)} />
            <Tile label="watch time" value={watchWords(stats.summary.watch_secs)} />
            <Tile label="unique viewers" value={String(stats.summary.unique_viewers)} />
            <Tile label="new follows" value={String(stats.summary.new_follows)} />
          </div>
        ) : (
          !error && (
            <Skeleton id="stats-loading" className={TILES}>
              {Array.from({ length: 7 }, (_, i) => (
                <Bone key={i} className="h-16" />
              ))}
            </Skeleton>
          )
        )}
        <Status id="stats-status" text={error} quiet />
      </Block>

      {stats && !stats.last && (
        <Block title="streams">
          <p id="stats-empty" className="rounded-card border border-dashed border-secondaryStroke px-4 py-8 text-center text-sm text-textTertiary">
            no streams yet. go live with this account and its numbers show up here.
          </p>
        </Block>
      )}

      {shown && <StreamBlock stream={shown} last={shown.id === stats?.last?.id} />}

      {stats && stats.last && (
        <Block title={`streams, last ${days} days`}>
          {stats.streams.length === 0 ? (
            <p className="text-sm text-textTertiary">none in this range. the graph above is your last stream.</p>
          ) : (
            <ul id="stats-streams" className="flex flex-col gap-1">
              {stats.streams.map((row) => (
                <StreamRow key={row.id} row={row} on={row.id === (shown?.id ?? null)} onPick={() => setPicked(row.id)} />
              ))}
            </ul>
          )}
        </Block>
      )}
    </div>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-card border border-primaryStroke bg-background px-3 py-2">
      <span className="text-xs font-semibold uppercase tracking-wider text-textTertiary">{label}</span>
      <span className="text-xl font-semibold tabular-nums leading-tight text-textPrimary">{value}</span>
    </div>
  );
}

function StreamBlock({ stream, last }: { stream: StreamDetail; last: boolean }) {
  return (
    <Block title={stream.live ? 'this stream, live now' : last ? 'last stream' : 'stream'}>
      <p id="stats-stream-when" className="mb-2 text-sm text-textSecondary">
        {dayWords(stream.started_at)} · {lengthWords(stream.duration_secs)}
      </p>
      <ViewerGraph points={stream.points} />
      <div id="stats-stream-tiles" className={cn(TILES, 'mt-3')}>
        <Tile label="peak viewers" value={String(stream.peak_viewers)} />
        <Tile label="avg viewers" value={avgWords(stream.avg_viewers)} />
        <Tile label="duration" value={lengthWords(stream.duration_secs)} />
        <Tile label="watch time" value={watchWords(stream.watch_secs)} />
        <Tile label="unique viewers" value={String(stream.unique_viewers)} />
        <Tile label="new follows" value={String(stream.new_follows)} />
        <Tile label="chat messages" value={String(stream.chat_messages)} />
        <Tile label="chatters" value={String(stream.chatters)} />
      </div>
      <p className="mt-2 text-xs text-textTertiary">
        unique viewers: {stream.account_viewers} logged in, {stream.anon_viewers} without an account.
      </p>
    </Block>
  );
}

function StreamRow({ row, on, onPick }: { row: StreamStatsRow; on: boolean; onPick: () => void }) {
  return (
    <li>
      <button
        id={`stats-stream-${row.id}`}
        type="button"
        aria-pressed={on}
        onClick={onPick}
        className={cn(
          'flex w-full items-center gap-3 rounded-card border px-3 py-2 text-left text-sm transition-colors duration-150 max-md:min-h-11',
          'focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-primaryBlue',
          on ? 'border-primaryBlue bg-primaryBlue/5' : 'border-primaryStroke hover:border-secondaryStroke hover:bg-backgroundTertiary'
        )}
      >
        <span className={cn('min-w-0 flex-1 truncate font-semibold', on ? 'text-primaryBlue' : 'text-textPrimary')}>
          {dayWords(row.started_at)}
          {row.live && <span className="ml-2 text-xs uppercase tracking-wider text-decrease">live</span>}
        </span>
        <span className="shrink-0 tabular-nums text-textSecondary">{lengthWords(row.duration_secs)}</span>
        <span className="w-20 shrink-0 text-right tabular-nums text-textSecondary max-sm:hidden">peak {row.peak_viewers}</span>
        <span className="w-20 shrink-0 text-right tabular-nums text-textSecondary">avg {avgWords(row.avg_viewers)}</span>
      </button>
    </li>
  );
}

const W = 600;
const H = 180;
const PAD = { left: 32, right: 8, top: 8, bottom: 22 };

function niceMax(max: number): { top: number; step: number } {
  const raw = Math.max(1, max) / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? mag * 10;
  return { top: Math.max(step, Math.ceil(Math.max(1, max) / step) * step), step: Math.max(1, Math.round(step)) };
}

export function ViewerGraph({ points }: { points: [number, number][] }) {
  const [at, setAt] = useState<number | null>(null);
  const titleId = useId();
  if (points.length === 0)
    return (
      <p id="stats-graph-empty" className="rounded-card border border-dashed border-secondaryStroke px-4 py-8 text-center text-sm text-textTertiary">
        no samples yet: the count is written once a minute while you are live.
      </p>
    );
  const t0 = points[0]![0];
  const t1 = Math.max(points[points.length - 1]![0], t0 + 60_000);
  const { top, step } = niceMax(Math.max(...points.map((p) => p[1])));
  const x = (t: number) => PAD.left + ((t - t0) / (t1 - t0)) * (W - PAD.left - PAD.right);
  const y = (v: number) => PAD.top + (1 - v / top) * (H - PAD.top - PAD.bottom);
  const line = points.map(([t, v], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const ticks: number[] = [];
  for (let v = 0; v <= top; v += step) ticks.push(v);
  const hovered = at === null ? null : points[at];

  function move(e: PointerEvent<SVGSVGElement>) {
    const box = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    let best = 0;
    for (let i = 1; i < points.length; i++) if (Math.abs(x(points[i]![0]) - px) < Math.abs(x(points[best]![0]) - px)) best = i;
    setAt(best);
  }

  return (
    <figure id="stats-graph" className="relative m-0 rounded-card border border-primaryStroke bg-background p-2">
      <figcaption id={titleId} className="sr-only">
        viewers over time
      </figcaption>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="block h-auto w-full touch-none select-none"
        role="img"
        aria-labelledby={titleId}
        onPointerMove={move}
        onPointerDown={move}
        onPointerLeave={() => setAt(null)}
      >
        {ticks.map((v) => (
          <g key={v}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} className="stroke-primaryStroke" strokeWidth={1} />
            <text x={PAD.left - 6} y={y(v) + 4} textAnchor="end" className="fill-textTertiary text-[11px] tabular-nums">
              {v}
            </text>
          </g>
        ))}
        <text x={PAD.left} y={H - 6} className="fill-textTertiary text-[11px]">
          {clock(t0)}
        </text>
        <text x={W - PAD.right} y={H - 6} textAnchor="end" className="fill-textTertiary text-[11px]">
          {clock(t1)}
        </text>
        {points.length === 1 ? (
          <circle cx={x(t0)} cy={y(points[0]![1])} r={4} className="fill-primaryBlue" />
        ) : (
          <path d={line} fill="none" className="stroke-primaryBlue" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        )}
        {hovered && (
          <g>
            <line x1={x(hovered[0])} x2={x(hovered[0])} y1={PAD.top} y2={H - PAD.bottom} className="stroke-textTertiary" strokeWidth={1} strokeDasharray="3 3" />
            <circle cx={x(hovered[0])} cy={y(hovered[1])} r={4} className="fill-primaryBlue stroke-background" strokeWidth={2} />
          </g>
        )}
      </svg>
      {hovered && (
        <div
          id="stats-graph-tip"
          className="pointer-events-none absolute top-2 rounded-card border border-primaryStroke bg-backgroundSecondary px-2 py-1 text-xs"
          style={x(hovered[0]) > W / 2 ? { right: `${((W - x(hovered[0])) / W) * 100 + 2}%` } : { left: `${(x(hovered[0]) / W) * 100 + 2}%` }}
        >
          <span className="text-textSecondary">{clock(hovered[0])}</span> <span className="font-semibold tabular-nums text-textPrimary">{hovered[1]} watching</span>
        </div>
      )}
      <div className="sr-only">
        <table>
          <caption>viewers each minute</caption>
          <thead>
            <tr>
              <th scope="col">time</th>
              <th scope="col">viewers</th>
            </tr>
          </thead>
          <tbody>
            {points.map(([t, v]) => (
              <tr key={t}>
                <td>{clock(t)}</td>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}
