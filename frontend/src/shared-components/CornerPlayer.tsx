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
import { canPopOut, onTabLeft, openPopout } from '@/infra/popout';
import type { Layer } from '@/infra/relay';
import type { AvatarVoice } from '@/shared-components/AvatarLayer';
import { ChatPanel } from '@/shared-components/ChatPanel';
import { ConfirmDialog } from '@/shared-components/ConfirmDialog';
import { SceneView } from '@/shared-components/SceneView';
import type { Tone } from '@/shared-components/StatusLine';
import { ChatIcon, IconButton, PopOutIcon, revealClassName } from '@/shared-components/VideoControls';
import { VideoFrame } from '@/shared-components/VideoFrame';
import { cn } from '@/utils/cn';

const GRIP = 'touch-none select-none [-webkit-touch-callout:none]';

const FRAME = 'border border-primaryStroke bg-backgroundSecondary';

interface Box {
  x: number;
  y: number;
  w: number;
}

const PIP_CHAT_W = 280;
const PIP_CHAT_H = 288;
const DEFAULT_W = 320;
const FOOTER_H = 36;

type Place = PipChatPlace | 'off';

const toTab = () => window.focus();

const sideOf = (place: Place) => (place === 'left' || place === 'right' ? PIP_CHAT_W : 0);
const insetOf = (place: Place) => (place === 'left' ? PIP_CHAT_W : 0);

export const CORNER_BADGE = 'left-3 top-[max(8px,5%)]';
export const CORNER_BADGE_2 = 'left-[3.25rem] top-[max(8px,5%)]';

const CLICK_SLOP = 4;
const MIN_WIDTH = 160;

const CORNERS = [
  { id: 'nw', sx: -1, sy: -1, className: '-left-px -top-px cursor-nwse-resize border-l-2 border-t-2' },
  { id: 'ne', sx: 1, sy: -1, className: '-right-px -top-px cursor-nesw-resize border-r-2 border-t-2' },
  { id: 'sw', sx: -1, sy: 1, className: '-bottom-px -left-px cursor-nesw-resize border-b-2 border-l-2' },
  { id: 'se', sx: 1, sy: 1, className: '-bottom-px -right-px cursor-nwse-resize border-b-2 border-r-2' }
] as const;

