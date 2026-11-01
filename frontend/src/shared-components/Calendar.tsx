import { useAtomValue } from 'jotai';
import { useEffect, useState } from 'react';

import { calendarAtom, loadCalendar, rangeOf, watchIsLiveAtom } from '@/infra/atoms/calendar-atoms';
import { addDays, blocksOf, columnsOf, DAYS, detailOf, fmtClock, fmtDate, fmtDow, fmtDur, lengthOf, localMidnight, MIN_MS, totalOf, usuallyOf } from '@/infra/calendar';
import { buttonClassName } from '@/shared-components/Button';
import { cn } from '@/utils/cn';

/** The hour labels' column, px. The day columns start after it. */
const LABEL_W = 36;
/** An hour's height, px: the grid is 24 of these, and a one-hour stream is a bar this tall. */
const HOUR_PX = 12;
/**
 * A bar is at least this tall, so its length is readable on it: a stream shorter than this
 * draws a little longer than it ran, and the number on it is what ran.
 */
const MIN_PX = 14;
/** The hour lines and their labels: every three hours. */
const HOURS = [0, 3, 6, 9, 12, 15, 18, 21];
const NAV = buttonClassName('secondary', 'px-2 py-0.5 text-xs');
const COLUMNS = { gridTemplateColumns: `${LABEL_W}px repeat(${DAYS}, minmax(0, 1fr))` };

function pct(min: number): string {
  return `${(min / 1440) * 100}%`;
}

/**
 * When they stream (docs/calendar.md): a week of day columns, monday first, and the hours of
 * the day down the side, midnight at the top. A stream is a bar in its day's column from its
 * start hour to its end hour, with how long it ran written on it. Days across and hours down
 * on purpose: every 8pm is the same height, so a person who streams at 8 is a row of bars you
 * see before you read anything. The line above the grid says it in words. Everything is the
 * viewer's clock and zone: a block over the viewer's midnight is two pieces in two columns,
 * the longer of them carrying the length. A connection that dropped and was back inside five
 * minutes is nothing to see: the two sessions are one bar, the gap inside it and counted. Bars
 * are the accent; one the sweeper closed is grey with a dashed end (its end is the last
 * heartbeat). The open bar ends at a line that moves, once a minute.
 */
