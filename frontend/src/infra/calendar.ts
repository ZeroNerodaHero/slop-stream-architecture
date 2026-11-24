import type { SessionRow } from '@/infra/api';

export const MIN_MS = 60_000;
export const DAY_MS = 24 * 60 * MIN_MS;
export const DAYS = 7;
export const GAP_MS = 5 * MIN_MS;
export const FLOOR_MS = MIN_MS;

export interface Block {
  id: number;
  start: Date;
  end: Date | null;
  uncertain: boolean;
  live: boolean;
}

export interface Span {
  block: Block;
  day: number;
  from: number;
  to: number;
  last: boolean;
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

export function mondayOf(d: Date): Date {
  return addDays(localMidnight(d), -((d.getDay() + 6) % 7));
}

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

export function spansOf(b: Block, first: Date, now: Date): Span[] {
  const spans: Span[] = [];
  const end = endOf(b, now);
  let cursor = b.start;
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

export function fmtDay(d: Date): string {
  return `${SHORT_DAY[d.getDay()]} ${SHORT_MONTH[d.getMonth()]} ${d.getDate()}`;
}

export function fmtDate(d: Date): string {
  return `${SHORT_MONTH[d.getMonth()]} ${d.getDate()}`;
}

export function fmtDow(d: Date): string {
  return SHORT_DAY[d.getDay()] ?? '';
}

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

export function endOf(b: Block, now: Date): Date {
  return b.end ?? (now > b.start ? now : b.start);
}

export function lengthOf(b: Block, now: Date): number {
  return endOf(b, now).getTime() - b.start.getTime();
}

export function detailOf(b: Block, now: Date): string {
  const end = endOf(b, now);
  const parts = [
    localMidnight(b.start).getTime() === localMidnight(now).getTime() ? 'today' : fmtDay(b.start),
    `${fmtTime(b.start)} – ${b.live ? 'now' : fmtTime(end)}`,
    fmtDur(lengthOf(b, now))
  ];
  if (b.uncertain) parts.push('stream ended');
  if (b.live) parts.push('live');
  return parts.join(' · ');
}

export function totalOf(blocks: Block[], now: Date): number {
  return blocks.reduce((ms, b) => ms + lengthOf(b, now), 0);
}
