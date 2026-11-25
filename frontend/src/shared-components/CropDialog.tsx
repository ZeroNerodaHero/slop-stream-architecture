import { RiAddLine, RiRefreshLine, RiSubtractLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent as ReactPointerEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { messageOf } from '@/infra/api';
import { answerCrop, swapCropFile, type CropRequest, cropRequestAtom } from '@/infra/atoms/crop-atoms';
import {
  aspectOf,
  assetType,
  centredRect,
  cornerRect,
  formatWord,
  isWhole,
  maxZoom,
  movedRect,
  outputSize,
  pictureFor,
  type Rect,
  scaledRect,
  zoomedRect,
  zoomOf
} from '@/infra/picture';
import { Button } from '@/shared-components/Button';
import { INPUT } from '@/shared-components/input';
import { SHEET_DIALOG, SheetGrab, useSheetBack } from '@/shared-components/MobileSheet';
import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

const NUDGE = 0.01;
const ARROWS: Record<string, readonly [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
const STEP = 1.1;
const GRIP = 'touch-none select-none [-webkit-touch-callout:none]';
const ZOOM_KEYS: Record<string, number> = { ArrowRight: 1 / STEP, ArrowUp: 1 / STEP, ArrowLeft: STEP, ArrowDown: STEP, PageUp: 1 / STEP ** 3, PageDown: STEP ** 3 };
const ZOOM_BUTTON = 'h-7 w-7 shrink-0 px-0 py-0 max-md:h-11 max-md:w-11 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:hover:border-primaryStroke aria-disabled:hover:bg-backgroundSecondary';
function cutOut(x: number, y: number, w: number, h: number): string {
  const [l, t, r, b] = [`${x}px`, `${y}px`, `${x + w}px`, `${y + h}px`];
  return `polygon(0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${l} ${t}, ${l} ${b}, ${r} ${b}, ${r} ${t}, ${l} ${t})`;
}
const CORNERS = [
  { id: 'nw', sx: -1, sy: -1, className: '-left-px -top-px cursor-nwse-resize border-l-2 border-t-2' },
  { id: 'ne', sx: 1, sy: -1, className: '-right-px -top-px cursor-nesw-resize border-r-2 border-t-2' },
  { id: 'sw', sx: -1, sy: 1, className: '-bottom-px -left-px cursor-nesw-resize border-b-2 border-l-2' },
  { id: 'se', sx: 1, sy: 1, className: '-bottom-px -right-px cursor-nwse-resize border-b-2 border-r-2' }
] as const;

function spanOf(points: Map<number, { x: number; y: number }>): number {
  const [a, b] = [...points.values()];
  return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
}

interface Loaded {
  picture: ImageBitmap;
  url: string;
}

export function CropDialog() {
  const request = useAtomValue(cropRequestAtom);
  return request ? <CropBox key={request.id} request={request} /> : null;
}

function CropBox({ request }: { request: CropRequest }) {
  const { id, file, spec, named } = request;
  const [name, setName] = useState(named?.initial ?? '');
  const aspect = aspectOf(spec);
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const pressedBackdrop = useRef(false);
  const answer = useRef<Blob | null>(null);
  const stop = useRef<(() => void) | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [rect, setRect] = useState<Rect | null>(null);
  const [k, setK] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const fingers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ from: Rect; span: number } | null>(null);

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

  useEffect(() => {
    if (!loaded) return;
    const { width, height } = loaded.picture;
    const touched = fingers.current;
    const move = (e: PointerEvent) => {
      if (!touched.has(e.pointerId)) return;
      touched.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const pinching = pinch.current;
      const span = spanOf(touched);
      if (pinching && span > 0) setRect(scaledRect(pinching.from, pinching.span / span, aspect, width, height));
    };
    const lift = (e: PointerEvent) => {
      if (!touched.delete(e.pointerId)) return;
      if (touched.size < 2) pinch.current = null;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', lift);
    window.addEventListener('pointercancel', lift);
    return () => {
      touched.clear();
      pinch.current = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', lift);
      window.removeEventListener('pointercancel', lift);
    };
  }, [loaded]);

  useEffect(() => {
    if (rect && k > 0) boxRef.current?.focus();
  }, [rect !== null && k > 0]);

  const close = () => dialogRef.current?.close();
  useSheetBack(close);

  const press = (e: ReactPointerEvent<HTMLElement>, kind: 'move' | 'resize', sx = 0, sy = 0) => {
    if (!loaded || !rect || e.button !== 0 || stop.current || pinch.current || k === 0) return;
    const { width, height } = loaded.picture;
    const from = rect;
    const { pointerId, clientX: startX, clientY: startY } = e;
    const node = e.currentTarget;
    node.setPointerCapture(pointerId);
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
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

  const touch = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'touch' || !rect) return;
    fingers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (fingers.current.size !== 2) return;
    const span = spanOf(fingers.current);
    if (span <= 0) return;
    stop.current?.();
    pinch.current = { from: rect, span };
  };

  const scaleBy = (factor: number) => {
    if (!loaded) return;
    const { width, height } = loaded.picture;
    setRect((r) => (r ? scaledRect(r, factor, aspect, width, height) : r));
  };

  const zoomTo = (to: number) => {
    if (!loaded) return;
    const { width, height } = loaded.picture;
    setRect((r) => (r ? zoomedRect(r, to, aspect, width, height) : r));
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
      const picture = await pictureFor(spec, file, loaded.picture, rect);
      if (named) {
        const fault = named.fault(name);
        if (fault) throw new Error(fault);
        await named.save(picture, name);
      }
      answer.current = picture;
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

  let goes = '';
  let zoom = 1;
  let zoomMost = 1;
  if (loaded && rect) {
    const { width, height } = loaded.picture;
    const out = outputSize(spec, rect, width, height);
    const whole = !spec.size && isWhole(rect, width, height) && file.size <= spec.max;
    goes = spec.stored
      ? `goes up as a ${spec.stored.width}×${spec.stored.height} ${formatWord(spec.stored.type)}`
      : spec.size
        ? `goes up as a ${out.width}×${out.height} ${formatWord(spec.type ?? 'image/jpeg')}`
        : whole
          ? `goes up as it is: ${out.width}×${out.height}${file.type ? ` ${formatWord(file.type)}` : ''}`
          : `goes up cut to ${out.width}×${out.height} ${formatWord(assetType(file))}`;
    zoom = Math.min(zoomOf(rect, width, height), maxZoom(width, height, aspect));
    zoomMost = maxZoom(width, height, aspect);
  }
  const ready = Boolean(loaded && rect);
  const atFit = !ready || zoom <= 1.0005;
  const atMost = !ready || zoom >= zoomMost * 0.9995;
  const filled = zoomMost > 1 ? (zoom - 1) / (zoomMost - 1) : 0;

  return (
    <dialog
      ref={dialogRef}
      id="crop"
      data-sheet=""
      aria-labelledby="crop-title"
      aria-describedby="crop-hint"
      onPointerDown={onBackdropDown}
      onClick={onBackdropClick}
      onClose={() => answerCrop(id, answer.current)}
      className={cn(
        'm-auto max-h-[calc(100dvh-2rem)] w-[min(720px,calc(100vw-2rem))] overflow-y-auto md:rounded-panel border border-primaryStroke bg-backgroundSecondary p-5 text-base text-textPrimary backdrop:bg-black/60 sm:p-6',
        SHEET_DIALOG
      )}
    >
      <SheetGrab onDismiss={close} />
      <h2 id="crop-title" className="border-l-4 border-primaryBlue pl-3 text-xl font-semibold leading-tight">
        {spec.title}
      </h2>
      <p id="crop-hint" className="mt-2 text-sm text-textSecondary">
        {spec.where}. drag the box to move it, pull a corner or use the slider to scale it. what is inside goes up.
      </p>

      <div ref={stageRef} onPointerDownCapture={touch} className={cn('relative mt-4 flex h-[min(56dvh,440px)] w-full items-center justify-center overflow-hidden bg-black', GRIP)}>
        {loaded && rect && k > 0 ? (
          <div className="relative overflow-hidden" style={{ width: loaded.picture.width * k, height: loaded.picture.height * k }}>
            <img src={loaded.url} alt="" draggable={false} className="block h-full w-full" />
            <div aria-hidden className="pointer-events-none absolute inset-0 bg-black/60" style={{ clipPath: cutOut(rect.x * k, rect.y * k, rect.w * k, rect.h * k) }} />
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
              className={cn('absolute cursor-move outline outline-2 -outline-offset-2 outline-primaryBlue focus-visible:outline-white', GRIP)}
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

      <div className="mt-2 flex items-center gap-2">
        <Tooltip content="zoom out">
          <Button
            id="crop-zoom-out"
            size="sm"
            aria-label="zoom out"
            aria-disabled={atFit}
            onClick={() => !atFit && scaleBy(STEP)}
            className={ZOOM_BUTTON}
          >
            <RiSubtractLine aria-hidden size={16} />
          </Button>
        </Tooltip>
        <input
          id="crop-zoom"
          type="range"
          min={1}
          max={zoomMost}
          step={0.01}
          value={zoom}
          disabled={!ready}
          aria-label="zoom"
          aria-valuetext={`${zoom.toFixed(1)} times`}
          onChange={(e) => zoomTo(e.target.valueAsNumber)}
          onKeyDown={(e) => {
            const factor = ZOOM_KEYS[e.key];
            if (factor === undefined && e.key !== 'Home' && e.key !== 'End') return;
            e.preventDefault();
            if (factor !== undefined) scaleBy(factor);
            else zoomTo(e.key === 'Home' ? 1 : zoomMost);
          }}
          style={{ '--pct': `calc(8px + (100% - 16px) * ${filled})` } as CSSProperties}
          className="range-box range-thin min-w-0 flex-1"
        />
        <Tooltip content="zoom in">
          <Button
            id="crop-zoom-in"
            size="sm"
            aria-label="zoom in"
            aria-disabled={atMost}
            onClick={() => !atMost && scaleBy(1 / STEP)}
            className={ZOOM_BUTTON}
          >
            <RiAddLine aria-hidden size={16} />
          </Button>
        </Tooltip>
        <span id="crop-zoom-value" aria-hidden className="w-9 shrink-0 text-right text-sm tabular-nums text-textSecondary">
          {`${zoom.toFixed(1)}×`}
        </span>
        <Button
          id="crop-reset"
          size="sm"
          disabled={!loaded}
          onClick={() => loaded && setRect(centredRect(loaded.picture.width, loaded.picture.height, aspect))}
          className="h-7 shrink-0 gap-1.5 py-0 max-md:h-11 max-md:px-2.5"
        >
          <RiRefreshLine aria-hidden size={14} />
          reset
        </Button>
      </div>
      <p id="crop-size" className="mt-1 min-h-4 text-xs text-textTertiary" aria-live="polite">
        {goes}
      </p>

      {named && (
        <div className="mt-3 flex flex-col gap-1">
          <label htmlFor="crop-name" className="text-sm font-semibold">
            name
          </label>
          <div className="flex items-center gap-1 text-textTertiary">
            <span aria-hidden>:</span>
            <input
              id="crop-name"
              value={name}
              onChange={(e) => setName(named.clean(e.target.value))}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
                e.preventDefault();
                void use();
              }}
              placeholder="name"
              maxLength={32}
              autoComplete="off"
              spellCheck={false}
              aria-describedby="crop-name-hint"
              className={cn(INPUT, 'w-auto min-w-0 flex-1')}
            />
            <span aria-hidden>:</span>
          </div>
          <p id="crop-name-hint" className="text-xs text-textTertiary">
            {named.rule}
          </p>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <input
            ref={fileRef}
            id="crop-file"
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const next = e.target.files?.[0];
              e.target.value = '';
              if (next) swapCropFile(id, next);
            }}
          />
          <button
            id="crop-pick"
            type="button"
            className="text-base font-semibold text-textTertiary hover:text-textPrimary focus-visible:text-textPrimary focus-visible:outline-none disabled:opacity-50"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
          >
            pick another image
          </button>
          <span id="crop-status" className="text-sm text-decrease" aria-live="polite">
            {loaded ? error : ''}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <button id="crop-cancel" type="button" className="text-base font-semibold text-textTertiary" onClick={close}>
            cancel
          </button>
          <Button id="crop-use" variant="primary" className="px-4 py-2" disabled={!loaded || !rect || busy} onClick={() => void use()}>
            {named ? (busy ? 'saving…' : 'save') : busy ? 'cutting…' : 'use it'}
          </Button>
        </div>
      </div>
    </dialog>
  );
}
