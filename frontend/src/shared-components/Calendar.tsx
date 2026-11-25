import { useAtomValue } from 'jotai';
import { useEffect, useState } from 'react';

import { type CalendarScope, calendarAtomOf, loadCalendar, rangeOf, watchIsLiveAtom } from '@/infra/atoms/calendar-atoms';
import { addDays, blocksOf, columnsOf, DAYS, detailOf, fmtClock, fmtDate, fmtDow, fmtDur, lengthOf, localMidnight, MIN_MS, totalOf, usuallyOf } from '@/infra/calendar';
import { buttonClassName } from '@/shared-components/Button';
import { cn } from '@/utils/cn';

const LABEL_W = 36;
const HOUR_PX = 12;
const MIN_PX = 14;
const HOURS = [0, 3, 6, 9, 12, 15, 18, 21];
const NAV = buttonClassName('secondary', 'px-2 py-0.5 text-xs');
const COLUMNS = { gridTemplateColumns: `${LABEL_W}px repeat(${DAYS}, minmax(0, 1fr))` };

function pct(min: number): string {
  return `${(min / 1440) * 100}%`;
}

interface CalendarProps {
  name: string;
  scope?: CalendarScope;
  live?: boolean;
  id?: string;
}

export function Calendar({ name, scope = 'page', live: said, id = 'calendar' }: CalendarProps) {
  const cal = useAtomValue(calendarAtomOf(scope));
  const watching = useAtomValue(watchIsLiveAtom);
  const live = said ?? watching;
  const [tick, setTick] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setTick(new Date()), MIN_MS);
    return () => clearInterval(t);
  }, []);
  const now = cal.at > tick.getTime() ? new Date(cal.at) : tick;
  useEffect(() => {
    void loadCalendar(name, 0, scope);
  }, [name, scope]);

  const mine = cal.name === name;
  const page = mine ? cal.page : 0;
  const rows = mine ? cal.rows : [];
  const { first, last } = rangeOf(page, now);
  const today = localMidnight(now);
  const blocks = blocksOf(rows, live, now);
  const columns = columnsOf(blocks, first, now);

  const newest = blocks[blocks.length - 1];
  const total = totalOf(blocks, now);

  return (
    <div id={id} data-page={page} data-phase={mine ? cal.phase : 'loading'}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span id={`${id}-usually`} className="font-semibold">
          {mine && cal.phase === 'ready' ? usuallyOf(blocks, first, now) : mine && cal.phase === 'failed' ? 'cannot load the calendar' : 'loading'}
        </span>
        <span className="text-sm text-textTertiary">your time</span>
        {blocks.length > 0 && (
          <span id={`${id}-total`} className="ml-auto text-base text-textSecondary">
            {blocks.length} {blocks.length === 1 ? 'stream' : 'streams'} · {fmtDur(total)}
          </span>
        )}
      </div>

      <div className="mt-3 flex items-center gap-2 text-base">
        <button id={`${id}-back`} type="button" aria-label="a week back" className={NAV} onClick={() => void loadCalendar(name, page + 1, scope)}>
          ‹
        </button>
        <span id={`${id}-range`} className="min-w-[7.5rem] text-center text-textSecondary">
          {fmtDate(first)} – {fmtDate(last)}
        </span>
        <button id={`${id}-forward`} type="button" aria-label="a week on" className={NAV} disabled={page === 0} onClick={() => void loadCalendar(name, page - 1, scope)}>
          ›
        </button>
        {page > 0 && (
          <button id={`${id}-today`} type="button" className={NAV} onClick={() => void loadCalendar(name, 0, scope)}>
            today
          </button>
        )}
      </div>

      <div id={`${id}-strip`} className="mt-3">
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
                        'absolute inset-x-[3px] overflow-hidden px-0.5 soft:rounded-[3px] bubble:rounded-[6px] pt-[2px] text-[10px] font-semibold leading-none text-background sm:px-1',
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
        <p id={`${id}-last`} className="mt-1.5 text-base text-textSecondary">
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
