import { RUN_KINDS, type RunKind, type TimedRun } from '@/infra/debug/rings';
import { useCollected } from '@/shared-components/debug/useCollected';
import { Tooltip } from '@/shared-components/Tooltip';

const KIND_WORD: Record<RunKind, string> = {
  chat: 'chat: subbed, history, first line',
  say: 'say: ack or nack',
  watch: 'watch: press to first frame'
};

function clock(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour12: false });
}

function total(run: TimedRun): number {
  return run.phases.reduce((most, [, ms]) => Math.max(most, ms), 0);
}

export function Timings() {
  const { timings } = useCollected();
  const empty = !timings || timings.size() === 0;
  return (
    <ul id="inspector-timings" className="min-h-0 flex-1 overflow-y-auto px-3 py-1 font-mono text-xs leading-5">
      {empty && <li className="py-2 font-sans text-textTertiary">nothing yet. a chat, a say or a watch shows up here when it finishes.</li>}
      {!empty &&
        RUN_KINDS.map((kind) => {
          const runs = timings.runs[kind];
          if (runs.length === 0) return null;
          return (
            <li key={kind} data-kind={kind}>
              <div className="py-2 font-sans text-textTertiary">{KIND_WORD[kind]}</div>
              <ul>
                {runs
                  .slice()
                  .reverse()
                  .map((run, i) => (
                    <li key={`${run.at}:${i}`} className="flex items-baseline gap-2 border-b border-primaryStroke/60 py-1 last:border-b-0">
                      <span className="w-[64px] shrink-0 tabular-nums text-textTertiary">{clock(run.at)}</span>
                      <Tooltip content={run.label}>
                        <span className="w-[80px] shrink-0 truncate text-textSecondary">{run.label || kind}</span>
                      </Tooltip>
                      <span className="min-w-0 flex-1 truncate text-textSecondary">{run.phases.map(([name, ms]) => `${name} ${ms}`).join(' · ')}</span>
                      <span className="shrink-0 tabular-nums text-textPrimary">{total(run)} ms</span>
                    </li>
                  ))}
              </ul>
            </li>
          );
        })}
    </ul>
  );
}
