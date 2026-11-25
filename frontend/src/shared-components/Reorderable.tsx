import { RiDraggable } from '@remixicon/react';
import { type FocusEvent, type KeyboardEvent, type PointerEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

export function movedTo<K>(order: readonly K[], key: K, to: number): K[] {
  const from = order.indexOf(key);
  if (from < 0) return [...order];
  const at = Math.max(0, Math.min(order.length - 1, to));
  if (at === from) return [...order];
  const next = order.filter((item) => item !== key);
  next.splice(at, 0, key);
  return next;
}

function settle<K>(draft: readonly K[], keys: readonly K[]): K[] {
  return [...draft.filter((key) => keys.includes(key)), ...keys.filter((key) => !draft.includes(key))];
}

interface Box {
  top: number;
  bottom: number;
}

interface Grab<K> {
  key: K;
  start: K[];
  now: K[];
  pointerId: number | null;
  y: number;
  boxes: Map<K, Box>;
}

export interface ReorderOptions<K extends string> {
  keys: readonly K[];
  name: (key: K) => string;
  onMove: (key: K, to: number) => void;
  live?: boolean;
  keyedByIndex?: boolean;
  onPickUp?: (key: K) => void;
}

export function useReorder<K extends string>({ keys, name, onMove, live = false, keyedByIndex = false, onPickUp }: ReorderOptions<K>) {
  const [draft, setDraft] = useState<K[] | null>(null);
  const [held, setHeld] = useState<K | null>(null);
  const [byPointer, setByPointer] = useState(false);
  const [message, setMessage] = useState('');
  const listEl = useRef<HTMLElement | null>(null);
  const handles = useRef(new Map<K, HTMLButtonElement>());
  const grab = useRef<Grab<K> | null>(null);
  const refocus = useRef<{ key: K; at: number } | null>(null);
  const latest = useRef({ keys, name, onMove, live, keyedByIndex, onPickUp });
  useLayoutEffect(() => {
    latest.current = { keys, name, onMove, live, keyedByIndex, onPickUp };
  });

  const order = draft ? settle(draft, keys) : [...keys];

  useLayoutEffect(() => {
    const r = refocus.current;
    if (!r) return;
    refocus.current = null;
    const key = latest.current.keyedByIndex && !grab.current ? order[r.at] : r.key;
    if (key !== undefined) handles.current.get(key)?.focus();
  });

  const place = (key: K, list: readonly K[]) => `${latest.current.name(key)}, position ${list.indexOf(key) + 1} of ${list.length}`;

  const step = (g: Grab<K>, next: K[]) => {
    if (next.every((key, i) => key === g.now[i])) return;
    g.now = next;
    setDraft(next);
    setMessage(place(g.key, next));
    if (latest.current.live) latest.current.onMove(g.key, next.indexOf(g.key));
  };

  const finish = (keep: boolean) => {
    const g = grab.current;
    if (!g) return;
    grab.current = null;
    setHeld(null);
    setByPointer(false);
    setDraft(null);
    const { keys: now, onMove: move } = latest.current;
    const end = settle(keep ? g.now : g.start, now);
    const to = end.indexOf(g.key);
    if (to >= 0 && now.indexOf(g.key) !== to) move(g.key, to);
    if (g.pointerId === null) refocus.current = { key: g.key, at: to };
    setMessage(keep ? `dropped ${place(g.key, end)}` : `move cancelled. ${place(g.key, end)}`);
  };
  const finishRef = useRef(finish);
  useLayoutEffect(() => {
    finishRef.current = finish;
  });

  useEffect(() => {
    if (!byPointer) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      finishRef.current(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [byPointer]);

  const pickUp = (key: K, pointer: { id: number; y: number; boxes: Map<K, Box> } | null) => {
    grab.current = { key, start: order, now: order, pointerId: pointer?.id ?? null, y: pointer?.y ?? 0, boxes: pointer?.boxes ?? new Map() };
    setHeld(key);
    setByPointer(!!pointer);
    setMessage(pointer ? `picked up ${place(key, order)}` : `picked up ${place(key, order)}. the up and down arrows move it, space drops it, escape puts it back`);
    latest.current.onPickUp?.(key);
  };

  const onPointerDown = (e: PointerEvent<HTMLButtonElement>, key: K) => {
    if (e.button !== 0 || grab.current) return;
    const el = listEl.current;
    if (!el) return;
    e.preventDefault();
    const boxes = new Map<K, Box>();
    for (const row of Array.from(el.querySelectorAll<HTMLElement>(':scope > [data-reorder-item]'))) {
      const r = row.getBoundingClientRect();
      boxes.set(row.dataset.reorderItem as K, { top: r.top, bottom: r.bottom });
    }
    if (!boxes.has(key)) return;
    el.setPointerCapture(e.pointerId);
    pickUp(key, { id: e.pointerId, y: e.clientY, boxes });
  };

  const onPointerMove = (e: PointerEvent<HTMLElement>) => {
    const g = grab.current;
    if (!g || e.pointerId !== g.pointerId) return;
    const own = g.boxes.get(g.key);
    if (!own) return;
    const mid = (own.top + own.bottom) / 2 + e.clientY - g.y;
    const from = g.start.indexOf(g.key);
    let to = from;
    g.start.forEach((key, i) => {
      const box = g.boxes.get(key);
      if (!box || i === from) return;
      if (i < from && mid < box.bottom) to -= 1;
      if (i > from && mid > box.top) to += 1;
    });
    step(g, movedTo(g.start, g.key, to));
  };

  const onPointerEnd = (e: PointerEvent<HTMLElement>) => {
    const g = grab.current;
    if (!g || e.pointerId !== g.pointerId) return;
    finish(true);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, key: K) => {
    const g = grab.current;
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      if (!g) pickUp(key, null);
      else if (g.pointerId === null && g.key === key) finish(true);
      return;
    }
    if (!g || g.pointerId !== null || g.key !== key) return;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const to = g.now.indexOf(key) + (e.key === 'ArrowUp' ? -1 : 1);
      if (to < 0 || to >= g.now.length) return;
      refocus.current = { key, at: to };
      step(g, movedTo(g.now, key, to));
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      finish(false);
    }
  };

  const onBlur = (e: FocusEvent<HTMLButtonElement>, key: K) => {
    const g = grab.current;
    if (refocus.current || !g || g.pointerId !== null || g.key !== key || e.relatedTarget === e.currentTarget) return;
    finish(true);
  };

  const setList = useCallback((el: HTMLElement | null) => {
    listEl.current = el;
  }, []);

  return {
    order,
    held,
    list: { ref: setList, onPointerMove, onPointerUp: onPointerEnd, onPointerCancel: onPointerEnd, onLostPointerCapture: onPointerEnd },
    item: (key: K) => ({ 'data-reorder-item': key }),
    handle: (key: K) => ({
      label: name(key),
      held: held === key,
      handleRef: (el: HTMLButtonElement | null) => {
        if (el) handles.current.set(key, el);
        else handles.current.delete(key);
      },
      onPointerDown: (e: PointerEvent<HTMLButtonElement>) => onPointerDown(e, key),
      onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => onKeyDown(e, key),
      onBlur: (e: FocusEvent<HTMLButtonElement>) => onBlur(e, key)
    }),
    status: (
      <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {message}
      </span>
    )
  };
}

export interface DragHandleProps {
  id?: string;
  label: string;
  held: boolean;
  handleRef: (el: HTMLButtonElement | null) => void;
  onPointerDown: (e: PointerEvent<HTMLButtonElement>) => void;
  onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void;
  onBlur: (e: FocusEvent<HTMLButtonElement>) => void;
  className?: string;
}

export function DragHandle({ id, label, held, handleRef, onPointerDown, onKeyDown, onBlur, className }: DragHandleProps) {
  return (
    <Tooltip content={held ? null : 'drag to move'}>
      <button
        id={id}
        ref={handleRef}
        type="button"
        aria-label={`move ${label}`}
        aria-roledescription="drag handle"
        aria-pressed={held || undefined}
        aria-keyshortcuts="Space ArrowUp ArrowDown Escape"
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
        className={cn(
          'flex shrink-0 touch-none select-none items-center justify-center rounded-control border border-transparent p-0.5 text-textTertiary transition-colors duration-150 hover:text-textPrimary focus-visible:border-primaryBlue focus-visible:outline-none',
          held ? 'cursor-grabbing border-primaryBlue text-primaryBlue' : 'cursor-grab active:cursor-grabbing',
          className
        )}
      >
        <RiDraggable aria-hidden size={16} />
      </button>
    </Tooltip>
  );
}
