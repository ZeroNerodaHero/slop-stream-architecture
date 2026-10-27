/**
 * The calendar on the watch page (docs/calendar.md): four weeks of the name's sessions from
 * `GET /api/streamers/:name/sessions?from=&to=`, as rows; `Calendar.tsx` turns them into blocks
 * in the viewer's zone. `page` 0 is the four weeks ending today, 1 the four before, and so on.
 * The rows are asked again when the stream on screen starts or ends, so the open block appears
 * and closes with no reload, and when the strip is opened on another name or another page.
 */

import { atom } from 'jotai';

import { api, type SessionRow } from '@/infra/api';
import { watchNameAtom, watchPhaseAtom, type WatchPhase } from '@/infra/atoms/watch-atoms';
import { addDays, DAYS, localMidnight } from '@/infra/calendar';
import { store } from '@/infra/store';

export type CalendarPhase = 'loading' | 'ready' | 'failed';

export interface CalendarState {
  name: string;
  page: number;
  rows: SessionRow[];
  phase: CalendarPhase;
}

export const calendarAtom = atom<CalendarState>({ name: '', page: 0, rows: [], phase: 'loading' });

/** The four weeks `page` names: `[first, first + 28 days)`, `first` a local midnight. */
export function rangeOf(page: number, now: Date): { first: Date; last: Date; from: Date; to: Date } {
  const today = localMidnight(now);
  const first = addDays(today, -(DAYS - 1) - page * DAYS);
  return { first, last: addDays(first, DAYS - 1), from: first, to: addDays(first, DAYS) };
}

let asking = 0;

/** The rows for `name`'s `page`. A newer ask wins; the one it overtook is dropped when it lands. */
export async function loadCalendar(name: string, page: number): Promise<void> {
  const mine = ++asking;
  const before = store.get(calendarAtom);
  // a page turn keeps the old rows on screen while the new ones come; a new name starts blank
  store.set(calendarAtom, { name, page, rows: before.name === name ? before.rows : [], phase: 'loading' });
  const { from, to } = rangeOf(page, new Date());
  try {
    const rows = await api.sessions(name, from, to);
    if (mine !== asking) return;
    store.set(calendarAtom, { name, page, rows, phase: 'ready' });
  } catch {
    if (mine !== asking) return;
    store.set(calendarAtom, { name, page, rows: store.get(calendarAtom).rows, phase: 'failed' });
  }
}

/** The phases in which a stream is up: the block on today's row is open and growing. */
const LIVE_PHASES: readonly WatchPhase[] = ['connecting', 'connected', 'watching', 'reconnecting'];

export const watchIsLiveAtom = atom((get) => LIVE_PHASES.includes(get(watchPhaseAtom)));

/** An end reaches the watcher from video a beat before the api has written `ended_at`: ask once more after this. */
const SETTLE_MS = 3000;

// the stream on screen started or ended: the current four weeks again, so the block opens or
// closes without a reload. only once the strip has asked for this name (a page with no calendar
// open makes no request)
let wasLive = store.get(watchIsLiveAtom);
store.sub(watchIsLiveAtom, () => {
  const live = store.get(watchIsLiveAtom);
  if (live === wasLive) return;
  wasLive = live;
  const cal = store.get(calendarAtom);
  if (!cal.name || cal.name !== store.get(watchNameAtom) || cal.page !== 0) return;
  void loadCalendar(cal.name, 0);
  if (!live) {
    setTimeout(() => {
      const now = store.get(calendarAtom);
      if (now.name === cal.name && now.page === 0 && !store.get(watchIsLiveAtom)) void loadCalendar(cal.name, 0);
    }, SETTLE_MS);
  }
});
