/**
 * When a card plays its camera: after the pointer has rested on it, until a little after the
 * pointer has left. The timers and the hover setter come in as arguments, so there is no React
 * or DOM in here and the same code runs under plain node.
 */

/** A pause, not a pass across the grid. Under this, hovering a card sends nothing. */
export const HOVER_DWELL_MS = 300;
/** Crossing from the picture to the name must not hang the preview up. */
export const HOVER_GRACE_MS = 400;

/** `window`, or a fake clock. */
export interface HoverTimers {
  setTimeout: (fn: () => void, ms: number) => number;
  clearTimeout: (id: number) => void;
}

/** A `useState` setter: the next value, or a function of the current one. */
export type SetHover = (next: string | null | ((current: string | null) => string | null)) => void;

export interface HoverPreview {
  /** A mouse or keyboard arrival on `name`; `hover` is the card playing now. Touch starts nothing: a tap is the click. */
  enter: (name: string, pointer: string, hover: string | null) => void;
  leave: (name: string) => void;
  /** Leaving the page: nothing pending may fire into an unmounted component. */
  dispose: () => void;
}

export function hoverPreview(timers: HoverTimers, setHover: SetHover): HoverPreview {
  let dwell: number | null = null;
  let grace: number | null = null;
  // the card the pointer is on. the grace hangs up by this, not by the card that armed it: a
  // neighbour crossed in under the dwell used to arm a grace of its own, which left the playing
  // card alone with no timer left to ever hang it up
  let over: string | null = null;

  function enter(name: string, pointer: string, hover: string | null) {
    if (pointer === 'touch') return;
    over = name;
    // back onto the card that is playing: nothing to hang up. onto any other card the grace runs on
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
