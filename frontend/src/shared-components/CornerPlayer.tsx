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
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';

import type { Owner } from '@/infra/api';
import type { PipChatPlace } from '@/infra/atoms/settings-atoms';
import { canPopOut, openPopout } from '@/infra/popout';
import type { Layer } from '@/infra/relay';
import { ChatPanel } from '@/shared-components/ChatPanel';
import { ConfirmDialog } from '@/shared-components/ConfirmDialog';
import { SceneView } from '@/shared-components/SceneView';
import type { Tone } from '@/shared-components/StatusLine';
import { ChatIcon, IconButton, PopOutIcon, revealClassName } from '@/shared-components/VideoControls';
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

/** The chat column beside the picture. */
const PIP_CHAT_W = 280;
/** The chat under the picture (`h-72`). In the popped out window it is what the window grows by when the chat opens; the box keeps the class. */
const PIP_CHAT_H = 288;
/** The picture's width before anyone has dragged it. */
const DEFAULT_W = 320;

/** Where the open chat sits. `off` is the chat button closed: the picture alone, whatever the setting. */
type Place = PipChatPlace | 'off';

const sideOf = (place: Place) => (place === 'left' || place === 'right' ? PIP_CHAT_W : 0);
/** How far the picture sits in from the player's left edge: the chat column, when it is on the left. */
const insetOf = (place: Place) => (place === 'left' ? PIP_CHAT_W : 0);

/** Where the `badge` goes: the top left corner, level with the chat button and × (5% of the way down, 8px at least). */
export const CORNER_BADGE = 'left-3 top-[max(8px,5%)]';
/** A second chip in the `badge`, beside the first: one chip's width and the gap further in. */
export const CORNER_BADGE_2 = 'left-[3.25rem] top-[max(8px,5%)]';

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
  /** The ids the tests key on: `<prefix>-player`, `-video`, `-status`, `-chat`, `-popout`, `-close`, `-confirm`, `-resize-<corner>`. */
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
  /** A question before `onClose` (the broadcast's player: × ends the stream for everyone). The dialog is `<prefix>-confirm`. Without it, × closes at once. */
  closeConfirm?: { title: string; message: string; yes: string };
  /** Over the middle of the picture ("tap to play"). */
  center?: ReactNode;
  /**
   * The streamer's frame (the watch player): the layers drawn around the picture, as on the
   * page, with `streamAtom` standing in for `slot`. In the player's own window, whose shape is
   * the os's and not 16:9, the plain picture shows instead: the layers would not line up with it.
   */
  scene?: {
    layers: readonly Layer[];
    slot: number | null;
    streamFor: (slot: number) => Atom<MediaStream | null>;
    imageUrl: (asset: number) => string;
    onPick: (slot: number) => void;
  };
  /** In the picture's top left corner, across from the chat button and ×: the stream's health, and the broadcast's mic. Each chip places itself (`CORNER_BADGE`, `CORNER_BADGE_2`). */
  badge?: ReactNode;
  /** Along the picture's bottom edge, up on hover (`barShown`: always up). Nothing: no bar at all. */
  bar?: ReactNode;
  barShown?: boolean;
  /** In the footer before the status word (a viewer count). */
  footer?: ReactNode;
}

