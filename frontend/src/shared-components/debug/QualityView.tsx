import { type PointerEvent as ReactPointerEvent, useState } from 'react';

import type { Path } from '@/infra/debug/rings';
import { niceTicks, summarize } from '@/infra/debug/stats';
import { hoverWords } from '@/infra/debug/quality-header';
import { runAt, sessionColor } from '@/infra/debug/session-colors';
import type { Gap, Layout, Run } from '@/infra/debug/timeline';
import { useWidth } from '@/shared-components/debug/useWidth';
import { Face } from '@/shared-components/Face';
import { TIP_CARD, Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

export interface QualitySeries {
  key: string;
  label: string;
  unit: string;
  digits: number;
  values: readonly number[];
}

export interface QualityDetails {
  width: readonly number[];
  height: readonly number[];
  dropped: readonly number[];
  route: readonly Path[];
}

export interface QualityTimeline {
  t: readonly number[];
  layout: Layout;
  series: readonly QualitySeries[];
  details?: QualityDetails;
}

const PAD_L = 4;
const PAD_R = 8;
const CHART_H = 40;
const NAMES_H = 16;
const HEAD_H = 18;
const BAR_W = 6;
const FACE_ROOM = 40;

const clock = (at: number) => new Date(at).toLocaleTimeString();

function fixed(v: number | undefined, digits: number): string {
  return v === undefined || !Number.isFinite(v) ? '-' : v.toFixed(digits);
}

function gapWords(gap: Gap): string {
  return `stopped watching ${gap.name || 'a stream'} · ${clock(gap.from)} → ${gap.to === null ? 'now' : clock(gap.to)}`;
}

function linePath(values: readonly number[], run: Run, xs: readonly number[], x: (v: number) => number, y: (v: number) => number): string {
  let d = '';
  let open = false;
  for (let i = run.from; i < run.to; i++) {
    const v = values[i]!;
    if (!Number.isFinite(v)) {
      open = false;
      continue;
    }
    const px = x(xs[i]!).toFixed(1);
    const py = y(v).toFixed(1);
    if (open) d += `L${px} ${py}`;
    else d += `M${px} ${py}l0.01 0`;
    open = true;
  }
  return d;
}

const CARD_GAP = 12;

function spread(values: readonly number[], run: Run): [number, number, number] | null {
  const seen = values.slice(run.from, run.to).filter((v) => Number.isFinite(v));
  if (seen.length === 0) return null;
  const s = summarize(seen);
  return [s.min, s.median, s.max];
}

function extrasAt(details: QualityDetails | undefined, at: number): string[] {
  if (!details) return [];
  const out: string[] = [];
  const w = details.width[at];
  const h = details.height[at];
  if (w && h) out.push(`res ${w}x${h}`);
  const dropped = details.dropped[at];
  if (dropped !== undefined && Number.isFinite(dropped)) out.push(`dropped ${dropped.toFixed(1)}/s`);
  const route = details.route[at];
  if (route) out.push(route);
  return out;
}

function HoverCard({ timeline, at, px, width }: { timeline: QualityTimeline; at: number; px: number; width: number }) {
  const { layout, series, t, details } = timeline;
  const run = runAt(layout.runs, at);
  const color = sessionColor(run?.session ?? 0);
  const extras = extrasAt(details, at);
  const flip = px > width / 2;
  return (
    <div
      id="quality-hover"
      role="tooltip"
      className={cn('pointer-events-none absolute z-10 whitespace-nowrap', TIP_CARD)}
      style={{ top: NAMES_H, ...(flip ? { right: width - px + CARD_GAP } : { left: px + CARD_GAP }) }}
    >
      <div className="flex items-center gap-1.5">
        <span aria-hidden className={cn('h-2 w-2 shrink-0 bg-current', color)} />
        {run?.name && <Face name={run.name} version={run.avatar} className="h-3.5 w-3.5 text-[8px]" />}
        <span>{run?.name || 'unknown'}</span>
        <span className="font-mono font-normal text-textTertiary">{clock(t[at]!)}</span>
      </div>
      <div className="mt-1 grid grid-cols-[auto_auto_auto] items-baseline gap-x-3 font-mono font-normal tabular-nums">
        {series.map((s) => {
          const range = run ? spread(s.values, run) : null;
          return (
            <div key={s.key} data-hover-metric={s.key} className="contents">
              <span className="text-textSecondary">{s.label}</span>
              <span className="text-right text-textPrimary">
                {fixed(s.values[at], s.digits)}
                {s.unit && <span className="text-textTertiary"> {s.unit}</span>}
              </span>
              <span className="text-textTertiary">{range ? `${fixed(range[0], s.digits)} / ${fixed(range[1], s.digits)} / ${fixed(range[2], s.digits)}` : '-'}</span>
            </div>
          );
        })}
      </div>
      <div className="text-right font-mono text-[10px] font-normal text-textTertiary">min / med / max</div>
      {extras.length > 0 && <div className="mt-0.5 font-mono font-normal text-textTertiary">{extras.join(' · ')}</div>}
    </div>
  );
}

function Charts({ timeline }: { timeline: QualityTimeline }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const [frozen, setFrozen] = useState<QualityTimeline | null>(null);
  const { layout, series, t } = frozen ?? timeline;
  const plot = Math.max(1, width - PAD_L - PAD_R);
  const x = (v: number) => PAD_L + (v / layout.span) * plot;
  const stack = NAMES_H + series.length * (HEAD_H + CHART_H);
  const at = hover !== null && hover < t.length ? hover : null;
  const atColor = at !== null ? sessionColor(runAt(layout.runs, at)?.session ?? 0) : '';

  const pick = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'touch' || layout.xs.length === 0) return;
    if (!frozen) setFrozen(timeline);
    const left = e.clientX - e.currentTarget.getBoundingClientRect().left;
    const want = ((left - PAD_L) / plot) * layout.span;
    if (want < layout.xs[0]! - (BAR_W / plot) * layout.span) {
      setHover(null);
      return;
    }
    let best = 0;
    for (let i = 1; i < layout.xs.length; i++) if (Math.abs(layout.xs[i]! - want) < Math.abs(layout.xs[best]! - want)) best = i;
    setHover(best);
  };

  return (
    <div ref={ref} className="w-full">
      <div id="profiler-readout" className="flex min-h-5 items-baseline gap-2 font-mono text-textTertiary">
        <span className="min-w-0 truncate">
          {at !== null ? hoverWords(t[at]!, runAt(layout.runs, at)?.name ?? '') : t.length > 0 ? `${clock(t[0]!)} → ${clock(t[t.length - 1]!)}` : ''}
        </span>
        {frozen && (
          <span id="profiler-paused" className="ml-auto shrink-0 text-[10px]">
            paused
          </span>
        )}
      </div>
      {width > 0 && (
        <div
          className="relative"
          style={{ height: stack }}
          onPointerMove={pick}
          onPointerLeave={() => {
            setHover(null);
            setFrozen(null);
          }}
        >
          {layout.runs.map((run, i) => {
            const next = layout.runs[i + 1];
            const left = x(run.x) + (i === 0 ? 0 : BAR_W);
            const room = (next ? x(next.x) : PAD_L + plot) - left - 4;
            return (
              <span
                key={`${run.session}:${run.from}`}
                data-session={run.session}
                className={cn('absolute top-0 flex items-center gap-1 text-[10px] leading-4', sessionColor(run.session))}
                style={{ left, maxWidth: Math.max(0, room) }}
              >
                {run.name && room >= FACE_ROOM && <Face name={run.name} version={run.avatar} className="h-3.5 w-3.5 border-current text-[8px]" />}
                <span className="min-w-0 truncate">{run.name}</span>
              </span>
            );
          })}
          {layout.gaps.map((gap) => {
            const words = gapWords(gap);
            return (
              <Tooltip key={`${gap.from}:${gap.x}`} content={words}>
                <span
                  role="img"
                  aria-label={words}
                  tabIndex={0}
                  data-gap={gap.name}
                  className="absolute bottom-0 top-0 bg-secondaryStroke focus-visible:outline-none"
                  style={{ left: Math.min(x(gap.x), PAD_L + plot - BAR_W / 2) - BAR_W / 2, width: BAR_W }}
                />
              </Tooltip>
            );
          })}
          {series.map((s, i) => {
            const finite = s.values.filter((v) => Number.isFinite(v));
            const most = finite.length > 0 ? Math.max(...finite) : Number.NaN;
            const ticks = niceTicks(most, 2);
            const top = ticks[ticks.length - 1]! || 1;
            const y = (v: number) => CHART_H - 2 - (Math.max(0, v) / top) * (CHART_H - 4);
            const last = s.values[s.values.length - 1];
            return (
              <div key={s.key} data-chart={s.key} className="pointer-events-none absolute inset-x-0" style={{ top: NAMES_H + i * (HEAD_H + CHART_H) }}>
                <div className="flex items-baseline gap-2" style={{ height: HEAD_H }}>
                  <span className="text-textSecondary">{s.label}</span>
                  <span className="text-textTertiary">{s.unit}</span>
                  <span className="font-mono tabular-nums text-textTertiary">
                    {fixed(last, s.digits)} · max {fixed(most, s.digits)}
                  </span>
                </div>
                <svg width={width} height={CHART_H} role="img" aria-label={`${s.label} over the watched time`} className="block">
                  <line x1={PAD_L} x2={PAD_L + plot} y1={CHART_H - 2} y2={CHART_H - 2} className="stroke-current text-primaryStroke" />
                  <line x1={PAD_L} x2={PAD_L + plot} y1={2} y2={2} strokeDasharray="2 3" className="stroke-current text-primaryStroke" />
                  {layout.runs.map((run) => (
                    <path
                      key={`${run.session}:${run.from}`}
                      d={linePath(s.values, run, layout.xs, x, y)}
                      fill="none"
                      strokeWidth={1.5}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className={cn('stroke-current', sessionColor(run.session))}
                    />
                  ))}
                  {at !== null && Number.isFinite(s.values[at]) && (
                    <circle cx={x(layout.xs[at]!)} cy={y(s.values[at]!)} r={2.5} className={cn('fill-current', atColor)} />
                  )}
                </svg>
              </div>
            );
          })}
          {at !== null && <span aria-hidden className="pointer-events-none absolute bottom-0 w-px bg-textTertiary" style={{ left: x(layout.xs[at]!), top: NAMES_H }} />}
          {at !== null && <HoverCard timeline={frozen ?? timeline} at={at} px={x(layout.xs[at]!)} width={width} />}
        </div>
      )}
    </div>
  );
}

export function QualityView({ timeline }: { timeline: QualityTimeline | null }) {
  return (
    <div id="profiler-quality" className="min-h-0 flex-1 overflow-y-auto px-3 py-1 text-xs leading-5">
      {timeline && timeline.t.length > 0 && (
        <div className="pt-1">
          <Charts timeline={timeline} />
        </div>
      )}
    </div>
  );
}
