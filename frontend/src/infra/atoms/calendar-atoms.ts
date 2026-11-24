import { atom, type PrimitiveAtom } from 'jotai';

import { api, type SessionRow } from '@/infra/api';
import { watchNameAtom, watchPhaseAtom, type WatchPhase } from '@/infra/atoms/watch-state';
import { addDays, DAYS, mondayOf } from '@/infra/calendar';
import { store } from '@/infra/store';

export type CalendarPhase = 'loading' | 'ready' | 'failed';

export interface CalendarState {
  name: string;
  page: number;
  rows: SessionRow[];
  phase: CalendarPhase;
  at: number;
}

export type CalendarScope = 'page' | 'popup';

const blank = (): CalendarState => ({ name: '', page: 0, rows: [], phase: 'loading', at: 0 });
const calendars: Record<CalendarScope, PrimitiveAtom<CalendarState>> = { page: atom(blank()), popup: atom(blank()) };

export const calendarAtom = calendars.page;

export function calendarAtomOf(scope: CalendarScope): PrimitiveAtom<CalendarState> {
  return calendars[scope];
}

export function rangeOf(page: number, now: Date): { first: Date; last: Date; from: Date; to: Date } {
  const first = addDays(mondayOf(now), -page * DAYS);
  return { first, last: addDays(first, DAYS - 1), from: first, to: addDays(first, DAYS) };
}

const asking: Record<CalendarScope, number> = { page: 0, popup: 0 };

export async function loadCalendar(name: string, page: number, scope: CalendarScope = 'page'): Promise<void> {
  const grid = calendars[scope];
  const mine = ++asking[scope];
  const before = store.get(grid);
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

const LIVE_PHASES: readonly WatchPhase[] = ['connecting', 'connected', 'watching', 'reconnecting'];

export const watchIsLiveAtom = atom((get) => LIVE_PHASES.includes(get(watchPhaseAtom)));

const SETTLE_MS = 3000;

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
