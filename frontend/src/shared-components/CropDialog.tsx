import { useAtomValue } from 'jotai';
import { type KeyboardEvent, type MouseEvent, type PointerEvent as ReactPointerEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { messageOf } from '@/infra/api';
import { answerCrop, type CropRequest, cropRequestAtom } from '@/infra/atoms/crop-atoms';
import {
  aspectOf,
  assetType,
  centredRect,
  cornerRect,
  formatWord,
  isWhole,
  minScale,
  movedRect,
  outputSize,
  pictureFor,
  type Rect,
  scaleOf,
  scaledRect
} from '@/infra/picture';
import { Button } from '@/shared-components/Button';
import { cn } from '@/utils/cn';

/** An arrow key moves the box this much of the picture; with shift, five times that. */
const NUDGE = 0.01;
const ARROWS: Record<string, readonly [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
/** A notch of the wheel, or `+`/`-`, scales the box by this much. */
const STEP = 1.1;
/** The parts you take hold of: no text selection, no page scroll on touch, no long-press menu. */
const GRIP = 'touch-none select-none [-webkit-touch-callout:none]';
/** The corner handles, the scene editor's. `sx`/`sy`: which way the box grows when that corner is pulled outward. */
const CORNERS = [
  { id: 'nw', sx: -1, sy: -1, className: '-left-px -top-px cursor-nwse-resize border-l-2 border-t-2' },
  { id: 'ne', sx: 1, sy: -1, className: '-right-px -top-px cursor-nesw-resize border-r-2 border-t-2' },
  { id: 'sw', sx: -1, sy: 1, className: '-bottom-px -left-px cursor-nesw-resize border-b-2 border-l-2' },
  { id: 'se', sx: 1, sy: 1, className: '-bottom-px -right-px cursor-nwse-resize border-b-2 border-r-2' }
] as const;

/** The picture decoded: its pixels for the cut and its size for the geometry, and a url for the `<img>` that shows it. */
interface Loaded {
  picture: ImageBitmap;
  url: string;
}

/**
 * The crop dialog (infra/picture.ts): every picture the pages put up passes through it. Mounted
 * by the Shell; it renders nothing until `cropPicture` asks, and remounts per request. A native
 * <dialog> opened modal on mount, the way ConfirmDialog is: the browser keeps focus in it, closes
 * it on escape and hands focus back to the button that picked the file. Over the user modal it
 * sits on top, in the top layer.
 */
export function CropDialog() {
  const request = useAtomValue(cropRequestAtom);
  return request ? <CropBox key={request.id} request={request} /> : null;
}

/**
 * The picture fit inside a black stage, a box of the upload's shape over it (the rest dimmed),
 * started as big as fits in the middle: what the pages used to cut on their own. The box is
 * dragged to move, its corners pulled to scale (the shape kept), the wheel, the slider and
 * `+`/`-` scale it about its centre, arrow keys nudge it (shift five times as far). `use it`
 * makes the bytes (`pictureFor`) and closes; a ceiling missed says so and stays open for a
 * smaller part. Every way out goes through the element's `close`, which hands over the answer.
 */
function CropBox({ request }: { request: CropRequest }) {
  const { id, file, spec } = request;
  const aspect = aspectOf(spec);
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  /** The press that began this click was on the backdrop too: a drag that ends outside is not a close. */
  const pressedBackdrop = useRef(false);
  /** What `close` hands over: the bytes once `use it` made them, else null. */
  const answer = useRef<Blob | null>(null);
  /** Ends the press in progress: its window listeners go. `null` between presses. */
  const stop = useRef<(() => void) | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [rect, setRect] = useState<Rect | null>(null);
  /** Screen pixels per picture pixel: the picture fit inside the stage. 0 until measured. */
  const [k, setK] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // A layout effect: its cleanup runs while the node is still in the document, which is when
  // close() hands focus back. Taken away still open (a second request on top), the answer is no.
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    dialog.showModal();
    return () => {
      if (!dialog.open) return;
      dialog.close();
      answerCrop(id, null);
    };
  }, []);

  // Mount only: decode the file once, for the cut and the geometry; the `<img>` shows the same
  // file by url. The box starts as the biggest of its shape, in the middle.
  useEffect(() => {
    let gone = false;
    let picture: ImageBitmap | null = null;
    const url = URL.createObjectURL(file);
    createImageBitmap(file).then(
      (bitmap) => {
        if (gone) {
          bitmap.close();
          return;
        }
        picture = bitmap;
        setLoaded({ picture: bitmap, url });
        setRect(centredRect(bitmap.width, bitmap.height, aspect));
      },
      () => {
        if (!gone) setError('could not read that picture');
      }
    );
    return () => {
      gone = true;
      URL.revokeObjectURL(url);
      picture?.close();
      stop.current?.();
    };
  }, []);

  // The picture fit inside the stage, and again whenever the stage changes size.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !loaded) return;
    const fit = () => {
      const { width, height } = stage.getBoundingClientRect();
      setK(Math.min(width / loaded.picture.width, height / loaded.picture.height));
    };
    fit();
    const watcher = new ResizeObserver(fit);
    watcher.observe(stage);
    return () => watcher.disconnect();
  }, [loaded]);

  // The wheel scales the box. A native listener: react's wheel is passive, and the dialog would scroll instead.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !loaded) return;
    const { width, height } = loaded.picture;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setRect((r) => (r ? scaledRect(r, e.deltaY > 0 ? STEP : 1 / STEP, aspect, width, height) : r));
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, [loaded]);

  // Once the box is there, the keys are its: arrows and +/- work right away.
  useEffect(() => {
    if (rect && k > 0) boxRef.current?.focus();
  }, [rect !== null && k > 0]);

  const close = () => dialogRef.current?.close();

  /** A press on the box (a move) or a corner (a resize): the pointer is followed through window listeners, captured, until it lifts. */
  const press = (e: ReactPointerEvent<HTMLElement>, kind: 'move' | 'resize', sx = 0, sy = 0) => {
    if (!loaded || !rect || e.button !== 0 || stop.current || k === 0) return;
    const { width, height } = loaded.picture;
    const from = rect;
    const { pointerId, clientX: startX, clientY: startY } = e;
    const node = e.currentTarget;
    node.setPointerCapture(pointerId);
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      // the delta against the press, whole and not step by step: a pointer that went past the edge and came back finds the box under it again
      const dx = (ev.clientX - startX) / k;
      const dy = (ev.clientY - startY) / k;
      setRect(kind === 'move' ? movedRect(from, dx, dy, width, height) : cornerRect(from, sx, sy, dx, dy, aspect, width, height));
    };
    const end = (ev: PointerEvent) => {
      if (ev.pointerId === pointerId) stop.current?.();
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

  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!loaded || !rect) return;
    const { width, height } = loaded.picture;
    const arrow = ARROWS[e.key];
    if (arrow) {
      e.preventDefault();
      const step = e.shiftKey ? NUDGE * 5 : NUDGE;
      setRect(movedRect(rect, arrow[0] * step * width, arrow[1] * step * height, width, height));
    } else if (e.key === '+' || e.key === '=' || e.key === '-') {
      e.preventDefault();
      setRect(scaledRect(rect, e.key === '-' ? STEP : 1 / STEP, aspect, width, height));
    }
  };

  const use = async () => {
    if (!loaded || !rect || busy) return;
    setBusy(true);
    setError('');
    try {
      answer.current = await pictureFor(spec, file, loaded.picture, rect);
      close();
    } catch (err) {
      setError(messageOf(err));
      setBusy(false);
    }
  };

  const onBackdropDown = (e: ReactPointerEvent<HTMLDialogElement>) => {
    pressedBackdrop.current = e.target === e.currentTarget;
  };
  const onBackdropClick = (e: MouseEvent<HTMLDialogElement>) => {
    if (pressedBackdrop.current && e.target === e.currentTarget) close();
  };

  // the line under the stage: what goes up, at what size, in what format
  let goes = '';
  let zoom = 1;
  let zoomMost = 1;
  if (loaded && rect) {
    const { width, height } = loaded.picture;
    const out = outputSize(spec, rect, width, height);
    const whole = !spec.size && isWhole(rect, width, height) && file.size <= spec.max;
    // a file the browser gave no type goes up as whatever its first bytes say: no word for it here
    goes = spec.size
      ? `goes up as a ${out.width}×${out.height} jpeg`
      : whole
        ? `goes up as it is: ${out.width}×${out.height}${file.type ? ` ${formatWord(file.type)}` : ''}`
        : `goes up cut to ${out.width}×${out.height} ${formatWord(assetType(file))}`;
    zoom = 1 / scaleOf(rect, width, height);
    zoomMost = 1 / minScale(width, height, aspect);
  }

  return (
    <dialog
      ref={dialogRef}
      id="crop"
      aria-labelledby="crop-title"
      aria-describedby="crop-hint"
      onPointerDown={onBackdropDown}
      onClick={onBackdropClick}
      onClose={() => answerCrop(id, answer.current)}
      // the dialog box is the panel: a click whose target is the dialog element landed on the backdrop
      className="m-auto max-h-[calc(100dvh-2rem)] w-[min(720px,calc(100vw-2rem))] overflow-y-auto border border-primaryStroke bg-backgroundSecondary p-5 text-base text-textPrimary backdrop:bg-black/60 sm:p-6"
    >
      <h2 id="crop-title" className="border-l-4 border-primaryBlue pl-3 text-xl font-semibold leading-tight">
        {spec.title}
      </h2>
      <p id="crop-hint" className="mt-2 text-sm text-textSecondary">
        {spec.where}. drag the box to move it, pull a corner or use the slider to scale it. what is inside goes up.
      </p>

      <div ref={stageRef} className={cn('relative mt-4 flex h-[min(56dvh,440px)] w-full items-center justify-center overflow-hidden bg-black', GRIP)}>
        {loaded && rect && k > 0 ? (
          <div className="relative overflow-hidden" style={{ width: loaded.picture.width * k, height: loaded.picture.height * k }}>
            <img src={loaded.url} alt="" draggable={false} className="block h-full w-full" />
            <div
              ref={boxRef}
              id="crop-box"
              role="button"
              tabIndex={0}
              aria-label="the part that goes up. drag to move, pull a corner to scale, arrow keys nudge, + and - scale"
              style={{ left: rect.x * k, top: rect.y * k, width: rect.w * k, height: rect.h * k }}
              onPointerDown={(e) => press(e, 'move')}
              onKeyDown={keys}
              onDragStart={(e) => e.preventDefault()}
              // the shadow is the dimming of everything outside the box; the wrapper clips it to the picture
              className={cn(
                'absolute cursor-move outline outline-2 -outline-offset-2 outline-primaryBlue shadow-[0_0_0_9999px_rgba(0,0,0,0.6)] focus-visible:outline-white',
                GRIP
              )}
            >
              {CORNERS.map((c) => (
                <div
                  key={c.id}
                  id={`crop-resize-${c.id}`}
                  aria-hidden
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    press(e, 'resize', c.sx, c.sy);
                  }}
                  className={cn('absolute z-10 h-4 w-4 border-primaryBlue', GRIP, c.className)}
                />
              ))}
            </div>
          </div>
        ) : (
          <p className="px-4 text-center text-sm text-textTertiary">{error || 'reading the picture…'}</p>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <label htmlFor="crop-zoom" className="text-sm text-textSecondary">
          zoom
        </label>
        <input
          id="crop-zoom"
          type="range"
          min={1}
          max={zoomMost}
          step={0.01}
          value={zoom}
          disabled={!loaded || !rect}
          aria-label="zoom"
          title={`${zoom.toFixed(1)}×`}
          onChange={(e) => {
            if (!loaded || !rect) return;
            const { width, height } = loaded.picture;
            setRect(scaledRect(rect, 1 / e.target.valueAsNumber / scaleOf(rect, width, height), aspect, width, height));
          }}
          className="h-1 min-w-[8rem] flex-1 accent-primaryBlue"
        />
        <button
          id="crop-reset"
          type="button"
          disabled={!loaded}
          onClick={() => loaded && setRect(centredRect(loaded.picture.width, loaded.picture.height, aspect))}
          className="text-sm text-textSecondary underline-offset-2 hover:text-textPrimary hover:underline disabled:opacity-40"
        >
          start over
        </button>
      </div>
      <p id="crop-size" className="mt-2 min-h-4 text-xs text-textTertiary" aria-live="polite">
        {goes}
      </p>

      <div className="mt-4 flex flex-wrap items-center justify-end gap-3">
        <span id="crop-status" className="mr-auto text-sm text-decrease" aria-live="polite">
          {loaded ? error : ''}
        </span>
        <Button id="crop-cancel" className="px-4 py-2" onClick={close}>
          cancel
        </Button>
        <Button id="crop-use" variant="primary" className="px-4 py-2" disabled={!loaded || !rect || busy} onClick={() => void use()}>
          {busy ? 'cutting…' : 'use it'}
        </Button>
      </div>
    </dialog>
  );
}
