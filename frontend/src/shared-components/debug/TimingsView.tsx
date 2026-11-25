import { RiArrowDownSLine } from '@remixicon/react';
import { useState } from 'react';

import type { MetricGroup } from '@/infra/debug/rings';
import type { Summary } from '@/infra/debug/stats';
import { type Axis, hotP95, loadSections, place, pool, routeParts, saveSections, sectionAxis, type SectionState } from '@/infra/debug/strip';
import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

export interface MetricRow {
  key: string;
  label: string;
  summary: Summary;
  recent: readonly number[];
  errors?: number;
}

export interface MetricGroupRows {
  group: MetricGroup;
  rows: readonly MetricRow[];
}

const LABEL_CHARS = 20;
const GRID = 'grid grid-cols-[11rem_minmax(0,1fr)_2.875rem_2.875rem_1.75rem] items-center gap-x-2';
const GRID_API = 'grid grid-cols-[11rem_minmax(0,1fr)_2.875rem_2.875rem_1.75rem_1.75rem] items-center gap-x-2';
const NUM = 'text-right font-mono tabular-nums';
const TIP_FIELDS: [string, keyof Summary][] = [
  ['n', 'n'],
  ['min', 'min'],
  ['p25', 'p25'],
  ['med', 'median'],
  ['mean', 'mean'],
  ['p75', 'p75'],
  ['p95', 'p95'],
  ['max', 'max']
];

const ms = (v: number) => (Number.isFinite(v) ? String(Math.round(v)) : '-');
const Unit = () => <span className="text-textTertiary">ms</span>;
function Ms({ v }: { v: number }) {
  const t = ms(v);
  return t === '-' ? (
    t
  ) : (
    <>
      {t}
      <Unit />
    </>
  );
}
const short = (label: string) => (label.length > LABEL_CHARS ? `…${label.slice(-(LABEL_CHARS - 1))}` : label);

function storage(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

export function Legend() {
  return (
    <div className="flex items-center gap-3 font-mono text-[10px] font-normal text-textTertiary">
      <span className="flex items-center gap-1">
        <span aria-hidden className="h-1.5 w-3 bg-primaryBlue" />
        p25–p75
      </span>
      <span className="flex items-center gap-1">
        <span aria-hidden className="h-2.5 w-0.5 bg-white" />
        med
      </span>
      <span className="flex items-center gap-1">
        <span aria-hidden className="h-2.5 w-0.5 bg-caution" />
        p95
      </span>
      <span className="flex items-center gap-1">
        <span aria-hidden className="h-1.5 w-3 bg-secondaryStroke" />
        min–max
      </span>
    </div>
  );
}

function Strip({ s, axis }: { s: Summary; axis: Axis }) {
  const min = place(s.min, axis);
  const p25 = place(s.p25, axis);
  return (
    <div className="relative h-1.5 bg-backgroundTertiary">
      <span className="absolute inset-y-0 bg-secondaryStroke" style={{ left: `${min}%`, width: `${place(s.max, axis) - min}%` }} />
      <span className="absolute inset-y-0 min-w-px bg-primaryBlue" style={{ left: `${p25}%`, width: `${place(s.p75, axis) - p25}%` }} />
      <span className="absolute -inset-y-0.5 w-0.5 -translate-x-1/2 bg-white" style={{ left: `${place(s.median, axis)}%` }} />
      <span className="absolute -inset-y-0.5 w-0.5 -translate-x-1/2 bg-caution" style={{ left: `${place(s.p95, axis)}%` }} />
    </div>
  );
}

function Label({ group, row }: { group: MetricGroup; row: MetricRow }) {
  if (group !== 'api') return <span className="truncate text-textSecondary">{short(row.label)}</span>;
  const { method, badge, path } = routeParts(row.key);
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span
        className={cn(
          'flex h-3 w-3 shrink-0 items-center justify-center border font-mono text-[8px] leading-none',
          method === 'GET' ? 'border-secondaryStroke text-textTertiary' : 'border-primaryBlue text-primaryBlue'
        )}
      >
        {badge}
      </span>
      <span className="truncate text-textSecondary">{short(path)}</span>
    </span>
  );
}

