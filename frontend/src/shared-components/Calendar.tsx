import { useAtomValue } from 'jotai';
import { useEffect, useState } from 'react';

import { calendarAtom, loadCalendar, rangeOf, watchIsLiveAtom } from '@/infra/atoms/calendar-atoms';
import { addDays, blocksOf, detailOf, fmtDate, fmtDur, fmtRow, localMidnight, MIN_MS, rowsOf, totalOf, usuallyOf } from '@/infra/calendar';
import { buttonClassName } from '@/shared-components/Button';
import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

/** The day labels' column, px. The hour lines and the scale start after it. */
const LABEL_W = 58;
const NAV = buttonClassName('secondary', 'px-2 py-0.5 text-xs');
const HOURS: [number, string][] = [
  [0, '12am'],
  [25, '6am'],
  [50, '12pm'],
  [75, '6pm'],
  [100, '12am']
];

function pct(min: number): string {
  return `${(min / 1440) * 100}%`;
}

/**
 * When they stream (docs/calendar.md): four weeks of day rows, oldest at the top and today at
 * the bottom, each row 24 hours wide, a bar per stream from its start hour to its end hour. Days
 * as rows and hours as columns on purpose: every 8pm is the same column, so a person who streams
 * at 8 is a stripe you see before you read anything. The line above the strip says it in words.
 * Everything is the viewer's clock and zone: a block over the viewer's midnight is two pieces on
 * two rows. Blocks are the accent; one the sweeper closed is grey with a dashed end (its end is
 * the last heartbeat); a red mark is a connection that dropped and was back inside five minutes,
 * drawn as one block. The open block ends at a line that moves, once a minute.
 */
export function Calendar({ name }: { name: string }) {
  const cal = useAtomValue(calendarAtom);
  const live = useAtomValue(watchIsLiveAtom);
  // the clock, in state: a render must not read one. once a minute the open block grows a step
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), MIN_MS);
    return () => clearInterval(t);
  }, []);
  // the four weeks ending today, for this name, each time the strip is shown: one request per open
  useEffect(() => {
    void loadCalendar(name, 0);
  }, [name]);

  const mine = cal.name === name;
  const page = mine ? cal.page : 0;
  const rows = mine ? cal.rows : [];
  const { first, last } = rangeOf(page, now);
  const today = localMidnight(now);
  // a thousand rows at most, laid out on 28 days: cheap enough to do on every render (a render is an
  // atom change or the minute tick, not a hover: the tooltips keep their own state)
  const blocks = blocksOf(rows, live, now);
  const byDay = rowsOf(blocks, first, now);

  const newest = blocks[blocks.length - 1];
  const total = totalOf(blocks, now);

  return (
    <div id="calendar" data-page={page} data-phase={mine ? cal.phase : 'loading'}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span id="calendar-usually" className="font-semibold">
          {mine && cal.phase === 'ready' ? usuallyOf(blocks) : mine && cal.phase === 'failed' ? 'cannot load the calendar' : 'loading'}
        </span>
        <span className="text-sm text-textTertiary">your time</span>
        {blocks.length > 0 && (
          <span id="calendar-total" className="ml-auto text-base text-textSecondary">
            {blocks.length} {blocks.length === 1 ? 'stream' : 'streams'} · {fmtDur(total)}
          </span>
        )}
      </div>

      <div className="mt-3 flex items-center gap-2 text-base">
        <button id="calendar-back" type="button" aria-label="four weeks back" className={NAV} onClick={() => void loadCalendar(name, page + 1)}>
          ‹
        </button>
        <span id="calendar-range" className="min-w-[7.5rem] text-center text-textSecondary">
          {fmtDate(first)} – {fmtDate(last)}
        </span>
        <button id="calendar-forward" type="button" aria-label="four weeks on" className={NAV} disabled={page === 0} onClick={() => void loadCalendar(name, page - 1)}>
          ›
        </button>
        {page > 0 && (
          <button id="calendar-today" type="button" className={NAV} onClick={() => void loadCalendar(name, 0)}>
            today
          </button>
        )}
      </div>

      <div id="calendar-strip" className="relative mt-3 border-b border-primaryStroke">
        <div aria-hidden className="pointer-events-none absolute inset-y-0 right-0" style={{ left: LABEL_W }}>
          {[25, 50, 75].map((p) => (
            <span key={p} className="absolute inset-y-0 border-l border-primaryStroke" style={{ left: `${p}%` }} />
          ))}
        </div>
        {byDay.spans.map((spans, d) => {
          const day = addDays(first, d);
          const isToday = day.getTime() === today.getTime();
          const monday = day.getDay() === 1;
          return (
            <div
              key={d}
              className={cn('grid h-[15px] border-t', monday ? 'border-secondaryStroke' : 'border-primaryStroke')}
              style={{ gridTemplateColumns: `${LABEL_W}px minmax(0, 1fr)` }}
            >
              <span
                className={cn(
                  'whitespace-nowrap pr-1.5 text-[10px] leading-[14px]',
                  isToday ? 'font-semibold text-textPrimary' : monday ? 'text-textSecondary' : 'text-textTertiary'
                )}
              >
                {isToday ? 'today' : fmtRow(day)}
              </span>
              <div className="relative">
                {spans.map((s, i) => {
                  const b = s.block;
                  const detail = detailOf(b, now);
                  return (
                    <Tooltip key={`${b.id}-${i}`} content={detail} at="top">
                      <button
                        type="button"
                        aria-label={detail}
                        data-live={b.live || undefined}
                        data-uncertain={b.uncertain || undefined}
                        data-start={b.start.toISOString()}
                        data-end={b.end?.toISOString()}
                        className={cn(
                          'block absolute inset-y-[2px] cursor-default border-0 p-0 outline-offset-1 focus-visible:outline focus-visible:outline-1 focus-visible:outline-textPrimary',
                          b.uncertain ? 'bg-textTertiary' : 'bg-primaryBlue',
                          s.last && b.live && 'border-r-2 border-solid border-textPrimary',
                          s.last && b.uncertain && 'border-r-[3px] border-dashed border-textSecondary'
                        )}
                        style={{ left: pct(s.from), width: `max(2px, ${((s.to - s.from) / 1440) * 100}%)` }}
                      />
                    </Tooltip>
                  );
                })}
                {byDay.drops
                  .filter((x) => x.day === d)
                  .map((x, i) => (
                    <span key={i} aria-hidden className="drop pointer-events-none absolute inset-y-[2px] w-[2px] bg-decrease" style={{ left: pct(x.min) }} />
                  ))}
              </div>
            </div>
          );
        })}
      </div>

      <div aria-hidden className="relative h-4 text-[10px] text-textTertiary" style={{ marginLeft: LABEL_W }}>
        {HOURS.map(([p, label]) => (
          <span key={p} className="absolute" style={{ left: `${p}%`, transform: p === 0 ? undefined : p === 100 ? 'translateX(-100%)' : 'translateX(-50%)' }}>
            {label}
          </span>
        ))}
      </div>

      {newest && (
        <p id="calendar-last" className="mt-1.5 text-base text-textSecondary">
          {newest.live ? 'live now' : 'last streamed'} · {detailOf(newest, now)}
        </p>
      )}

      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-textTertiary">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-2 w-2.5 bg-primaryBlue" />
          streamed
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-2 w-[2px] bg-decrease" />
          dropped and back inside five minutes
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-2 w-3.5 border-r-[3px] border-dashed border-textSecondary bg-textTertiary" />
          ended by the sweeper
        </span>
      </div>
    </div>
  );
}
