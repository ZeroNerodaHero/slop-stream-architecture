import { type PointerEvent as ReactPointerEvent, useState } from 'react';

import { niceTicks } from '@/infra/debug/stats';
import { hoverWords } from '@/infra/debug/quality-header';
import type { Gap, Layout } from '@/infra/debug/timeline';
import { useWidth } from '@/shared-components/debug/useWidth';
import { Tooltip } from '@/shared-components/Tooltip';

export interface QualitySeries {
  key: string;
  label: string;
  unit: string;
  digits: number;
  values: readonly number[];
}

export interface QualityTimeline {
  t: readonly number[];
  layout: Layout;
  series: readonly QualitySeries[];
}

const PAD_L = 4;
const PAD_R = 8;
const CHART_H = 40;
const NAMES_H = 16;
const HEAD_H = 18;
const BAR_W = 6;

const clock = (at: number) => new Date(at).toLocaleTimeString();

function fixed(v: number | undefined, digits: number): string {
  return v === undefined || !Number.isFinite(v) ? '-' : v.toFixed(digits);
}

function gapWords(gap: Gap): string {
  return `stopped watching ${gap.name || 'a stream'} · ${clock(gap.from)} → ${gap.to === null ? 'now' : clock(gap.to)}`;
}

function linePath(values: readonly number[], layout: Layout, x: (v: number) => number, y: (v: number) => number): string {
  let d = '';
  for (const run of layout.runs) {
    let open = false;
    for (let i = run.from; i < run.to; i++) {
      const v = values[i]!;
      if (!Number.isFinite(v)) {
        open = false;
        continue;
      }
      const px = x(layout.xs[i]!).toFixed(1);
      const py = y(v).toFixed(1);
      if (open) d += `L${px} ${py}`;
      else d += `M${px} ${py}l0.01 0`;
      open = true;
    }
  }
  return d;
}

function Charts({ timeline }: { timeline: QualityTimeline }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const { layout, series, t } = timeline;
  const plot = Math.max(1, width - PAD_L - PAD_R);
  const x = (v: number) => PAD_L + (v / layout.span) * plot;
  const stack = NAMES_H + series.length * (HEAD_H + CHART_H);
  const at = hover !== null && hover < t.length ? hover : null;

  const pick = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'touch' || layout.xs.length === 0) return;
    const left = e.clientX - e.currentTarget.getBoundingClientRect().left;
    const want = ((left - PAD_L) / plot) * layout.span;
    let best = 0;
    for (let i = 1; i < layout.xs.length; i++) if (Math.abs(layout.xs[i]! - want) < Math.abs(layout.xs[best]! - want)) best = i;
    setHover(best);
  };

  return (
    <div ref={ref} className="w-full">
      <div id="profiler-readout" className="min-h-5 truncate font-mono text-textTertiary">
        {at !== null
          ? hoverWords(t[at]!, layout.runs.find((r) => at >= r.from && at < r.to)?.name ?? '')
          : t.length > 0
            ? `${clock(t[0]!)} → ${clock(t[t.length - 1]!)}`
            : ''}
      </div>
      {width > 0 && (
        <div className="relative" style={{ height: stack }} onPointerMove={pick} onPointerLeave={() => setHover(null)}>
          {layout.runs.map((run, i) => {
            const next = layout.runs[i + 1];
            const left = x(run.x) + (i === 0 ? 0 : BAR_W);
            const room = (next ? x(next.x) : PAD_L + plot) - left - 4;
            return (
              <span
                key={`${run.session}:${run.from}`}
                data-session={run.session}
                className="absolute top-0 truncate text-[10px] leading-4 text-textTertiary"
                style={{ left, maxWidth: Math.max(0, room) }}
              >
                {run.name}
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
                  <path
                    d={linePath(s.values, layout, x, y)}
                    fill="none"
                    strokeWidth={1.5}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="stroke-current text-primaryBlue"
                  />
                  {at !== null && Number.isFinite(s.values[at]) && (
                    <circle cx={x(layout.xs[at]!)} cy={y(s.values[at]!)} r={2.5} className="fill-current text-textPrimary" />
                  )}
                </svg>
              </div>
            );
          })}
          {at !== null && <span aria-hidden className="pointer-events-none absolute bottom-0 w-px bg-textTertiary" style={{ left: x(layout.xs[at]!), top: NAMES_H }} />}
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
