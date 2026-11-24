import { sparkline } from '@/infra/debug/rings';
import { useCollected } from '@/shared-components/debug/useCollected';

function fixed(v: number | null, digits = 0): string {
  return v === null || !Number.isFinite(v) ? '-' : v.toFixed(digits);
}

export function Quality() {
  const { stats, quality } = useCollected();
  if (!stats) {
    return (
      <div id="inspector-quality" className="min-h-0 flex-1 overflow-y-auto px-3 py-1 text-xs leading-5">
        <p className="py-2 text-textTertiary">not watching</p>
      </div>
    );
  }
  const v = stats.video;
  const rows: [string, string][] = [
    ['res', v.width && v.height ? `${v.width}x${v.height}` : '-'],
    ['fps', fixed(v.fps)],
    ['bitrate', `${fixed(v.bitrate / 1000)} kbps`],
    ['loss', `${fixed(v.lossPct, 1)} %`],
    ['dropped', `${fixed(v.droppedPerSec, 1)} /s`],
    ['jitter', `${fixed(v.jitterMs)} ms`],
    ['rtt', `${fixed(stats.rttMs)} ms`],
    ['path', stats.path ?? '-']
  ];
  const lines: [string, number[]][] = quality
    ? [
        ['bitrate', quality.series('bitrate')],
        ['fps', quality.series('fps')]
      ]
    : [];
  return (
    <div id="inspector-quality" className="min-h-0 flex-1 overflow-y-auto px-3 py-1 font-mono text-xs leading-5">
      <ul>
        {rows.map(([name, value]) => (
          <li key={name} className="flex items-baseline gap-2 border-b border-primaryStroke/60 py-1 last:border-b-0">
            <span className="w-[80px] shrink-0 text-textSecondary">{name}</span>
            <span className="min-w-0 flex-1 truncate tabular-nums text-textPrimary">{value}</span>
          </li>
        ))}
      </ul>
      {lines.map(([name, series]) => (
        <div key={name} className="flex items-baseline gap-2 py-1">
          <span className="w-[80px] shrink-0 text-textSecondary">{name}</span>
          <span className="min-w-0 flex-1 truncate text-textPrimary">{sparkline(series)}</span>
          <span className="shrink-0 text-textTertiary">{series.length} s</span>
        </div>
      ))}
    </div>
  );
}
