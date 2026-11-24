import type { MetricGroup } from '@/infra/debug/rings';
import { niceTicks, type Summary } from '@/infra/debug/stats';
import { useWidth } from '@/shared-components/debug/useWidth';

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

const GROUP_WORD: Record<MetricGroup, string> = {
  chat: 'chat: ms from the press or the mount, and a say to its ack',
  watch: 'watch: ms from the press',
  api: 'api: ms from the request to the answer, by route, most asked first'
};

const LABEL_W = 120;
const PAD_R = 12;
const ROW = 30;
const AXIS = 18;
const COLUMNS: [string, keyof Summary][] = [
  ['n', 'n'],
  ['min', 'min'],
  ['p25', 'p25'],
  ['med', 'median'],
  ['mean', 'mean'],
  ['p75', 'p75'],
  ['p95', 'p95'],
  ['max', 'max']
];

const LABEL_CHARS = 20;

const ms = (v: number) => (Number.isFinite(v) ? String(Math.round(v)) : '-');
const short = (label: string) => (label.length > LABEL_CHARS ? `…${label.slice(-(LABEL_CHARS - 1))}` : label);

function BoxPlot({ rows }: { rows: readonly MetricRow[] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const ticks = niceTicks(Math.max(...rows.map((r) => r.summary.max)));
  const top = ticks[ticks.length - 1]! || 1;
  const plot = Math.max(1, width - LABEL_W - PAD_R);
  const x = (v: number) => LABEL_W + (Math.max(0, v) / top) * plot;
  const height = rows.length * ROW + AXIS;
  return (
    <div ref={ref} className="w-full">
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label="box plot of the timings" className="block font-mono text-[10px]">
          {ticks.map((v) => (
            <line key={v} x1={x(v)} x2={x(v)} y1={0} y2={rows.length * ROW} className="stroke-current text-primaryStroke" />
          ))}
          {rows.map((r, i) => {
            const y = i * ROW;
            const mid = y + 11;
            const s = r.summary;
            return (
              <g key={r.key} data-metric={r.key}>
                <text x={0} y={mid + 3} className="fill-current font-sans text-textSecondary">
                  {short(r.label)}
                </text>
                <line x1={x(s.min)} x2={x(s.max)} y1={mid} y2={mid} className="stroke-current text-textTertiary" />
                <line x1={x(s.min)} x2={x(s.min)} y1={mid - 4} y2={mid + 4} className="stroke-current text-textTertiary" />
                <line x1={x(s.max)} x2={x(s.max)} y1={mid - 4} y2={mid + 4} className="stroke-current text-textTertiary" />
                <rect
                  x={x(s.p25)}
                  y={mid - 6}
                  width={Math.max(1, x(s.p75) - x(s.p25))}
                  height={12}
                  fillOpacity={0.2}
                  className="fill-current stroke-current text-primaryBlue"
                />
                <line x1={x(s.median)} x2={x(s.median)} y1={mid - 6} y2={mid + 6} strokeWidth={2} className="stroke-current text-primaryBlue" />
                <circle cx={x(s.mean)} cy={mid} r={2.5} className="fill-current text-textPrimary" />
                {r.recent.map((v, j) => (
                  <circle key={j} cx={x(v)} cy={y + 24} r={1.5} fillOpacity={0.6} className="fill-current text-textSecondary" />
                ))}
              </g>
            );
          })}
          {ticks.map((v, i) => (
            <text key={v} x={x(v)} y={height - 4} textAnchor={i === 0 ? 'start' : i === ticks.length - 1 ? 'end' : 'middle'} className="fill-current text-textTertiary">
              {i === ticks.length - 1 ? `${v} ms` : v}
            </text>
          ))}
        </svg>
      )}
    </div>
  );
}

export function TimingsView({ groups }: { groups: readonly MetricGroupRows[] }) {
  const shown = groups.filter((g) => g.rows.length > 0);
  return (
    <div id="profiler-timings" className="min-h-0 flex-1 overflow-y-auto px-3 py-1 text-xs leading-5">
      {shown.length === 0 && <p className="py-2 text-textTertiary">nothing yet. a chat, a say, a watch or an api call shows up here when it finishes.</p>}
      {shown.map((g) => (
        <section key={g.group} data-group={g.group} className="pb-3">
          <div className="py-2 text-textTertiary">{GROUP_WORD[g.group]}</div>
          <BoxPlot rows={g.rows} />
          <table className="mt-2 w-full font-mono tabular-nums">
            <thead>
              <tr className="border-b border-primaryStroke text-textTertiary">
                <th className="py-1 pr-2 text-left font-normal">metric</th>
                {COLUMNS.map(([word]) => (
                  <th key={word} className="py-1 pl-2 text-right font-normal">
                    {word}
                  </th>
                ))}
                {g.group === 'api' && <th className="py-1 pl-2 text-right font-normal">err</th>}
              </tr>
            </thead>
            <tbody>
              {g.rows.map((r) => (
                <tr key={r.key} data-metric={r.key} className="border-b border-primaryStroke/60 last:border-b-0">
                  <td className="truncate py-1 pr-2 font-sans text-textSecondary">{r.label}</td>
                  {COLUMNS.map(([word, field]) => (
                    <td key={word} className={field === 'median' ? 'py-1 pl-2 text-right text-textPrimary' : 'py-1 pl-2 text-right text-textSecondary'}>
                      {field === 'n' ? r.summary.n : ms(r.summary[field])}
                    </td>
                  ))}
                  {g.group === 'api' && (
                    <td className={r.errors ? 'py-1 pl-2 text-right text-textPrimary' : 'py-1 pl-2 text-right text-textSecondary'}>{r.errors ?? 0}</td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}
