/**
 * The calendar's arithmetic (docs/calendar.md): the api's session rows become blocks (sessions
 * merged across a gap under five minutes: one stream whose connection dropped, as long as the
 * whole, gap and all), blocks become pieces on day columns (cut at the viewer's midnights), and
 * a week of blocks becomes the line `streamed tuesday and thursday around 8pm`. Pure; the
 * viewer's clock and zone come in as arguments, and nothing here reads one.
 */

import type { SessionRow } from '@/infra/api';

export const MIN_MS = 60_000;
export const DAY_MS = 24 * 60 * MIN_MS;
/** The grid: a week, monday the first column. */
export const DAYS = 7;
/** Two sessions closer than this are one stream whose connection dropped: one block, the gap inside it and counted. */
export const GAP_MS = 5 * MIN_MS;
/** A session shorter than this is a go-live whose negotiation failed. The log keeps it; the grid does not draw it. */
export const FLOOR_MS = MIN_MS;

export interface Block {
  /** The first session's id: the key. */
  id: number;
  start: Date;
  /** Null: still open, drawn to now. */
  end: Date | null;
  /** The sweeper closed the last session: its end is the last heartbeat, within one beat of the truth. */
  uncertain: boolean;
  /** Open under a name that is live now. */
  live: boolean;
}

/** A block's piece on one day column, in minutes from that day's midnight. */
export interface Span {
  block: Block;
  /** The column, 0 the week's monday. */
  day: number;
  from: number;
  to: number;
  /** The block's last piece: the one its end is drawn on. */
  last: boolean;
  /** The block's longest piece on the grid: the one that says how long the whole ran. */
  label: boolean;
}

export function localMidnight(d: Date): Date {
  const m = new Date(d);
  m.setHours(0, 0, 0, 0);
  return m;
}

export function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

/** The monday of the week `d` is in, a local midnight. A week runs monday to sunday. */
export function mondayOf(d: Date): Date {
  return addDays(localMidnight(d), -((d.getDay() + 6) % 7));
}

/**
 * The rows as blocks, oldest first. A row still open belongs to a name that is live (`live`),
 * and runs to now; otherwise it is waiting for the sweeper and ends at its last heartbeat,
 * marked. Sessions a short gap apart merge into one block from the first's start to the last's
 * end, so twenty minutes, three down and twenty more is one block of 43; blocks under the floor
 * are dropped, except the live one: a stream that is on is not a negotiation that failed, and
 * is drawn from its first second.
 */
export function blocksOf(rows: SessionRow[], live: boolean, now: Date): Block[] {
  const sessions = rows
    .map((r) => ({
      id: r.id,
      start: new Date(r.started_at),
      end: r.ended_at ? new Date(r.ended_at) : live ? null : new Date(r.last_beat_at ?? r.started_at),
      by: r.ended_at ? (r.ended_by ?? null) : live ? null : 'sweep'
    }))
    .filter((s) => !Number.isNaN(s.start.getTime()))
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  const blocks: Block[] = [];
  for (const s of sessions) {
    const last = blocks[blocks.length - 1];
    const lastEnd = last && !last.live ? (last.end ?? now) : null;
    if (last && lastEnd && s.start.getTime() - lastEnd.getTime() < GAP_MS) {
      last.end = s.end;
      last.live = s.end === null;
      last.uncertain = s.by === 'sweep';
    } else {
      blocks.push({ id: s.id, start: s.start, end: s.end, uncertain: s.by === 'sweep', live: s.end === null });
    }
  }
  return blocks.filter((b) => b.live || lengthOf(b, now) >= FLOOR_MS);
}

/**
 * The block cut at the viewer's midnights: one piece per day column it touches, columns counted
 * from `first` (a local midnight), the longest of them marked to carry the block's length.
 */
export function spansOf(b: Block, first: Date, now: Date): Span[] {
  const spans: Span[] = [];
  const end = endOf(b, now);
  let cursor = b.start;
  // at least one piece: a block that opened this second has no length yet, and is drawn at the least height
  do {
    const dayStart = localMidnight(cursor);
    const next = addDays(dayStart, 1);
    const to = end < next ? end : next;
    const day = Math.round((dayStart.getTime() - first.getTime()) / DAY_MS);
    if (day >= 0 && day < DAYS) {
      spans.push({
        block: b,
        day,
        from: (cursor.getTime() - dayStart.getTime()) / MIN_MS,
        to: Math.min(1440, (to.getTime() - dayStart.getTime()) / MIN_MS),
        last: to.getTime() === end.getTime(),
        label: false
      });
    }
    cursor = next;
  } while (cursor < end);
  const longest = spans.reduce<Span | null>((best, s) => (!best || s.to - s.from > best.to - best.from ? s : best), null);
  if (longest) longest.label = true;
  return spans;
}

