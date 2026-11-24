import { useAtomValue } from 'jotai';

import { closeQuality, qualityOpenAtom } from '@/infra/atoms/inspector-atoms';
import { quality } from '@/infra/debug/collect';
import type { QualityCollector } from '@/infra/debug/collector';
import { layout } from '@/infra/debug/timeline';
import { DebugPanel } from '@/shared-components/debug/DebugPanel';
import { QualityView, type QualitySeries, type QualityTimeline } from '@/shared-components/debug/QualityView';
import { useCollected } from '@/shared-components/debug/useCollected';

function fixed(v: number | null, digits = 0): string {
  return v === null || !Number.isFinite(v) ? '-' : v.toFixed(digits);
}

function nowRow(c: QualityCollector): [string, string][] | null {
  const stats = c.stats;
  if (!stats) return null;
  const v = stats.video;
  return [
    ['res', v.width && v.height ? `${v.width}x${v.height}` : '-'],
    ['fps', fixed(v.fps)],
    ['bitrate', `${fixed(v.bitrate / 1000)} kbps`],
    ['loss', `${fixed(v.lossPct, 1)} %`],
    ['dropped', `${fixed(v.droppedPerSec, 1)} /s`],
    ['jitter', `${fixed(v.jitterMs)} ms`],
    ['rtt', `${fixed(stats.rttMs)} ms`],
    ['path', stats.path ?? '-']
  ];
}

function timeline(c: QualityCollector): QualityTimeline | null {
  const q = c.quality;
  if (!q || q.count === 0) return null;
  const t = q.series('t');
  const rtt = q.series('rttMs');
  const series: QualitySeries[] = [
    { key: 'bitrate', label: 'bitrate', unit: 'kbps', digits: 0, values: q.series('bitrate').map((v) => v / 1000) },
    { key: 'fps', label: 'fps', unit: '', digits: 0, values: q.series('fps') },
    { key: 'loss', label: 'loss', unit: '%', digits: 1, values: q.series('lossPct') },
    { key: 'jitter', label: 'jitter', unit: 'ms', digits: 0, values: q.series('jitterMs') }
  ];
  if (rtt.some((v) => Number.isFinite(v))) series.push({ key: 'rtt', label: 'rtt', unit: 'ms', digits: 0, values: rtt });
  return { t, layout: layout(t, q.series('session'), c.sessions?.list ?? []), series };
}

export function QualityWindow() {
  const open = useAtomValue(qualityOpenAtom);
  return open ? <QualityPanel /> : null;
}

function QualityPanel() {
  const c = useCollected(quality);
  return (
    <DebugPanel
      id="quality"
      label="quality"
      note="watched time, the gaps left out"
      place="left-auto right-[104px] top-[104px] h-[min(440px,calc(100dvh-208px))] w-[min(600px,calc(100vw-208px))]"
      onClose={closeQuality}
    >
      <QualityView now={nowRow(c)} timeline={timeline(c)} />
    </DebugPanel>
  );
}