interface Gesture {
  kind: 'move' | 'resize';
  sx: number;
  sy: number;
  pointerId: number;
  startX: number;
  startY: number;
  rect: DOMRect;
  side: number;
  moved: boolean;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const room = () => ({ w: document.documentElement.clientWidth, h: document.documentElement.clientHeight });
const chrome = (rect: DOMRect, side: number) => rect.height - ((rect.width - side) * 9) / 16;
const heightAt = (videoW: number, extra: number) => (videoW * 9) / 16 + extra;

function moved(g: Gesture, dx: number, dy: number): Box {
  const { rect, side } = g;
  const r = room();
  return { x: clamp(rect.left + dx, 0, r.w - rect.width), y: clamp(rect.top + dy, 0, r.h - rect.height), w: rect.width - side };
}

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

function fitted(box: Box, rect: DOMRect, side: number): Box {
  const r = room();
  const extra = chrome(rect, side);
  const videoW = clamp(box.w, MIN_WIDTH, Math.min(r.w - side, ((r.h - extra) * 16) / 9));
  const total = videoW + side;
  return { x: clamp(box.x, 0, Math.max(0, r.w - total)), y: clamp(box.y, 0, Math.max(0, r.h - heightAt(videoW, extra))), w: videoW };
}

export interface CornerChat {
  name: string;
  owner?: Owner | null;
  place: PipChatPlace;
  open: boolean;
  pageChatIsOurs: boolean;
  onToggle: () => void;
}

interface CornerPlayerProps {
  prefix: string;
  visible: boolean;
  popOutOnLeave?: boolean;
  label: string;
  name: string;
  to: string;
  message: ReactNode;
  tone: Tone;
  streamAtom: Atom<MediaStream | null>;
  videoRef: RefObject<HTMLVideoElement | null>;
  muted: boolean;
  volume?: number;
  onPlaying?: () => void;
  onAutoplayBlocked?: () => void;
  chat: CornerChat;
  closeLabel: string;
  onClose: () => void;
  closeConfirm?: { title: string; message: string; yes: string };
  center?: ReactNode;
  scene?: {
    layers: readonly Layer[];
    slot: number | null;
    streamFor: (slot: number) => Atom<MediaStream | null>;
    imageUrl: (asset: number) => string;
    avatar: AvatarVoice;
    onPick?: (slot: number) => void;
  };
  badge?: ReactNode;
  bar?: ReactNode;
  barShown?: boolean;
  footer?: ReactNode;
}

export function CornerPlayer({
  prefix,
  visible,
  popOutOnLeave = false,
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
  const stop = useRef<(() => void) | null>(null);
  const dragged = useRef(false);
  const [box, setBox] = useState<Box | null>(null);
  const [out, setOut] = useState<{ win: Window; left: boolean } | null>(null);
  const popout = out && !out.win.closed ? out.win : null;
  const popped = popout !== null;
  const away = out?.left === true;
  const shown = visible || away;
  const [asking, setAsking] = useState(false);
  const chatFree = (inWindow: boolean) => !chat.pageChatIsOurs || inWindow;
  const guest = popped && chat.pageChatIsOurs;
  const canChat = chatFree(popped);
  const showChat = chat.open && canChat;
  const place: Place = showChat ? chat.place : 'off';
  const placeOut: Place = chat.open && chatFree(true) ? chat.place : 'off';
  const leave = useRef<((asked: boolean) => void) | null>(null);
  const placeRef = useRef<Place>('off');

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

  useEffect(() => {
    if (!shown) popout?.close();
  }, [shown, popout]);
  useEffect(() => () => popout?.close(), [popout]);
  useEffect(() => {
    if (out?.win.closed) setOut(null);
  });

  const open = async (width: number, height: number, left: boolean) => {
    try {
      const win = await openPopout(Math.round(width), Math.round(height), (closed) => setOut((o) => (o?.win === closed ? null : o)));
      win.document.title = label;
      setOut({ win, left });
    } catch {
    }
  };

  const popOut = () => {
    const el = root.current;
    if (!el || out) return;
    const r = el.getBoundingClientRect();
    void open(r.width, r.height, false);
  };

  useEffect(() => {
    leave.current = (asked) => {
      if (asked) popOut();
      else if (!out) {
        const r = root.current?.getBoundingClientRect();
        void open(r ? r.width : DEFAULT_W + sideOf(placeOut), r ? r.height : heightAt(DEFAULT_W, FOOTER_H + (placeOut === 'bottom' ? PIP_CHAT_H : 0)), true);
      }
    };
  });
  useEffect(() => {
    if (!popOutOnLeave) return;
    return onTabLeft((asked) => leave.current?.(asked));
  }, [popOutOnLeave]);

  useEffect(() => {
    if (!out?.left) return;
    const back = () => {
      if (!document.hidden) out.win.close();
    };
    document.addEventListener('visibilitychange', back);
    return () => document.removeEventListener('visibilitychange', back);
  }, [out]);

  const endStream = () => {
    onClose();
    popout?.close();
  };

  const toggleChat = () => {
    if (popout) {
      const sign = showChat ? -1 : 1;
      try {
        popout.resizeBy(sign * (chat.place === 'bottom' ? 0 : PIP_CHAT_W), sign * (chat.place === 'bottom' ? PIP_CHAT_H : 0));
      } catch {
      }
    }
    chat.onToggle();
  };

  const press = (e: ReactPointerEvent, kind: Gesture['kind'], sx = 0, sy = 0) => {
    const el = root.current;
    if (e.button !== 0 || stop.current || !el) return;
    dragged.current = false;
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

  if (!shown) return null;
  const side = sideOf(place);
  const chatBelow = place === 'bottom';
  const columns = place === 'left' ? `${PIP_CHAT_W}px minmax(0,1fr)` : place === 'right' ? `minmax(0,1fr) ${PIP_CHAT_W}px` : 'minmax(0,1fr)';

  const buttons = (
    <div className="absolute right-3 top-[max(8px,5%)] flex gap-2">
      <IconButton
        id={`${prefix}-chat`}
        label={!canChat ? 'this page has its own chat' : showChat ? 'close the chat' : 'chat'}
        active={showChat}
        disabled={!canChat}
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
        onClick={closeConfirm ? () => setAsking(true) : endStream}
        className="text-lg leading-none"
      >
        ×
      </IconButton>
    </div>
  );

  const confirm = asking && closeConfirm && (
    <ConfirmDialog
      id={`${prefix}-confirm`}
      title={closeConfirm.title}
      message={closeConfirm.message}
      yes={closeConfirm.yes}
      onYes={() => {
        setAsking(false);
        endStream();
      }}
      onNo={() => setAsking(false)}
    />
  );

  const picture = (
    <div
      className={cn('relative', popped ? cn('min-h-0 shrink', chatBelow ? 'aspect-video' : 'flex-1') : GRIP)}
      onPointerDown={popped ? undefined : (e) => press(e, 'move')}
    >
      <Link to={to} aria-label={`back to ${name}`} className={cn('block', popped && 'absolute inset-0')} onClick={popped ? toTab : undefined}>
        {scene && !popped ? (
          <SceneView
            id={`${prefix}-scene`}
            layers={scene.layers}
            streamFor={scene.streamFor}
            imageUrl={scene.imageUrl}
            avatar={scene.avatar}
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
      <Link to={to} className="min-w-0 cursor-pointer truncate font-semibold" onClick={popped ? toTab : undefined}>
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

  const column = (
    <div className={cn('col-start-1 row-start-1 min-w-0', place === 'left' && 'col-start-2', popped && 'flex min-h-0 flex-col')}>
      {picture}
      {footerRow}
    </div>
  );

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
      <ChatPanel name={chat.name} owner={chat.owner} embedded guest={guest} className="min-h-0 flex-1" />
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
