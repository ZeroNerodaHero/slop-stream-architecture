import { useAtomValue } from 'jotai';

import { closeTimings, timingsOpenAtom } from '@/infra/atoms/inspector-atoms';
import { timings } from '@/infra/debug/collect';
import type { TimingsCollector } from '@/infra/debug/collector';
import { METRIC_GROUPS, METRICS } from '@/infra/debug/rings';
import { summarize } from '@/infra/debug/stats';
import { DebugPanel } from '@/shared-components/debug/DebugPanel';
import { Legend, type MetricGroupRows, TimingsView } from '@/shared-components/debug/TimingsView';
import { useCollected } from '@/shared-components/debug/useCollected';

function timingGroups(c: TimingsCollector): MetricGroupRows[] {
  const t = c.timings;
  const groups: MetricGroupRows[] = METRIC_GROUPS.map((group) => ({
    group,
    rows: METRICS.filter((m) => m.group === group)
      .map((m) => {
        const recent = t?.values(m.key) ?? [];
        return { key: m.key, label: m.label, summary: summarize(recent), recent };
      })
      .filter((r) => r.summary.n > 0)
  }));
  const api = c.api;
  const rows = api
    ? [...api.routes.keys()]
        .map((key) => {
          const recent = api.values(key);
          return { key, label: key, summary: summarize(recent), recent, errors: api.errors(key) };
        })
        .sort((a, b) => b.summary.n - a.summary.n || (a.key < b.key ? -1 : 1))
    : [];
  groups.push({ group: 'api', rows });
  return groups;
}

export function TimingsWindow() {
  const open = useAtomValue(timingsOpenAtom);
  return open ? <TimingsPanel /> : null;
}

function TimingsPanel() {
  const c = useCollected(timings);
  return (
    <DebugPanel
      id="timings"
      label="timings"
      actions={<Legend />}
      place="left-auto right-16 top-16 h-[min(440px,calc(100dvh-8rem))] w-[min(600px,calc(100vw-8rem))]"
      onClose={closeTimings}
    >
      <TimingsView groups={timingGroups(c)} />
    </DebugPanel>
  );
}