export function Calendar({ name }: { name: string }) {
  const cal = useAtomValue(calendarAtom);
  const live = useAtomValue(watchIsLiveAtom);
  // the clock, in state: a render must not read one. once a minute the open block grows a step
  const [tick, setTick] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setTick(new Date()), MIN_MS);
    return () => clearInterval(t);
  }, []);
  // and never behind the rows: a block that opened since the last tick is drawn from its start, not a minute later
  const now = cal.at > tick.getTime() ? new Date(cal.at) : tick;
  // the week with today in it, for this name, each time the grid is shown: one request per open
  useEffect(() => {
    void loadCalendar(name, 0);
  }, [name]);

  const mine = cal.name === name;
  const page = mine ? cal.page : 0;
  const rows = mine ? cal.rows : [];
  const { first, last } = rangeOf(page, now);
  const today = localMidnight(now);
  // a thousand rows at most, laid out on 7 days: cheap enough to do on every render (a render is an
  // atom change or the minute tick)
  const blocks = blocksOf(rows, live, now);
  const columns = columnsOf(blocks, first, now);

  const newest = blocks[blocks.length - 1];
  const total = totalOf(blocks, now);

  return (
    <div id="calendar" data-page={page} data-phase={mine ? cal.phase : 'loading'}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span id="calendar-usually" className="font-semibold">
          {mine && cal.phase === 'ready' ? usuallyOf(blocks, first, now) : mine && cal.phase === 'failed' ? 'cannot load the calendar' : 'loading'}
        </span>
        <span className="text-sm text-textTertiary">your time</span>
        {blocks.length > 0 && (
          <span id="calendar-total" className="ml-auto text-base text-textSecondary">
            {blocks.length} {blocks.length === 1 ? 'stream' : 'streams'} · {fmtDur(total)}
          </span>
        )}
      </div>

      <div className="mt-3 flex items-center gap-2 text-base">
        <button id="calendar-back" type="button" aria-label="a week back" className={NAV} onClick={() => void loadCalendar(name, page + 1)}>
          ‹
        </button>
        <span id="calendar-range" className="min-w-[7.5rem] text-center text-textSecondary">
          {fmtDate(first)} – {fmtDate(last)}
        </span>
        <button id="calendar-forward" type="button" aria-label="a week on" className={NAV} disabled={page === 0} onClick={() => void loadCalendar(name, page - 1)}>
          ›
        </button>
        {page > 0 && (
          <button id="calendar-today" type="button" className={NAV} onClick={() => void loadCalendar(name, 0)}>
            today
          </button>
        )}
      </div>

      <div id="calendar-strip" className="mt-3">
        {/* the days' heads, today's the bright one: the weekday over the date where the columns are narrow, beside it where they are not */}
        <div className="grid" style={COLUMNS}>
          <span />
          {columns.map((_, d) => {
            const day = addDays(first, d);
            const isToday = day.getTime() === today.getTime();
            return (
              <span
                key={d}
                data-day-head
                className={cn(
                  'flex flex-col items-center pb-1 text-xs leading-tight sm:flex-row sm:justify-center sm:gap-1',
                  isToday ? 'font-semibold text-textPrimary' : 'text-textTertiary'
                )}
              >
                <span>{fmtDow(day)}</span>
                <span>{day.getDate()}</span>
              </span>
            );
          })}
        </div>
        {/* the hours down the side, a column per day: a bar from its start to its end, its length on it */}
        <div className="relative grid border-y border-r border-primaryStroke" style={{ ...COLUMNS, height: 24 * HOUR_PX }}>
          <div aria-hidden className="relative text-[10px] leading-none text-textTertiary">
            {HOURS.map((h) => (
              <span key={h} className="absolute right-1.5 -translate-y-1/2" style={{ top: pct(h * 60) }}>
                {fmtClock(h, 0)}
              </span>
            ))}
          </div>
          {columns.map((spans, d) => {
            const day = addDays(first, d);
            const isToday = day.getTime() === today.getTime();
            return (
              <div key={d} data-day={d} className={cn('relative border-l border-primaryStroke', isToday && 'bg-backgroundSecondary')}>
                {HOURS.slice(1).map((h) => (
                  <span key={h} aria-hidden className="pointer-events-none absolute inset-x-0 border-t border-primaryStroke" style={{ top: pct(h * 60) }} />
                ))}
                {spans.map((s) => {
                  const b = s.block;
                  const height = `max(${MIN_PX}px, ${pct(s.to - s.from)})`;
                  // a piece that runs to midnight hangs from the bottom, so the least height grows it up into its day and not out of it
                  const at = s.to >= 1440 ? { bottom: 0, height } : { top: pct(s.from), height };
                  return (
                    <div
                      key={`${b.id}-${s.day}`}
                      role="img"
                      aria-label={detailOf(b, now)}
                      data-block
                      data-live={b.live || undefined}
                      data-uncertain={b.uncertain || undefined}
                      data-start={b.start.toISOString()}
                      data-end={b.end?.toISOString()}
                      className={cn(
                        'absolute inset-x-[3px] overflow-hidden px-0.5 pt-[2px] text-[10px] font-semibold leading-none text-background sm:px-1',
                        b.uncertain ? 'bg-textTertiary' : 'bg-primaryBlue',
                        s.last && b.live && 'border-b-2 border-solid border-textPrimary',
                        s.last && b.uncertain && 'border-b-2 border-dashed border-textSecondary'
                      )}
                      style={at}
                    >
                      {s.label && fmtDur(lengthOf(b, now))}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>

      {newest && (
        <p id="calendar-last" className="mt-1.5 text-base text-textSecondary">
          {newest.live ? 'live now' : 'last streamed'} · {detailOf(newest, now)}
        </p>
      )}

      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-textTertiary">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-3 w-2 bg-primaryBlue" />
          streamed
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-4 w-2 border-b-2 border-dashed border-textSecondary bg-textTertiary" />
          ended by the sweeper
        </span>
      </div>
    </div>
  );
}
