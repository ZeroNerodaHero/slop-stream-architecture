import type { Atom } from 'jotai';
import {
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef
} from 'react';

import { type Box, fitOf, isVideoLayer, type Layer } from '@/infra/relay';
import { AvatarLayer, type AvatarVoice } from '@/shared-components/AvatarLayer';
import { VideoFrame } from '@/shared-components/VideoFrame';
import { cn } from '@/utils/cn';

/** A fraction of the frame as a css percentage, to a tenth: `0.73` is `73%`, not `72.99999999999999%`. The tests read these back. */
const pct = (fraction: number) => `${Math.round(fraction * 1000) / 10}%`;
/** A press that travels less than this is a click (select, or pick), not a drag. */
const CLICK_SLOP = 4;
/** An arrow key moves a layer this much of the frame; with shift, five times that. */
const NUDGE = 0.01;
const ARROWS: Record<string, readonly [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
/** The parts you take hold of: no text selection, no page scroll on touch, no long-press menu. */
const GRIP = 'touch-none select-none [-webkit-touch-callout:none]';
/** The corner handles. `sx`/`sy`: which way the box grows when that corner is pulled outward. */
const CORNERS = [
  { id: 'nw', sx: -1, sy: -1, className: '-left-px -top-px cursor-nwse-resize border-l-2 border-t-2' },
  { id: 'ne', sx: 1, sy: -1, className: '-right-px -top-px cursor-nesw-resize border-r-2 border-t-2' },
  { id: 'sw', sx: -1, sy: 1, className: '-bottom-px -left-px cursor-nesw-resize border-b-2 border-l-2' },
  { id: 'se', sx: 1, sy: 1, className: '-bottom-px -right-px cursor-nwse-resize border-b-2 border-r-2' }
] as const;

/** What a layer does under the keys besides moving: taken off the stream or out, sent back or brought forward. */
export type LayerKey = 'remove' | 'back' | 'forward';

/** The editor's hooks. Given, the layers can be taken hold of; without them the frame is a watcher's. */
export interface SceneEdit {
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** A drag: the box as it was when the press began, and how far the pointer went, in fractions of the frame. */
  onMove: (id: string, from: Box, dx: number, dy: number) => void;
  /** A corner pulled: which (`sx`,`sy`), how far, and whether shift freed the shape. */
  onResize: (id: string, from: Box, sx: number, sy: number, dx: number, dy: number, free: boolean) => void;
  onNudge: (id: string, dx: number, dy: number) => void;
  onKey: (id: string, what: LayerKey) => void;
}

/** The one `<video>` with the sound: the watch page's `#video`, the go live page's `#preview`. */
export interface MainVideo {
  id: string;
  streamAtom: Atom<MediaStream | null>;
  videoRef: RefObject<HTMLVideoElement | null>;
  /** The layer it stands in for: the first video layer of this slot. `null`: no layer is its own, it hides as a dot (the sound still plays). */
  slot: number | null;
  muted: boolean;
  volume?: number;
  onPlaying?: () => void;
  onAutoplayBlocked?: () => void;
}

interface SceneViewProps {
  /** The frame's id. A layer is `layer-<id>`, its picture `layer-<id>-video` or `-img`. */
  id: string;
  /** Bottom first. Empty: the main video fills the frame on its own (a stream with no scene). */
  layers: readonly Layer[];
  /** A video layer's stream by slot. Stable per slot: `VideoFrame` binds once. */
  streamFor: (slot: number) => Atom<MediaStream | null>;
  /** A picture's url by asset id. */
  imageUrl: (asset: number) => string;
  /** An avatar layer: whose picture, and the sound that moves it. Without it an avatar layer is an empty box. */
  avatar?: AvatarVoice;
  main: MainVideo;
  /** A watcher's click on a video layer: that slot goes big. */
  onPick?: (slot: number) => void;
  edit?: SceneEdit;
  className?: string;
  /** Over every layer: the chips and the bars. */
  children?: ReactNode;
}

/** One press, pointerdown to pointerup: where it began, the box as it was, the frame then. */
interface Gesture {
  kind: 'move' | 'resize';
  sx: number;
  sy: number;
  pointerId: number;
  startX: number;
  startY: number;
  box: Box;
  frame: DOMRect;
  shift: boolean;
  moved: boolean;
}

/**
 * The frame as the streamer laid it out (docs/screen.md): a 16:9 box with the layers drawn in
 * it, bottom first, each at its own fractions, so this preview and every watcher's player show
 * the same picture at any size. The main `<video>` (the one with the sound) stands in for the
 * first video layer of its slot and never unmounts: the other video layers are muted copies,
 * the pictures `<img>`s, the avatar the streamer's picture moving with the sound (`AvatarLayer`).
 * A watcher clicks a video layer to see it alone; the streamer takes hold of a layer to move
 * it, pulls a corner to resize it, and uses the keys (arrows nudge, shift five times as far,
 * delete takes it off, `[` and `]` move it through the stack, escape lets go).
 */
export function SceneView({ id, layers, streamFor, imageUrl, avatar, main, onPick, edit, className, children }: SceneViewProps) {
  const frame = useRef<HTMLDivElement | null>(null);
  const hostIndex = main.slot === null ? -1 : layers.findIndex((l) => isVideoLayer(l) && l.slot === main.slot);
  const host = layers[hostIndex];
  const mainVideo = (
    <VideoFrame
      id={main.id}
      streamAtom={main.streamAtom}
      videoRef={main.videoRef}
      muted={main.muted}
      volume={main.volume}
      onPlaying={main.onPlaying}
      onAutoplayBlocked={main.onAutoplayBlocked}
      className={cn('h-full border-0', host && isVideoLayer(host) && fitOf(host) === 'cover' ? 'object-cover' : 'object-contain')}
    />
  );
  return (
    <div
      ref={frame}
      id={id}
      className={cn('relative isolate aspect-video w-full overflow-hidden border border-primaryStroke bg-black', className)}
      // a press on the frame itself, between the layers, lets the selection go
      onPointerDown={edit ? (e) => e.target === e.currentTarget && edit.onSelect(null) : undefined}
    >
      {layers.length === 0 && <div className="absolute inset-0">{mainVideo}</div>}
      {layers.map((layer, i) => (
        <LayerBox key={layer.id} layer={layer} frame={frame} edit={edit} onPick={onPick}>
          {i === hostIndex ? (
            mainVideo
          ) : layer.kind === 'avatar' ? (
            // keyed on where the sound comes from: a reader given later (the mixer opening) is bound on mount, like the stream
            avatar && <AvatarLayer key={avatar.read ? 'mixer' : 'own'} id={`layer-${layer.id}-avatar`} wide={layer.w * 16 >= layer.h * 9} voice={avatar} />
          ) : isVideoLayer(layer) ? (
            <LayerVideo id={`layer-${layer.id}-video`} streamAtom={streamFor(layer.slot)} cover={fitOf(layer) === 'cover'} />
          ) : (
            <img id={`layer-${layer.id}-img`} src={imageUrl(layer.asset)} alt="" draggable={false} className="block h-full w-full object-fill" />
          )}
        </LayerBox>
      ))}
      {/* the main video with no layer of its own: a dot, so the sound plays on and `playing` keeps firing */}
      {layers.length > 0 && hostIndex < 0 && <div className="pointer-events-none absolute left-0 top-0 h-px w-px opacity-0">{mainVideo}</div>}
      {children}
    </div>
  );
}

/** A video layer that is not the main one: a muted copy of its slot, filling its box the way the layer says. */
function LayerVideo({ id, streamAtom, cover }: { id: string; streamAtom: Atom<MediaStream | null>; cover: boolean }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  return <VideoFrame id={id} streamAtom={streamAtom} videoRef={ref} muted className={cn('h-full border-0', cover ? 'object-cover' : 'object-contain')} />;
}

interface LayerBoxProps {
  layer: Layer;
  frame: RefObject<HTMLDivElement | null>;
  edit?: SceneEdit;
  onPick?: (slot: number) => void;
  children: ReactNode;
}

/**
 * One layer's box: `left`, `top`, `width`, `height` as percentages of the frame (the tests read
 * them back off the style). Under the editor it is taken hold of: the pointer is followed
 * through window listeners, so leaving the box before the slop loses nothing, and captured once
 * it is a drag, so leaving the window loses nothing either; not captured before that, so a plain
 * click still lands as one. The click a drag ends with is swallowed.
 */
function LayerBox({ layer, frame, edit, onPick, children }: LayerBoxProps) {
  const el = useRef<HTMLDivElement | null>(null);
  /** Ends the press in progress: its window listeners go. `null` between presses. */
  const stop = useRef<(() => void) | null>(null);
  /** The last press was a drag, so the click the browser fires after it is not a click. */
  const dragged = useRef(false);
  const selected = edit?.selectedId === layer.id;
  const pickable = !!onPick && isVideoLayer(layer);

  useEffect(() => () => stop.current?.(), []);

  const press = (e: ReactPointerEvent, kind: Gesture['kind'], sx = 0, sy = 0) => {
    const node = el.current;
    const rect = frame.current?.getBoundingClientRect();
    if (!edit || e.button !== 0 || stop.current || !node || !rect || rect.width === 0) return;
    edit.onSelect(layer.id);
    dragged.current = false;
    const g: Gesture = {
      kind,
      sx,
      sy,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      box: { x: layer.x, y: layer.y, w: layer.w, h: layer.h },
      frame: rect,
      shift: e.shiftKey,
      moved: false
    };
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== g.pointerId) return;
      const px = ev.clientX - g.startX;
      const py = ev.clientY - g.startY;
      if (!g.moved) {
        if (Math.hypot(px, py) < CLICK_SLOP) return;
        g.moved = true;
        if (node.isConnected) node.setPointerCapture(ev.pointerId);
      }
      // the delta against the frame as it was at the press, whole and not step by step: a pointer
      // that went past the edge and came back finds the box under it again
      const dx = px / g.frame.width;
      const dy = py / g.frame.height;
      if (g.kind === 'move') edit.onMove(layer.id, g.box, dx, dy);
      else edit.onResize(layer.id, g.box, g.sx, g.sy, dx, dy, ev.shiftKey || g.shift);
    };
    const end = (ev: PointerEvent) => {
      if (ev.pointerId !== g.pointerId) return;
      stop.current?.();
      if (!g.moved) return;
      // the click a mouse release makes comes in this same task, so it is swallowed; a finger that
      // moved makes none. Disarmed right after, so no stale arm eats the next tap.
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

  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!edit) return;
    const arrow = ARROWS[e.key];
    if (arrow) {
      e.preventDefault();
      const step = e.shiftKey ? NUDGE * 5 : NUDGE;
      edit.onNudge(layer.id, arrow[0] * step, arrow[1] * step);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      edit.onKey(layer.id, 'remove');
    } else if (e.key === '[' || e.key === ']') {
      e.preventDefault();
      edit.onKey(layer.id, e.key === '[' ? 'back' : 'forward');
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      edit.onSelect(null);
      el.current?.blur();
    }
  };

  const name = layer.kind === 'image' ? 'picture' : layer.kind;
  // the avatar is a square picture in the middle of its box: the box itself shows nothing (no black ground,
  // and on a watcher's side no edge), so in a corner over a screen the picture alone floats there
  const bare = layer.kind === 'avatar';
  return (
    <div
      ref={el}
      id={`layer-${layer.id}`}
      data-kind={layer.kind}
      data-slot={isVideoLayer(layer) ? layer.slot : undefined}
      role={edit || pickable ? 'button' : undefined}
      aria-pressed={edit ? selected : undefined}
      aria-label={edit ? `${name}. drag to move, pull a corner to resize, arrow keys nudge` : pickable ? `show ${name} big` : undefined}
      tabIndex={edit ? 0 : pickable ? 0 : undefined}
      style={{ left: pct(layer.x), top: pct(layer.y), width: pct(layer.w), height: pct(layer.h) }}
      onPointerDown={edit ? (e) => press(e, 'move') : undefined}
      onClickCapture={swallowClickAfterDrag}
      // `preventDefault`: in the corner player the frame sits in the link back to the page, and a pick is not that
      onClick={
        pickable
          ? (e) => {
              e.preventDefault();
              onPick(layer.slot);
            }
          : undefined
      }
      onKeyDown={edit ? keys : pickable ? (e) => (e.key === 'Enter' || e.key === ' ') && onPick(layer.slot) : undefined}
      onFocus={edit ? () => edit.onSelect(layer.id) : undefined}
      onDragStart={(e) => e.preventDefault()}
      // `isolate`: the handles stack inside this layer, never over the one above it. the edge is an inset
      // outline, not a border: the picture starts at the box's own edge, as the fractions say
      className={cn(
        'absolute isolate overflow-hidden outline transition-[outline-color] duration-150',
        !bare && 'bg-black',
        edit && cn('cursor-move', GRIP),
        pickable && 'cursor-pointer hover:outline-primaryBlue',
        selected
          ? 'outline-2 -outline-offset-2 outline-primaryBlue'
          : bare && !edit
            ? 'outline-0'
            : 'outline-1 -outline-offset-1 outline-white/40 focus-visible:outline-primaryBlue'
      )}
    >
      {children}
      {edit &&
        selected &&
        CORNERS.map((c) => (
          <div
            key={c.id}
            id={`layer-${layer.id}-resize-${c.id}`}
            aria-hidden
            onPointerDown={(e) => {
              e.stopPropagation();
              press(e, 'resize', c.sx, c.sy);
            }}
            className={cn('absolute z-10 h-4 w-4 border-primaryBlue', GRIP, c.className)}
          />
        ))}
    </div>
  );
}
