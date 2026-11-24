import { RiCloseLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { useState } from 'react';

import { closeProfiler, profilerOpenAtom } from '@/infra/atoms/inspector-atoms';
import type { Collector } from '@/infra/debug/collector';
import { METRIC_GROUPS, METRICS } from '@/infra/debug/rings';
import { summarize } from '@/infra/debug/stats';
import { layout } from '@/infra/debug/timeline';
import { useIsMobile } from '@/infra/mobile';
import { QualityView, type QualitySeries, type QualityTimeline } from '@/shared-components/debug/QualityView';
import { type MetricGroupRows, TimingsView } from '@/shared-components/debug/TimingsView';
import { useCollected } from '@/shared-components/debug/useCollected';
import { FRAME, GRIP, useDialogBox } from '@/shared-components/debug/useDialogBox';
import { SHEET_CLOSE, SheetGrab, useSheetBack } from '@/shared-components/MobileSheet';
import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

const TABS = ['timings', 'quality'] as const;
const ON = 'border-primaryBlue text-primaryBlue';

type Tab = (typeof TABS)[number];

function fixed(v: number | null, digits = 0): string {
  return v === null || !Number.isFinite(v) ? '-' : v.toFixed(digits);
}

function timingGroups(c: Collector): MetricGroupRows[] {
  const timings = c.timings;
  return METRIC_GROUPS.map((group) => ({
    group,
    rows: METRICS.filter((m) => m.group === group)
      .map((m) => {
        const recent = timings?.values(m.key) ?? [];
        return { key: m.key, label: m.label, summary: summarize(recent), recent };
      })
      .filter((r) => r.summary.n > 0)
  }));
}

function nowRow(c: Collector): [string, string][] | null {
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

function timeline(c: Collector): QualityTimeline | null {
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

function Timings() {
  const c = useCollected();
  return <TimingsView groups={timingGroups(c)} />;
}

function Quality() {
  const c = useCollected();
  return <QualityView now={nowRow(c)} timeline={timeline(c)} />;
}

export function Profiler() {
  const open = useAtomValue(profilerOpenAtom);
  return open ? <ProfilerPanel /> : null;
}

function ProfilerPanel() {
  const { dialogRef, box, press } = useDialogBox();
  const [tab, setTab] = useState<Tab>('timings');
  const mobile = useIsMobile();
  useSheetBack(closeProfiler);

  return (
    <dialog
      ref={dialogRef}
      id="profiler-panel"
      aria-label="profiler"
      onClose={closeProfiler}
      data-sheet={mobile ? '' : undefined}
      style={box && !mobile ? { left: box.x, top: box.y, width: box.w, height: box.h } : undefined}
      className={cn(
        FRAME,
        'fixed z-50 m-0 flex flex-col overflow-hidden p-0 text-sm text-textPrimary open:flex',
        mobile
          ? 'inset-x-0 bottom-0 top-auto h-[60dvh] w-full max-w-none border-x-0 border-b-0 pb-[env(safe-area-inset-bottom)]'
          : !box && 'left-auto right-6 top-6 h-[min(440px,calc(100dvh-3rem))] w-[min(600px,calc(100vw-3rem))]'
      )}
    >
      {mobile && <SheetGrab onDismiss={closeProfiler} />}
      <header
        className={cn('flex cursor-move items-center gap-2 border-b border-primaryStroke px-3 py-2', GRIP, mobile && 'cursor-auto')}
        onPointerDown={(e) => {
          if (!mobile) press(e, 'move');
        }}
      >
        <span id="profiler-tabs" role="tablist" aria-label="views" className="flex gap-1">
          {TABS.map((t) => (
            <button
              key={t}
              id={`profiler-tab-${t}`}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={cn('border px-2 py-0.5 text-xs uppercase tracking-wide', tab === t ? ON : 'border-primaryStroke text-textTertiary')}
            >
              {t}
            </button>
          ))}
        </span>
        <span className="text-xs text-textTertiary">{tab === 'timings' ? 'the last 100 of each' : 'watched time, the gaps left out'}</span>
        <span className="ml-auto flex items-center gap-1">
          <Tooltip content="close">
            <button
              id="profiler-close"
              type="button"
              aria-label="close"
              onClick={closeProfiler}
              className={cn('flex h-7 w-7 items-center justify-center border border-transparent hover:border-primaryBlue hover:text-primaryBlue', SHEET_CLOSE)}
            >
              <RiCloseLine aria-hidden size={18} />
            </button>
          </Tooltip>
        </span>
      </header>

      {tab === 'timings' ? <Timings /> : <Quality />}

      {!mobile && (
        <div
          id="profiler-resize-se"
          aria-hidden
          onPointerDown={(e) => press(e, 'resize')}
          className={cn('absolute -bottom-px -right-px h-4 w-4 cursor-nwse-resize border-b-2 border-r-2 border-primaryBlue', GRIP)}
        />
      )}
    </dialog>
  );
}