/** The grid's columns: every block's pieces by day. `first` is column 0's midnight, the week's monday. */
export function columnsOf(blocks: Block[], first: Date, now: Date): Span[][] {
  const columns: Span[][] = Array.from({ length: DAYS }, () => []);
  for (const b of blocks) for (const span of spansOf(b, first, now)) columns[span.day]?.push(span);
  return columns;
}

const SHORT_DAY = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const LONG_DAY = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const SHORT_MONTH = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export function fmtClock(h: number, m: number): string {
  const ap = h < 12 ? 'am' : 'pm';
  const hh = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${hh}${ap}` : `${hh}:${String(m).padStart(2, '0')}${ap}`;
}

export function fmtTime(d: Date): string {
  return fmtClock(d.getHours(), d.getMinutes());
}

/** `tue oct 14` */
export function fmtDay(d: Date): string {
  return `${SHORT_DAY[d.getDay()]} ${SHORT_MONTH[d.getMonth()]} ${d.getDate()}`;
}

/** `oct 14` */
export function fmtDate(d: Date): string {
  return `${SHORT_MONTH[d.getMonth()]} ${d.getDate()}`;
}

/** `tue`, the column's head over its date. */
export function fmtDow(d: Date): string {
  return SHORT_DAY[d.getDay()] ?? '';
}

/** `3h 14m`, `45m`, `2h` */
export function fmtDur(ms: number): string {
  const m = Math.round(ms / MIN_MS);
  const h = Math.floor(m / 60);
  if (h === 0) return `${m}m`;
  return m % 60 === 0 ? `${h}h` : `${h}h ${m % 60}m`;
}

function listOf(words: string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/**
 * The line read off the week's blocks: the days with one, monday first (`first` is the first
 * column's midnight; a block that began before it is in that column, so it counts there), and
 * the median start rounded to the half hour. One week is too short to call a habit, so the line
 * says what happened: `streamed tuesday and thursday around 8pm`. The week that has today in it
 * is `this week`; an older page is `that week`.
 */
export function usuallyOf(blocks: Block[], first: Date, now: Date): string {
  const current = localMidnight(now) < addDays(first, DAYS);
  if (blocks.length === 0) return current ? 'has not streamed this week' : 'did not stream that week';
  const dows = new Set(blocks.map((b) => (b.start < first ? first : b.start).getDay()));
  const days = Array.from({ length: DAYS }, (_, i) => addDays(first, i).getDay()).filter((d) => dows.has(d));
  const mins = blocks.map((b) => b.start.getHours() * 60 + b.start.getMinutes()).sort((a, b) => a - b);
  const median = mins[Math.floor(mins.length / 2)] ?? 0;
  const rounded = Math.round(median / 30) * 30;
  const when = fmtClock(Math.floor(rounded / 60) % 24, rounded % 60);
  const on = days.length === DAYS ? 'every day' : listOf(days.map((d) => LONG_DAY[d] ?? ''));
  return `streamed ${on} around ${when}`;
}

/**
 * Where the block ends: its end, or now for the open one. Never before its start: the viewer's
 * clock can sit a second behind the api's, and the open block then began a moment from now.
 */
export function endOf(b: Block, now: Date): Date {
  return b.end ?? (now > b.start ? now : b.start);
}

/** The block's length, the open one counted to now. */
export function lengthOf(b: Block, now: Date): number {
  return endOf(b, now).getTime() - b.start.getTime();
}

/** What a block says of itself: the day, the hours, the length, how sure its end is. */
export function detailOf(b: Block, now: Date): string {
  const end = endOf(b, now);
  const parts = [
    localMidnight(b.start).getTime() === localMidnight(now).getTime() ? 'today' : fmtDay(b.start),
    `${fmtTime(b.start)} – ${b.live ? 'now' : fmtTime(end)}`,
    fmtDur(lengthOf(b, now))
  ];
  if (b.uncertain) parts.push('ended by the sweeper, so the end is the last heartbeat');
  if (b.live) parts.push('live');
  return parts.join(' · ');
}

/** The blocks' total length, the open one counted to now. */
export function totalOf(blocks: Block[], now: Date): number {
  return blocks.reduce((ms, b) => ms + lengthOf(b, now), 0);
}
