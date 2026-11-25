import { type RefObject, useEffect } from 'react';

export type View = 'full' | 'small' | 'hidden';

export const HIDE_AFTER_MS = 2000;

export interface Player {
  small: boolean;
  seen: boolean;
}

export function viewOf(pageHidden: boolean, players: Iterable<Player>): View {
  let any = false;
  let small = false;
  for (const p of players) {
    any = true;
    if (!p.seen) continue;
    if (!p.small) return 'full';
    small = true;
  }
  if (!any) return pageHidden ? 'hidden' : 'full';
  if (small) return 'small';
  return 'hidden';
}

export function viewFrame(view: View): string {
  return JSON.stringify({ view });
}

interface Timers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

export class ViewSender {
  private sent: View = 'full';
  private hiding: unknown = null;
  private readonly send: (view: View) => void;
  private readonly timers: Timers;
  private readonly hideAfterMs: number;

  constructor(send: (view: View) => void, timers: Timers = realTimers, hideAfterMs = HIDE_AFTER_MS) {
    this.send = send;
    this.timers = timers;
    this.hideAfterMs = hideAfterMs;
  }

  update(view: View) {
    if (view === 'hidden') {
      if (this.sent === 'hidden' || this.hiding !== null) return;
      this.hiding = this.timers.set(() => {
        this.hiding = null;
        this.put('hidden');
      }, this.hideAfterMs);
      return;
    }
    this.cancel();
    this.put(view);
  }

  reset() {
    this.cancel();
    this.sent = 'full';
  }

  private cancel() {
    if (this.hiding === null) return;
    this.timers.clear(this.hiding);
    this.hiding = null;
  }

  private put(view: View) {
    if (view === this.sent) return;
    this.sent = view;
    this.send(view);
  }
}

interface Entry {
  small: boolean;
  fixed: boolean;
  target: () => Element | null;
  inView: boolean;
}

const entries = new Set<Entry>();
const listeners = new Set<(view: View) => void>();
let observer: IntersectionObserver | null = null;
const observed = new Map<Element, Entry>();

function seen(entry: Entry): boolean {
  const doc = entry.target()?.ownerDocument ?? document;
  if (doc.visibilityState === 'hidden') return false;
  return entry.fixed || entry.inView;
}

export function currentView(): View {
  return viewOf(
    document.visibilityState === 'hidden',
    [...entries].map((e) => ({ small: e.small, seen: seen(e) }))
  );
}

function changed() {
  const view = currentView();
  for (const fn of listeners) fn(view);
}

export function onViewChange(fn: (view: View) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function observe(entry: Entry) {
  const el = entry.target();
  if (!el || typeof IntersectionObserver === 'undefined') return;
  observer ??= new IntersectionObserver((records) => {
    for (const r of records) {
      const e = observed.get(r.target);
      if (e) e.inView = r.isIntersecting;
    }
    changed();
  });
  observed.set(el, entry);
  observer.observe(el);
}

function unobserve(entry: Entry) {
  for (const [el, e] of observed) {
    if (e !== entry) continue;
    observer?.unobserve(el);
    observed.delete(el);
  }
}

export function showsWatch(target: () => Element | null, { small, fixed }: { small: boolean; fixed: boolean }): () => void {
  const entry: Entry = { small, fixed, target, inView: true };
  entries.add(entry);
  if (!fixed) observe(entry);
  changed();
  return () => {
    unobserve(entry);
    entries.delete(entry);
    changed();
  };
}

export function useShowsWatch(ref: RefObject<Element | null>, on: boolean, { small, fixed }: { small: boolean; fixed: boolean }) {
  useEffect(() => {
    if (!on) return;
    return showsWatch(() => ref.current, { small, fixed });
  }, [ref, on, small, fixed]);
}

if (typeof document !== 'undefined') document.addEventListener('visibilitychange', changed);