/**
 * A stream in a floating box: the picture with the chat button, pop out and × on it, the name
 * and the status word under it, and the stream's chat where the picture in picture setting
 * puts it. Drag it by the picture or the footer, pull a corner to resize it (16:9, the far
 * corner stays put); it never leaves the screen, and it stays where it was put for the rest
 * of the visit. Clicking it goes to the stream's page; dropping it does not. Until the first
 * drag it sits in the stack at the bottom right corner (MiniPlayer). Pop out (where the
 * browser has document picture in picture) takes the same box, chat and all, out of the page
 * into an always-on-top window of its own, over other apps too; the window is the box then
 * (the os moves and resizes it, the picture fits whatever shape it is given), the button in
 * it brings the box back where it was, and the window goes with the box: back on the
 * stream's own page, or ended. What the box shows is the caller's: the watch player and the
 * broadcast's player are the two.
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
  closeConfirm,
  center,
  scene,
  badge,
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
  /** The window the box is popped out into, while it is (infra/popout.ts): the box renders in there, and nothing in the page. */
  const [popout, setPopout] = useState<Window | null>(null);
  const popped = popout !== null;
  /** × was pressed and `closeConfirm` is asking. The dialog unmounts with the box, and says no then. */
  const [asking, setAsking] = useState(false);
  const showChat = chat.open && !chat.pageHasChat;
  const place: Place = showChat ? chat.place : 'off';
  /** The place last laid out, so a change of it can keep the picture where it was. Not updated while the player is hidden: the next time it shows applies the whole change once. */
  const placeRef = useRef<Place>('off');

  // A moved box is pulled back on screen when the window shrinks, when the player shows again
  // after its own page hid it (the window may have changed meanwhile), when the chat opens or
  // moves, and when it comes back from its own window (the chat may have opened out there).
  // Opening it on the left shifts the box left by the column, so the picture stays put and
  // the chat grows out of its left side. The stack's corner is css and needs none of this.
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
  }, [visible, place, popped]);

  useEffect(() => () => stop.current?.(), []);

  // The window goes with the box: hidden (back on the stream's own page, or ended) or unmounted,
  // it closes. A window already closed by its own × takes the call quietly.
  useEffect(() => {
    if (!visible) popout?.close();
  }, [visible, popout]);
  useEffect(() => () => popout?.close(), [popout]);

  /** The pop out button in the page: a window the box's size, and the box moves into it. Refused (the browser wants a click, and had one), it stays. */
  const popOut = async () => {
    const el = root.current;
    if (!el || popout) return;
    const r = el.getBoundingClientRect();
    try {
      const win = await openPopout(Math.round(r.width), Math.round(r.height), (closed) => setPopout((w) => (w === closed ? null : w)));
      win.document.title = label;
      setPopout(win);
    } catch {
      // no window: the box stays in the page
    }
  };

  /** The chat button. In the window, the window grows by the chat first (shrinks after), where the browser lets a page do that, so the picture keeps its size. */
  const toggleChat = () => {
    if (popout) {
      const sign = showChat ? -1 : 1;
      try {
        popout.resizeBy(sign * (chat.place === 'bottom' ? 0 : PIP_CHAT_W), sign * (chat.place === 'bottom' ? PIP_CHAT_H : 0));
      } catch {
        // the window keeps its size: the picture makes room instead
      }
    }
    chat.onToggle();
  };

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
  const chatBelow = place === 'bottom';
  // One column for the picture, and a fixed column for a chat beside it. minmax(0, 1fr) so the
  // picture's own frame size cannot widen the player past the width set here.
  const columns = place === 'left' ? `${PIP_CHAT_W}px minmax(0,1fr)` : place === 'right' ? `minmax(0,1fr) ${PIP_CHAT_W}px` : 'minmax(0,1fr)';

  // top right, 5% of the way down: the chat (lit while it is open), pop out (lit while out), and ×
  const buttons = (
    <div className="absolute right-3 top-[max(8px,5%)] flex gap-2">
      <IconButton
        id={`${prefix}-chat`}
        label={chat.pageHasChat ? 'this page has its own chat' : showChat ? 'close the chat' : 'chat'}
        active={showChat}
        disabled={chat.pageHasChat}
        tipAt="below-right"
        onClick={toggleChat}
      >
        <ChatIcon />
      </IconButton>
      {canPopOut && (
        <IconButton
          id={`${prefix}-popout`}
          label={popped ? 'back to the page' : 'pop out'}
          active={popped}
          tipAt="below-right"
          onClick={popped ? () => popout.close() : popOut}
        >
          <PopOutIcon />
        </IconButton>
      )}
      <IconButton
        id={`${prefix}-close`}
        label={closeLabel}
        tipAt="below-right"
        onClick={closeConfirm ? () => setAsking(true) : onClose}
        className="text-lg leading-none"
      >
        ×
      </IconButton>
    </div>
  );

  // the question × asks, in whichever document the box is in (the page, or the box's own window)
  const confirm = asking && closeConfirm && (
    <ConfirmDialog
      id={`${prefix}-confirm`}
      title={closeConfirm.title}
      message={closeConfirm.message}
      yes={closeConfirm.yes}
      onYes={() => {
        setAsking(false);
        onClose();
      }}
      onNo={() => setAsking(false)}
    />
  );

  // The picture with the controls on it. In the page it is the box's width and 16:9 by itself,
  // and a grip. In the window it is a block the window's shape sizes: 16:9 for as long as the
  // chat under it keeps its room, else whatever is left, the picture fitted inside (letterboxed
  // when the window is not 16:9), and the os window is the grip.
  const picture = (
    <div
      className={cn('relative', popped ? cn('min-h-0 shrink', chatBelow ? 'aspect-video' : 'flex-1') : GRIP)}
      onPointerDown={popped ? undefined : (e) => press(e, 'move')}
    >
      <Link to={to} aria-label={`back to ${name}`} className={cn('block', popped && 'absolute inset-0')}>
        {scene && !popped ? (
          <SceneView
            id={`${prefix}-scene`}
            layers={scene.layers}
            streamFor={scene.streamFor}
            imageUrl={scene.imageUrl}
            main={{ id: `${prefix}-video`, streamAtom, videoRef, slot: scene.slot, muted, volume, onPlaying, onAutoplayBlocked }}
            onPick={scene.onPick}
            className="min-w-0 border-0 border-b"
          />
        ) : (
          <VideoFrame
            id={`${prefix}-video`}
            streamAtom={streamAtom}
            videoRef={videoRef}
            muted={muted}
            volume={volume}
            onPlaying={onPlaying}
            onAutoplayBlocked={onAutoplayBlocked}
            className={cn('min-w-0 border-0 border-b', popped && 'h-full object-contain')}
          />
        )}
      </Link>
      {center}
      {badge}
      {buttons}
      {bar && <div className={cn('absolute inset-x-0 bottom-0 flex items-center gap-2 p-2', revealClassName(barShown))}>{bar}</div>}
    </div>
  );

  const footerRow = (
    <div
      className={cn('flex items-center justify-between gap-3 px-3 py-2 text-sm', popped ? 'shrink-0' : cn('cursor-move', GRIP))}
      title={popped ? undefined : 'drag to move, pull a corner to resize'}
      onPointerDown={popped ? undefined : (e) => press(e, 'move')}
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
  );

  // the picture's column. in the window it is a column the chat row below can shrink (the
  // picture yields, the footer never)
  const column = (
    <div className={cn('col-start-1 row-start-1 min-w-0', place === 'left' && 'col-start-2', popped && 'flex min-h-0 flex-col')}>
      {picture}
      {footerRow}
    </div>
  );

  // one panel for the life of the open chat: a change of place only moves it, so the room stays
  // connected. under the picture it is 288px in the page, and in the window whatever the window
  // has left under the picture, 96px at the least
  const chatBox = showChat && (
    <div
      className={cn(
        'flex min-h-0 flex-col',
        chatBelow && 'col-start-1 row-start-2 border-t border-primaryStroke',
        chatBelow && !popped && 'h-72',
        place === 'left' && 'absolute inset-y-0 left-0 z-0 overflow-hidden border-r border-primaryStroke',
        place === 'right' && 'absolute inset-y-0 right-0 z-0 overflow-hidden border-l border-primaryStroke'
      )}
      style={side ? { width: PIP_CHAT_W } : undefined}
    >
      <ChatPanel name={chat.name} owner={chat.owner} embedded className="min-h-0 flex-1" />
    </div>
  );

  if (popout) {
    return createPortal(
      <div
        id={`${prefix}-player`}
        aria-label={label}
        data-chat-place={showChat ? chat.place : undefined}
        data-popped=""
        style={{ gridTemplateColumns: columns, gridTemplateRows: chatBelow ? 'minmax(0,auto) minmax(6rem,1fr)' : 'minmax(0,1fr)' }}
        // the whole window, whatever shape the os gives it; the window's own frame is the edge, so no stroke
        className={cn(FRAME, 'group fixed inset-0 isolate grid overflow-hidden border-0')}
      >
        {column}
        {chatBox}
        {confirm}
      </div>,
      popout.document.body
    );
  }

  const style: CSSProperties = { gridTemplateColumns: columns };
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
      {column}
      {chatBox}
      {confirm}
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
