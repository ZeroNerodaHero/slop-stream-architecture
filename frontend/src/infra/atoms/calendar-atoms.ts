/**
 * The calendar on the watch page (docs/calendar.md): a week of the name's sessions from
 * `GET /api/streamers/:name/sessions?from=&to=`, as rows; `Calendar.tsx` turns them into blocks
 * in the viewer's zone. A week runs monday to sunday: `page` 0 is the one with today in it, 1
 * the week before, and so on. The rows are asked again when the stream on screen starts or
 * ends, so the open block appears and closes with no reload, and when the grid is opened on
 * another name or another page. The profile popup (ProfilePopup.tsx) has the same grid for
 * whoever it is about, over a page that may be showing its own: each has its own rows
 * (`CalendarScope`), so the one does not blank the other.
 */

import { atom, type PrimitiveAtom } from 'jotai';

import { api, type SessionRow } from '@/infra/api';
import { watchNameAtom, watchPhaseAtom, type WatchPhase } from '@/infra/atoms/watch-atoms';
import { addDays, DAYS, mondayOf } from '@/infra/calendar';
import { store } from '@/infra/store';

export type CalendarPhase = 'loading' | 'ready' | 'failed';

export interface CalendarState {
  name: string;
  page: number;
  rows: SessionRow[];
  phase: CalendarPhase;
  /** When the rows landed, ms. The grid's clock is at least this, so a block that opened since its minute tick is drawn from its start. */
  at: number;
}

/** Whose grid: the watch page's, or the profile popup's over it. */
export type CalendarScope = 'page' | 'popup';

const blank = (): CalendarState => ({ name: '', page: 0, rows: [], phase: 'loading', at: 0 });
const calendars: Record<CalendarScope, PrimitiveAtom<CalendarState>> = { page: atom(blank()), popup: atom(blank()) };

/** The watch page's grid. */
export const calendarAtom = calendars.page;

/** The grid of one scope: `calendarAtom` for the page, the popup's own for the popup. */
export function calendarAtomOf(scope: CalendarScope): PrimitiveAtom<CalendarState> {
  return calendars[scope];
}

/** The week `page` names: monday to sunday, `[first, first + 7 days)`, `first` the monday's local midnight. */
export function rangeOf(page: number, now: Date): { first: Date; last: Date; from: Date; to: Date } {
  const first = addDays(mondayOf(now), -page * DAYS);
  return { first, last: addDays(first, DAYS - 1), from: first, to: addDays(first, DAYS) };
}

const asking: Record<CalendarScope, number> = { page: 0, popup: 0 };

/** The rows for `name`'s `page`, into the grid of `scope`. A newer ask for that grid wins; the one it overtook is dropped when it lands. */
export async function loadCalendar(name: string, page: number, scope: CalendarScope = 'page'): Promise<void> {
  const grid = calendars[scope];
  const mine = ++asking[scope];
  const before = store.get(grid);
  // a page turn keeps the old rows on screen while the new ones come; a new name starts blank
  store.set(grid, { name, page, rows: before.name === name ? before.rows : [], phase: 'loading', at: before.at });
  const { from, to } = rangeOf(page, new Date());
  try {
    const rows = await api.sessions(name, from, to);
    if (mine !== asking[scope]) return;
    store.set(grid, { name, page, rows, phase: 'ready', at: Date.now() });
  } catch {
    if (mine !== asking[scope]) return;
    const was = store.get(grid);
    store.set(grid, { name, page, rows: was.rows, phase: 'failed', at: was.at });
  }
}

/** The phases in which a stream is up: the block on today's row is open and growing. */
const LIVE_PHASES: readonly WatchPhase[] = ['connecting', 'connected', 'watching', 'reconnecting'];

export const watchIsLiveAtom = atom((get) => LIVE_PHASES.includes(get(watchPhaseAtom)));

/** An end reaches the watcher from video a beat before the api has written `ended_at`: ask once more after this. */
const SETTLE_MS = 3000;

// the stream on screen started or ended: the current week again, so the block opens or
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
