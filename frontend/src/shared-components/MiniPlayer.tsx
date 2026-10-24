import { useAtomValue } from 'jotai';
import { type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';

import {
  endWatch,
  markAutoplayBlocked,
  markPlaying,
  mutedAtom,
  needsTapAtom,
  pipAtom,
  remoteStreamAtom,
  showUnmuteAtom,
  unmuteVideo,
  volumeAtom,
  watchMessageAtom,
  watchNameAtom,
  watchToneAtom
} from '@/infra/atoms/watch-atoms';
import { cleanName } from '@/infra/names';
import { Button } from '@/shared-components/Button';
import { panelClassName } from '@/shared-components/Panel';
import { VideoFrame } from '@/shared-components/VideoFrame';
import { cn } from '@/utils/cn';

/** `/watch/<name>` or `/watch/<name>/`, spelled any way the page would read as this name. */
function isWatchPageOf(pathname: string, name: string): boolean {
  const m = /^\/watch\/([^/]+)\/?$/.exec(pathname);
  return m !== null && cleanName(m[1]) === name;
}

/**
 * Where the player is and how wide. The height follows: a 16:9 video over a one-line footer.
 * `null` is the default, the bottom right corner, until the first move or resize.
 */
interface Box {
  x: number;
  y: number;
  w: number;
}

/** A press that travels less than this is a click (back to the page, ×), not a move. */
const CLICK_SLOP = 4;
const MIN_WIDTH = 160;
/** `shadow-hard-lg` is 8px: the box stops that far from the right and bottom edges, so the shadow stays on screen with it. */
const SHADOW = 8;

/** The corner handles. `sx`/`sy`: which way the box grows when that corner is pulled outward. */
const CORNERS = [
  { id: 'nw', sx: -1, sy: -1, className: '-left-px -top-px cursor-nwse-resize border-l-2 border-t-2' },
  { id: 'ne', sx: 1, sy: -1, className: '-right-px -top-px cursor-nesw-resize border-r-2 border-t-2' },
  { id: 'sw', sx: -1, sy: 1, className: '-bottom-px -left-px cursor-nesw-resize border-b-2 border-l-2' },
  { id: 'se', sx: 1, sy: 1, className: '-bottom-px -right-px cursor-nwse-resize border-b-2 border-r-2' }
] as const;

/** One press, pointerdown to pointerup: where it began, and what it does to the box. */
interface Gesture {
  kind: 'move' | 'resize';
  sx: number;
  sy: number;
  pointerId: number;
  startX: number;
  startY: number;
  /** The box as it was when the press began. */
  rect: DOMRect;
  /** Past the slop: this press is a drag, and the click after it is not a click. */
  moved: boolean;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
/** The area the box may use: the viewport less the room the shadow needs. */
const room = () => ({ w: document.documentElement.clientWidth - SHADOW, h: document.documentElement.clientHeight - SHADOW });
/** What the box adds under the video (footer, borders). Constant, so the measured box gives it. */
const extraOf = (rect: DOMRect) => rect.height - (rect.width * 9) / 16;
const heightAt = (w: number, extra: number) => (w * 9) / 16 + extra;

/** Slid along with the pointer, stopped at the edges. */
function moved(g: Gesture, dx: number, dy: number): Box {
  const { rect } = g;
  const r = room();
  return { x: clamp(rect.left + dx, 0, r.w - rect.width), y: clamp(rect.top + dy, 0, r.h - rect.height), w: rect.width };
}

/**
 * A corner pulled: the box follows along whichever axis the pointer travelled further (it is
 * 16:9, so one axis decides), the opposite corner stays put, and it grows no further than the
 * screen has room on the pulled side.
 */
function resized(g: Gesture, dx: number, dy: number): Box {
  const { rect, sx, sy } = g;
  const r = room();
  const extra = extraOf(rect);
  const byX = sx * dx;
  const byY = (sy * dy * 16) / 9;
  const pull = Math.abs(byX) >= Math.abs(byY) ? byX : byY;
  const roomX = sx < 0 ? rect.right : r.w - rect.left;
  const roomY = sy < 0 ? rect.bottom : r.h - rect.top;
  const w = clamp(rect.width + pull, MIN_WIDTH, Math.min(roomX, ((roomY - extra) * 16) / 9));
  const h = heightAt(w, extra);
  return { x: sx < 0 ? rect.right - w : rect.left, y: sy < 0 ? rect.bottom - h : rect.top, w };
}

/** The same box, back on screen: the window shrank, or it was left somewhere while hidden. */
function fitted(box: Box, rect: DOMRect): Box {
  const r = room();
  const extra = extraOf(rect);
  const w = clamp(box.w, MIN_WIDTH, Math.min(r.w, ((r.h - extra) * 16) / 9));
  return { x: clamp(box.x, 0, r.w - w), y: clamp(box.y, 0, r.h - heightAt(w, extra)), w };
}

/**
 * The stream in a corner of the page while picture in picture is on and you are anywhere but
 * its own watch page (there the page's <video> plays; a second one here would be a second
 * sound). Same session, same MediaStream atom, same status words. Rendered once, by the
 * router's shell, so it survives every route change, and so does where you put it: drag it
 * from anywhere, pull a corner to resize it. Clicking it goes back to the page; dropping it
 * does not.
 */
export function MiniPlayer() {
  const pip = useAtomValue(pipAtom);
  const name = useAtomValue(watchNameAtom);
  const message = useAtomValue(watchMessageAtom);
  const tone = useAtomValue(watchToneAtom);
  const muted = useAtomValue(mutedAtom);
  const volume = useAtomValue(volumeAtom);
  const showUnmute = useAtomValue(showUnmuteAtom);
  const needsTap = useAtomValue(needsTapAtom);
  const { pathname } = useLocation();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const root = useRef<HTMLElement | null>(null);
  /** Ends the press in progress: its window listeners go. `null` between presses. */
  const stop = useRef<(() => void) | null>(null);
  /** The last press was a drag, so the click the browser fires after it is swallowed. */
  const dragged = useRef(false);
  const [box, setBox] = useState<Box | null>(null);
  const visible = pip && name !== '' && !isWatchPageOf(pathname, name);

  // A moved box is pulled back on screen when the window shrinks, and when the player shows
  // again after the watch page hid it (the window may have changed meanwhile). The default
  // corner is css and needs none of this.
  useLayoutEffect(() => {
    if (!visible) return;
    const fit = () => {
      const el = root.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setBox((b) => {
        if (!b) return b;
        const f = fitted(b, rect);
        return f.x === b.x && f.y === b.y && f.w === b.w ? b : f;
      });
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [visible]);

  useEffect(() => () => stop.current?.(), []);

  /**
   * A press anywhere on the player (a move) or on a corner (a resize). The pointer is followed
   * through window listeners, so leaving the box before the slop loses nothing, and captured
   * once it is a drag, so leaving the window loses nothing either. Not captured before that: a
   * captured pointer's click lands on the capturing element, which would take the click away
   * from ×, unmute and the links.
   */
  const press = (e: ReactPointerEvent, kind: Gesture['kind'], sx = 0, sy = 0) => {
    const el = root.current;
    if (e.button !== 0 || stop.current || !el) return;
    dragged.current = false;
    const g: Gesture = { kind, sx, sy, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, rect: el.getBoundingClientRect(), moved: false };
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== g.pointerId) return;
      const dx = ev.clientX - g.startX;
      const dy = ev.clientY - g.startY;
      if (!g.moved) {
        if (Math.hypot(dx, dy) < CLICK_SLOP) return;
        g.moved = true;
        if (el.isConnected) el.setPointerCapture(ev.pointerId);
      }
      setBox(kind === 'move' ? moved(g, dx, dy) : resized(g, dx, dy));
    };
    const end = (ev: PointerEvent) => {
      if (ev.pointerId !== g.pointerId) return;
      dragged.current = g.moved;
      stop.current?.();
    };
    stop.current = () => {
      stop.current = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  };

  const swallowClickAfterDrag = (e: ReactMouseEvent) => {
    if (!dragged.current) return;
    dragged.current = false;
    e.preventDefault();
    e.stopPropagation();
  };

  if (!visible) return null;
  const to = `/watch/${encodeURIComponent(name)}`;

  return (
    <aside
      ref={root}
      id="pip-player"
      aria-label={`${name}, picture in picture`}
      style={box ? { left: box.x, top: box.y, width: box.w } : undefined}
      onPointerDown={(e) => press(e, 'move')}
      onClickCapture={swallowClickAfterDrag}
      onDragStart={(e) => e.preventDefault()}
      className={panelClassName(
        cn('group fixed z-50 touch-none select-none shadow-hard-lg [-webkit-touch-callout:none]', !box && 'bottom-6 right-6 w-[min(320px,calc(100vw-3rem))]')
      )}
    >
      <div className="relative">
        <Link to={to} aria-label={`back to ${name}`} className="block">
          <VideoFrame
            id="pip-video"
            streamAtom={remoteStreamAtom}
            videoRef={videoRef}
            muted={muted}
            volume={volume}
            onPlaying={markPlaying}
            onAutoplayBlocked={markAutoplayBlocked}
            className="border-0 border-b"
          />
        </Link>
        <button
          id="pip-close"
          type="button"
          onClick={endWatch}
          aria-label="stop watching"
          title="stop watching"
          className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center border border-white/10 bg-black/70 text-lg leading-none text-textPrimary backdrop-blur-sm hover:border-primaryBlue hover:bg-black/90"
        >
          ×
        </button>
        {showUnmute && (
          <Button id="pip-unmute" variant="primary" className="absolute bottom-2 right-2 px-3 py-1.5 text-sm" onClick={() => unmuteVideo(videoRef.current)}>
            {needsTap ? 'tap to play' : 'unmute'}
          </Button>
        )}
      </div>
      <div className="flex cursor-move items-center justify-between gap-3 px-3 py-2 text-sm" title="drag to move, pull a corner to resize">
        <Link to={to} className="min-w-0 cursor-pointer truncate font-semibold">
          {name}
        </Link>
        <span id="pip-status" className={cn('shrink-0 text-textSecondary', tone === 'live' && 'text-increase', tone === 'bad' && 'text-decrease')}>
          {message}
        </span>
      </div>
      {CORNERS.map((c) => (
        <div
          key={c.id}
          id={`pip-resize-${c.id}`}
          aria-hidden
          onPointerDown={(e) => {
            e.stopPropagation();
            press(e, 'resize', c.sx, c.sy);
          }}
          className={cn('absolute z-10 h-4 w-4 border-primaryBlue opacity-0 transition-opacity duration-150 group-hover:opacity-100', c.className)}
        />
      ))}
    </aside>
  );
}
