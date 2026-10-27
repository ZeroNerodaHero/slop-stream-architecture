import type { Atom } from 'jotai';
import { type KeyboardEvent, type PointerEvent as ReactPointerEvent, useRef } from 'react';

import type { Layout } from '@/infra/relay';
import { VideoFrame } from '@/shared-components/VideoFrame';
import { cn } from '@/utils/cn';

interface CameraOverlayProps {
  /** The box; its picture is `<id>-video`. */
  id: string;
  /** The camera, muted: the sound is the big video's. */
  streamAtom: Atom<MediaStream | null>;
  layout: Layout;
  /** The watch page: a click makes the camera big. */
  onPick?: () => void;
  /** The go live page: the box follows a drag inside the frame, and the arrow keys nudge it (shift: further). Gets where the box is now, unclamped. */
  onMove?: (x: number, y: number) => void;
}

/** An arrow key moves the box this much of the frame; with shift, five times that. */
const NUDGE = 0.01;
/** A fraction of the frame as a css percentage, to a tenth: `0.73` is `73%`, not `72.99999999999999%`. */
const pct = (fraction: number) => `${Math.round(fraction * 1000) / 10}%`;
const ARROWS: Record<string, readonly [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

/** One press, pointerdown to pointerup: where the pointer and the box were when it began, and the frame's size then. */
interface Drag {
  pointerId: number;
  startX: number;
  startY: number;
  x: number;
  y: number;
  frame: DOMRect;
}

/**
 * The camera over the big picture, where the streamer put it (relay.ts `Layout`): a 16:9 box
 * `w` of the frame wide, its top left corner at `x`,`y` of the frame, so the go live page's
 * preview and every watcher's player draw the same picture at any size. Sits inside the
 * `relative` frame around the big video, under its controls. A camera that is not 16:9 is
 * cropped to the box, not letterboxed. On the watch page it is a button that makes the camera
 * big; on the go live page it is what you take hold of.
 */
export function CameraOverlay({ id, streamAtom, layout, onPick, onMove }: CameraOverlayProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const box = useRef<HTMLButtonElement | null>(null);
  const drag = useRef<Drag | null>(null);

  // the frame is the box's positioned parent; the delta is measured against the size it had
  // when the press began, and the place is the press's place plus the whole delta (not step by
  // step), so a pointer that went past the edge and came back finds the box under it again
  const press = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const frame = box.current?.offsetParent?.getBoundingClientRect();
    if (e.button !== 0 || !frame || frame.width === 0) return;
    drag.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, x: layout.x, y: layout.y, frame };
    box.current?.setPointerCapture(e.pointerId);
  };
  const move = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    onMove?.(d.x + (e.clientX - d.startX) / d.frame.width, d.y + (e.clientY - d.startY) / d.frame.height);
  };
  const release = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (drag.current?.pointerId === e.pointerId) drag.current = null;
  };
  const nudge = (e: KeyboardEvent<HTMLButtonElement>) => {
    const arrow = ARROWS[e.key];
    if (!arrow) return;
    e.preventDefault();
    const step = e.shiftKey ? NUDGE * 5 : NUDGE;
    onMove?.(layout.x + arrow[0] * step, layout.y + arrow[1] * step);
  };

  return (
    <button
      ref={box}
      id={id}
      type="button"
      aria-label={onMove ? 'camera. drag to move it, arrow keys nudge it' : 'show camera big'}
      title={onMove ? 'drag to move. arrow keys nudge' : undefined}
      onClick={onPick}
      onPointerDown={onMove ? press : undefined}
      onPointerMove={onMove ? move : undefined}
      onPointerUp={onMove ? release : undefined}
      onPointerCancel={onMove ? release : undefined}
      onKeyDown={onMove ? nudge : undefined}
      style={{ left: pct(layout.x), top: pct(layout.y), width: pct(layout.w) }}
      className={cn(
        'absolute aspect-video overflow-hidden border border-white/40 bg-black outline-none transition-[border-color] duration-150 focus-visible:border-primaryBlue',
        onMove ? 'cursor-move touch-none select-none' : 'hover:border-primaryBlue'
      )}
    >
      <VideoFrame id={`${id}-video`} streamAtom={streamAtom} videoRef={videoRef} muted className="h-full border-0 object-cover" />
    </button>
  );
}
