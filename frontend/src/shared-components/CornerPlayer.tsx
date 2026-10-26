import type { Atom } from 'jotai';
import {
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from 'react';
import { Link } from 'react-router-dom';

import type { Owner } from '@/infra/api';
import type { PipChatPlace } from '@/infra/atoms/settings-atoms';
import { ChatPanel } from '@/shared-components/ChatPanel';
import type { Tone } from '@/shared-components/StatusLine';
import { ChatIcon, IconButton, revealClassName } from '@/shared-components/VideoControls';
import { VideoFrame } from '@/shared-components/VideoFrame';
import { cn } from '@/utils/cn';

/** The parts of the player you take hold of to move it: no text selection, no page scroll on touch, no long-press menu. */
const GRIP = 'touch-none select-none [-webkit-touch-callout:none]';

/**
 * The panel look without its offset shadow: a floating box over a page of boxes with shadows
 * of their own would read as one more block behind it. The stroke alone marks its edge.
 */
const FRAME = 'border border-primaryStroke bg-backgroundSecondary';

/**
 * Where the player is, and how wide the picture is. A chat column on the left or the right is
 * added beside `w` when it is open; a chat under the picture only adds height. `null` is the
 * default, its place in the stack at the bottom right corner, until the first move or resize.
 */
interface Box {
  x: number;
  y: number;
  /** The picture's width. The whole player is this plus the side chat, when that is open. */
  w: number;
}

/** The chat column beside the picture. Under the picture the chat is `h-72` (288px) instead. */
const PIP_CHAT_W = 280;
/** The picture's width before anyone has dragged it. */
const DEFAULT_W = 320;

/** Where the open chat sits. `off` is the chat button closed: the picture alone, whatever the setting. */
type Place = PipChatPlace | 'off';

const sideOf = (place: Place) => (place === 'left' || place === 'right' ? PIP_CHAT_W : 0);
/** How far the picture sits in from the player's left edge: the chat column, when it is on the left. */
const insetOf = (place: Place) => (place === 'left' ? PIP_CHAT_W : 0);

/** A press that travels less than this is a click (back to the page, ×), not a move. */
const CLICK_SLOP = 4;
const MIN_WIDTH = 160;

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
  /** Width the side chat takes. 0 when the chat is under the picture or closed. Held for the press. */
  side: number;
  /** Past the slop: this press is a drag, and the click after it is not a click. */
  moved: boolean;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
/** The area the box may use: the viewport. */
const room = () => ({ w: document.documentElement.clientWidth, h: document.documentElement.clientHeight });
/**
 * What the box adds under the picture (footer, borders, and the chat when it sits under the
 * picture). The side chat is width, not height, so it is taken off before the 16:9.
 */
const chrome = (rect: DOMRect, side: number) => rect.height - ((rect.width - side) * 9) / 16;
const heightAt = (videoW: number, extra: number) => (videoW * 9) / 16 + extra;

/** Slid along with the pointer, stopped at the edges. `w` stays the picture's width. */
function moved(g: Gesture, dx: number, dy: number): Box {
  const { rect, side } = g;
  const r = room();
  return { x: clamp(rect.left + dx, 0, r.w - rect.width), y: clamp(rect.top + dy, 0, r.h - rect.height), w: rect.width - side };
}

/**
 * A corner pulled: the box follows along whichever axis the pointer travelled further (it is
 * 16:9, so one axis decides), the opposite corner stays put, and it grows no further than the
 * screen has room on the pulled side.
 */
function resized(g: Gesture, dx: number, dy: number): Box {
  const { rect, sx, sy, side } = g;
  const r = room();
  const extra = chrome(rect, side);
  const byX = sx * dx;
  const byY = (sy * dy * 16) / 9;
  const pull = Math.abs(byX) >= Math.abs(byY) ? byX : byY;
  const roomX = sx < 0 ? rect.right : r.w - rect.left;
  const roomY = sy < 0 ? rect.bottom : r.h - rect.top;
  const videoW = clamp(rect.width - side + pull, MIN_WIDTH, Math.min(roomX - side, ((roomY - extra) * 16) / 9));
  const h = heightAt(videoW, extra);
  const total = videoW + side;
  return { x: sx < 0 ? rect.right - total : rect.left, y: sy < 0 ? rect.bottom - h : rect.top, w: videoW };
}

/** The same box, back on screen: the window shrank, the chat opened beside it, or it was left somewhere while hidden. */
function fitted(box: Box, rect: DOMRect, side: number): Box {
  const r = room();
  const extra = chrome(rect, side);
  const videoW = clamp(box.w, MIN_WIDTH, Math.min(r.w - side, ((r.h - extra) * 16) / 9));
  const total = videoW + side;
  return { x: clamp(box.x, 0, Math.max(0, r.w - total)), y: clamp(box.y, 0, Math.max(0, r.h - heightAt(videoW, extra))), w: videoW };
}

/** The chat the player's chat button opens. */
export interface CornerChat {
  /** The room: the stream's name. */
  name: string;
  /** The streamer's own grant, on the player of their own stream: their lines are marked. */
  owner?: Owner | null;
  /** Where it sits when open: under the picture, or in a column on its left or its right (the picture in picture setting). */
  place: PipChatPlace;
  /** The button is on. */
  open: boolean;
  /** The page has a chat of its own: the button is disabled, and the chat waits for the next page without one. */
  pageHasChat: boolean;
  onToggle: () => void;
}

interface CornerPlayerProps {
  /** The ids the tests key on: `<prefix>-player`, `-video`, `-status`, `-chat`, `-close`, `-resize-<corner>`. */
  prefix: string;
  /** On screen at all. Hidden, the player keeps where it was put for the next time it shows. */
  visible: boolean;
  /** The player's accessible name. */
  label: string;
  /** The stream's name, in the footer. */
  name: string;
  /** The stream's own page: where a click on the picture or the name goes. */
  to: string;
  /** The status word, and its colour. A node when something stands in the word's place: the watch player's viewer count, once the stream plays. */
  message: ReactNode;
  tone: Tone;
  streamAtom: Atom<MediaStream | null>;
  /** The <video>, for the controls that need the element (the sound, tap to play). */
  videoRef: RefObject<HTMLVideoElement | null>;
  muted: boolean;
  volume?: number;
  onPlaying?: () => void;
  onAutoplayBlocked?: () => void;
  chat: CornerChat;
  /** The × top right: what it does, said on hover. */
  closeLabel: string;
  onClose: () => void;
  /** Over the middle of the picture ("tap to play"). */
  center?: ReactNode;
  /** Along the picture's bottom edge, up on hover (`barShown`: always up). Nothing: no bar at all. */
  bar?: ReactNode;
  barShown?: boolean;
  /** In the footer before the status word (a viewer count). */
  footer?: ReactNode;
}

/**
 * A stream in a floating box: the picture with the chat button and × on it, the name and the
 * status word under it, and the stream's chat where the picture in picture setting puts it.
 * Drag it by the picture or the footer, pull a corner to resize it (16:9, the far corner
 * stays put); it never leaves the screen, and it stays where it was put for the rest of the
 * visit. Clicking it goes to the stream's page; dropping it does not. Until the first drag it
 * sits in the stack at the bottom right corner (MiniPlayer). What the box shows is the
 * caller's: the watch player and the broadcast's player are the two.
 */
export function CornerPlayer({
  prefix,
  visible,
  label,
  name,
  to,
  message,
  tone,
  streamAtom,
  videoRef,
  muted,
  volume,
  onPlaying,
  onAutoplayBlocked,
  chat,
  closeLabel,
  onClose,
  center,
  bar,
  barShown = false,
  footer
}: CornerPlayerProps) {
  const root = useRef<HTMLElement | null>(null);
  /** Ends the press in progress: its window listeners go. `null` between presses. */
  const stop = useRef<(() => void) | null>(null);
  /** The last press was a drag, so the click the browser fires after it is swallowed. */
  const dragged = useRef(false);
  const [box, setBox] = useState<Box | null>(null);
  const showChat = chat.open && !chat.pageHasChat;
  const place: Place = showChat ? chat.place : 'off';
  /** The place last laid out, so a change of it can keep the picture where it was. Not updated while the player is hidden: the next time it shows applies the whole change once. */
  const placeRef = useRef<Place>('off');

  // A moved box is pulled back on screen when the window shrinks, when the player shows again
  // after its own page hid it (the window may have changed meanwhile), and when the chat
  // opens or moves. Opening it on the left shifts the box left by the column, so the picture
  // stays put and the chat grows out of its left side. The stack's corner is css and needs none of this.
  useLayoutEffect(() => {
    if (!visible) return;
    const prev = placeRef.current;
    placeRef.current = place;
    const placeChanged = prev !== place;
    const fit = (shift: boolean) => {
      const el = root.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const side = sideOf(place);
      setBox((b) => {
        if (!b) return b;
        const next = shift ? { ...b, x: b.x + insetOf(prev) - insetOf(place) } : b;
        const f = fitted(next, rect, side);
        return f.x === b.x && f.y === b.y && f.w === b.w ? b : f;
      });
    };
    fit(placeChanged);
    const onResize = () => fit(false);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [visible, place]);

  useEffect(() => () => stop.current?.(), []);

  /**
   * A press on the video or the footer (a move) or on a corner (a resize). The pointer is followed
   * through window listeners, so leaving the box before the slop loses nothing, and captured
   * once it is a drag, so leaving the window loses nothing either. Not captured before that: a
   * captured pointer's click lands on the capturing element, which would take the click away
   * from ×, unmute and the links.
   */
  const press = (e: ReactPointerEvent, kind: Gesture['kind'], sx = 0, sy = 0) => {
    const el = root.current;
    if (e.button !== 0 || stop.current || !el) return;
    dragged.current = false;
    // the volume dial and the stats panel sit on the video and handle their own presses: not a grip
    if ((e.target as Element).closest('input, [data-video-stats]')) return;
    const g: Gesture = {
      kind,
      sx,
      sy,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      rect: el.getBoundingClientRect(),
      side: sideOf(place),
      moved: false
    };
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
      stop.current?.();
      if (!g.moved) return;
      // the click a mouse release makes comes in this same task, so it is swallowed; a finger that
      // moved makes none, and a cancelled drag none either. Disarmed right after, so no stale arm
      // eats the next tap on the chat or an enter on a focused ×.
      dragged.current = true;
      setTimeout(() => (dragged.current = false), 0);
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
  const side = sideOf(place);
  // One column for the picture, and a fixed column for a chat beside it. minmax(0, 1fr) so the
  // picture's own frame size cannot widen the player past the width set here.
  const style: CSSProperties = {
    gridTemplateColumns: place === 'left' ? `${PIP_CHAT_W}px minmax(0,1fr)` : place === 'right' ? `minmax(0,1fr) ${PIP_CHAT_W}px` : 'minmax(0,1fr)'
  };
  if (box) {
    style.left = box.x;
    style.top = box.y;
    style.width = box.w + side;
  } else if (side) {
    style.width = `min(${DEFAULT_W + PIP_CHAT_W}px, calc(100vw - 3rem))`;
  }

  return (
    <aside
      ref={root}
      id={`${prefix}-player`}
      aria-label={label}
      data-chat-place={showChat ? chat.place : undefined}
      style={style}
      onClickCapture={swallowClickAfterDrag}
      onDragStart={(e) => e.preventDefault()}
      // in the stack until dragged, then fixed where it was dropped. `isolate`: the stats panel and
      // the handles stack inside this player, whichever position it is in
      className={cn(FRAME, 'group pointer-events-auto isolate grid', box ? 'fixed' : 'relative w-[min(320px,calc(100vw-3rem))]')}
    >
      <div className={cn('col-start-1 row-start-1 min-w-0', place === 'left' && 'col-start-2')}>
        <div className={cn('relative', GRIP)} onPointerDown={(e) => press(e, 'move')}>
          <Link to={to} aria-label={`back to ${name}`} className="block">
            <VideoFrame
              id={`${prefix}-video`}
              streamAtom={streamAtom}
              videoRef={videoRef}
              muted={muted}
              volume={volume}
              onPlaying={onPlaying}
              onAutoplayBlocked={onAutoplayBlocked}
              className="min-w-0 border-0 border-b"
            />
          </Link>
          {center}
          {/* top right, 5% of the way down: the chat (lit while it is open), and × */}
          <div className="absolute right-3 top-[max(8px,5%)] flex gap-2">
            <IconButton
              id={`${prefix}-chat`}
              label={chat.pageHasChat ? 'this page has its own chat' : showChat ? 'close the chat' : 'chat'}
              active={showChat}
              disabled={chat.pageHasChat}
              tipAt="below-right"
              onClick={chat.onToggle}
            >
              <ChatIcon />
            </IconButton>
            <IconButton id={`${prefix}-close`} label={closeLabel} tipAt="below-right" onClick={onClose} className="text-lg leading-none">
              ×
            </IconButton>
          </div>
          {bar && <div className={cn('absolute inset-x-0 bottom-0 flex items-center gap-2 p-2', revealClassName(barShown))}>{bar}</div>}
        </div>
        <div
          className={cn('flex cursor-move items-center justify-between gap-3 px-3 py-2 text-sm', GRIP)}
          title="drag to move, pull a corner to resize"
          onPointerDown={(e) => press(e, 'move')}
        >
          <Link to={to} className="min-w-0 cursor-pointer truncate font-semibold">
            {name}
          </Link>
          <span className="flex shrink-0 items-baseline gap-3 text-textSecondary">
            {footer}
            <span id={`${prefix}-status`} className={cn(tone === 'live' && 'text-increase', tone === 'bad' && 'text-decrease')}>
              {message}
            </span>
          </span>
        </div>
      </div>
      {/* one panel for the life of the open chat: a change of place only moves it, so the room stays connected */}
      {showChat && (
        <div
          className={cn(
            'flex min-h-0 flex-col',
            place === 'bottom' && 'col-start-1 row-start-2 h-72 border-t border-primaryStroke',
            place === 'left' && 'absolute inset-y-0 left-0 z-0 overflow-hidden border-r border-primaryStroke',
            place === 'right' && 'absolute inset-y-0 right-0 z-0 overflow-hidden border-l border-primaryStroke'
          )}
          style={side ? { width: PIP_CHAT_W } : undefined}
        >
          <ChatPanel name={chat.name} owner={chat.owner} embedded className="min-h-0 flex-1" />
        </div>
      )}
      {CORNERS.map((c) => (
        <div
          key={c.id}
          id={`${prefix}-resize-${c.id}`}
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
