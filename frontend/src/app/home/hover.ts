export const HOVER_DWELL_MS = 300;
export const HOVER_GRACE_MS = 400;

export interface HoverTimers {
  setTimeout: (fn: () => void, ms: number) => number;
  clearTimeout: (id: number) => void;
}

export type SetHover = (next: string | null | ((current: string | null) => string | null)) => void;

export interface HoverPreview {
  enter: (name: string, pointer: string, hover: string | null) => void;
  leave: (name: string) => void;
  dispose: () => void;
}

export function hoverPreview(timers: HoverTimers, setHover: SetHover): HoverPreview {
  let dwell: number | null = null;
  let grace: number | null = null;
  let over: string | null = null;

  function enter(name: string, pointer: string, hover: string | null) {
    if (pointer === 'touch') return;
    over = name;
    if (grace !== null && name === hover) {
      timers.clearTimeout(grace);
      grace = null;
    }
    if (dwell !== null) timers.clearTimeout(dwell);
    dwell = timers.setTimeout(() => {
      dwell = null;
      setHover(name);
    }, HOVER_DWELL_MS);
  }

  function leave(name: string) {
    if (over === name) over = null;
    if (dwell !== null) {
      timers.clearTimeout(dwell);
      dwell = null;
    }
    if (grace !== null) timers.clearTimeout(grace);
    grace = timers.setTimeout(() => {
      grace = null;
      setHover((current) => (current !== null && over === current ? current : null));
    }, HOVER_GRACE_MS);
  }

  function dispose() {
    if (dwell !== null) timers.clearTimeout(dwell);
    if (grace !== null) timers.clearTimeout(grace);
    dwell = null;
    grace = null;
  }

  return { enter, leave, dispose };
}