function Row({ group, row, axis }: { group: MetricGroup; row: MetricRow; axis: Axis }) {
  const s = row.summary;
  const tip = (
    <span className="flex gap-2 font-mono font-normal tabular-nums">
      {TIP_FIELDS.map(([word, field]) => (
        <span key={word}>
          <span className="text-textTertiary">{word}</span> {field === 'n' ? s.n : <Ms v={s[field]} />}
        </span>
      ))}
    </span>
  );
  return (
    <Tooltip content={tip}>
      <div data-metric={row.key} className={cn(group === 'api' ? GRID_API : GRID, 'h-4 hover:bg-backgroundTertiary')}>
        <Label group={group} row={row} />
        <Strip s={s} axis={axis} />
        <span className={cn(NUM, 'text-textPrimary')}>
          <Ms v={s.median} />
        </span>
        <span className={cn(NUM, hotP95(s) ? 'text-caution' : 'text-textSecondary')}>
          <Ms v={s.p95} />
        </span>
        <span className={cn(NUM, 'text-textSecondary')}>{s.n}</span>
        {group === 'api' && <span className={cn(NUM, row.errors ? 'text-decrease' : 'text-textTertiary')}>{row.errors ?? 0}</span>}
      </div>
    </Tooltip>
  );
}

function Ticks({ group, axis }: { group: MetricGroup; axis: Axis }) {
  const last = axis.ticks.length - 1;
  return (
    <div className={cn(group === 'api' ? GRID_API : GRID, 'h-4 font-mono text-[10px] text-textTertiary')}>
      <span />
      <div className="relative h-full">
        {axis.ticks.map((v, i) => (
          <span key={v} className={cn('absolute top-0', i === 0 ? '' : i === last ? '-translate-x-full' : '-translate-x-1/2')} style={{ left: `${place(v, axis)}%` }}>
            {v}
            <Unit />
          </span>
        ))}
      </div>
      <span className="text-right">med</span>
      <span className="text-right">p95</span>
      <span className="text-right">n</span>
      {group === 'api' && <span className="text-right">err</span>}
    </div>
  );
}

function Section({ g, open, onToggle }: { g: MetricGroupRows; open: boolean; onToggle: () => void }) {
  const p = pool(g.rows);
  const word = `${open ? 'collapse' : 'expand'} ${g.group}`;
  const axis = sectionAxis(g.rows.map((r) => r.summary), 2);
  return (
    <section data-group={g.group} className="border-b border-primaryStroke last:border-b-0">
      <div className="flex h-[26px] cursor-pointer select-none items-center gap-2" onClick={onToggle}>
        <Tooltip content={word}>
          <button
            id={`timings-toggle-${g.group}`}
            type="button"
            aria-label={word}
            aria-expanded={open}
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
            className={cn(
              'flex h-5 w-5 shrink-0 items-center justify-center border bg-backgroundSecondary hover:border-primaryBlue hover:text-primaryBlue',
              open ? 'border-primaryBlue text-primaryBlue' : 'border-primaryStroke text-textSecondary'
            )}
          >
            <RiArrowDownSLine aria-hidden size={14} className={open ? undefined : '-rotate-90'} />
          </button>
        </Tooltip>
        <span className="font-semibold text-textPrimary">{g.group}</span>
        <span className="text-textTertiary">{g.rows.length}</span>
        <span className="ml-auto flex shrink-0 gap-3 font-mono tabular-nums text-textTertiary">
          <span>
            n <span className="text-textSecondary">{p.n}</span>
          </span>
          <span>
            med{' '}
            <span className="font-semibold text-textPrimary">
              <Ms v={p.median} />
            </span>
          </span>
          <span>
            p95{' '}
            <span className="text-textSecondary">
              <Ms v={p.p95} />
            </span>
          </span>
          {g.group === 'api' && (
            <span>
              err <span className={p.errors ? 'text-decrease' : 'text-textSecondary'}>{p.errors}</span>
            </span>
          )}
        </span>
      </div>
      {open && (
        <div className="pb-2">
          <Ticks group={g.group} axis={axis} />
          {g.rows.map((r) => (
            <Row key={r.key} group={g.group} row={r} axis={axis} />
          ))}
        </div>
      )}
    </section>
  );
}

export function TimingsView({ groups }: { groups: readonly MetricGroupRows[] }) {
  const [sections, setSections] = useState<SectionState>(() => loadSections(storage()));
  const toggle = (group: MetricGroup) => {
    const next = { ...sections, [group]: !sections[group] };
    setSections(next);
    saveSections(storage(), next);
  };
  const shown = groups.filter((g) => g.rows.length > 0);
  return (
    <div id="profiler-timings" className="min-h-0 flex-1 overflow-y-auto px-3 pb-1 text-xs leading-4">
      {shown.length === 0 && <p className="py-2 text-textTertiary">nothing yet. a chat, a say, a watch or an api call shows up here when it finishes.</p>}
      {shown.map((g) => (
        <Section key={g.group} g={g} open={sections[g.group]} onToggle={() => toggle(g.group)} />
      ))}
    </div>
  );
}
