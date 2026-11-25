import { useAtomValue } from 'jotai';

import { closeQuality, qualityOpenAtom } from '@/infra/atoms/inspector-atoms';
import { quality } from '@/infra/debug/collect';
import type { QualityCollector } from '@/infra/debug/collector';
import { liveHeader } from '@/infra/debug/quality-header';
import { layout } from '@/infra/debug/timeline';
import { DebugPanel } from '@/shared-components/debug/DebugPanel';
import { QualityView, type QualitySeries, type QualityTimeline } from '@/shared-components/debug/QualityView';
import { useCollected } from '@/shared-components/debug/useCollected';
import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

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
  const live = liveHeader(c.stats);
  const word = live ? 'recording' : 'not recording';
  return (
    <DebugPanel
      id="quality"
      label="quality"
      lead={
        <Tooltip content={word}>
          <span id="quality-recording" role="img" aria-label={word} tabIndex={0} className={cn('h-2 w-2 shrink-0 focus-visible:outline-none', live ? 'bg-increase' : 'bg-decrease')} />
        </Tooltip>
      }
      note={live ? <span id="quality-live" className="font-mono tabular-nums">{live}</span> : 'watched time, the gaps left out'}
      place="left-auto right-[104px] top-[104px] h-[min(440px,calc(100dvh-208px))] w-[min(600px,calc(100vw-208px))]"
      onClose={closeQuality}
    >
      <QualityView timeline={timeline(c)} />
    </DebugPanel>
  );
}
