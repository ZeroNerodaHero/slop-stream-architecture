import { RiCloseLine, RiDeleteBinLine, RiFileCopyLine, RiPauseLine, RiPlayLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { type PointerEvent as ReactPointerEvent, type UIEvent, useLayoutEffect, useRef, useState } from 'react';

import {
  clearFrames,
  FRAME_DIRS,
  framesTickAtom,
  inspectorDirsAtom,
  inspectorFilterAtom,
  inspectorFrozenAtom,
  inspectorOpenAtom,
  inspectorPausedAtom,
  closeInspector,
  ring,
  setInspectorFilter,
  shownEntries,
  toggleInspectorDir,
  toggleInspectorPaused
} from '@/infra/atoms/inspector-atoms';
import { eventsPhaseAtom, eventsTransportAtom } from '@/infra/events';
import type { FrameEntry } from '@/infra/frames';
import { cn } from '@/utils/cn';

/** The panel look without its offset shadow, the corner player's rule for a floating box. */
const FRAME = 'border border-primaryStroke bg-backgroundSecondary';
const GRIP = 'touch-none select-none [-webkit-touch-callout:none]';
const MIN_W = 320;
const MIN_H = 200;
/** Within this many px of the newest row counts as "at the bottom". */
const STUCK_PX = 40;

const DIR_TONE: Record<FrameEntry['dir'], string> = {
  out: 'border-primaryBlue text-primaryBlue',
  in: 'border-secondaryStroke text-textSecondary',
  link: 'border-increase text-increase'
};

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const room = () => ({ w: document.documentElement.clientWidth, h: document.documentElement.clientHeight });

/** The time of a row, to the second, and the full stamp in its title. */
function clock(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour12: false });
}

/** The row's json, laid out, for the expanded view. The text as it came when it is not json. */
function pretty(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/**
 * The messages inspector (docs/status.md): the frames this browser sent and got on its three
 * sockets, the last 1000, newest at the bottom, with a filter and the direction toggles. A
 * `<dialog>` opened with `show()`, not `showModal()`: the frames worth watching are made by
 * using the page, and a modal would freeze it. Floats over every page (mounted by the Shell),
 * dragged by its header, resized from its corner. Renders nothing until `openInspector`.
 */
export function Inspector() {
  const open = useAtomValue(inspectorOpenAtom);
  return open ? <InspectorPanel /> : null;
}

function InspectorPanel() {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const stuck = useRef(true);
  const stop = useRef<(() => void) | null>(null);
  const [box, setBox] = useState<Box | null>(null);
  const [expanded, setExpanded] = useState<FrameEntry | null>(null);
  const [copied, setCopied] = useState(false);
  const tick = useAtomValue(framesTickAtom);
  const filter = useAtomValue(inspectorFilterAtom);
  const dirs = useAtomValue(inspectorDirsAtom);
  const paused = useAtomValue(inspectorPausedAtom);
  const frozen = useAtomValue(inspectorFrozenAtom);
  const phase = useAtomValue(eventsPhaseAtom);
  const transport = useAtomValue(eventsTransportAtom);

  // the rows: the ring through the filter, this tick. paused, the rows as they were when the pause
  // began (taken by the toggle itself) while the recorder goes on; the count line says how many came
  const rows = frozen?.rows ?? shownEntries(filter, dirs);
  const since = frozen ? ring.count - frozen.count : 0;

  // Mount only: shown, not modal. Closed on the way out. (The ring is kept whether or not this is
  // open: the setting is what records, this only shows.)
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.show();
    return () => {
      stop.current?.();
      if (dialog?.open) dialog.close();
    };
  }, []);

  // the newest row in view while the view sits at the bottom, like the chat
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stuck.current) el.scrollTop = el.scrollHeight;
  }, [tick, filter, dirs, paused]);

  function onScroll(e: UIEvent<HTMLUListElement>) {
    const el = e.currentTarget;
    stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STUCK_PX;
  }

  /** A press on the header (a move) or the corner (a resize): followed through window listeners, kept on screen. */
  const press = (e: ReactPointerEvent, kind: 'move' | 'resize') => {
    const el = dialogRef.current;
    if (e.button !== 0 || stop.current || !el) return;
    if ((e.target as Element).closest('button, input')) return;
    const rect = el.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const pointerId = e.pointerId;
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      const r = room();
      if (kind === 'move') {
        setBox({ x: clamp(rect.left + dx, 0, r.w - rect.width), y: clamp(rect.top + dy, 0, r.h - rect.height), w: rect.width, h: rect.height });
      } else {
        const w = clamp(rect.width + dx, MIN_W, r.w - rect.left);
        const h = clamp(rect.height + dy, MIN_H, r.h - rect.top);
        setBox({ x: rect.left, y: rect.top, w, h });
      }
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

  const copy = () => {
    void navigator.clipboard
      ?.writeText(JSON.stringify(rows, null, 2))
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => undefined);
  };

  return (
    <dialog
      ref={dialogRef}
      id="inspector-panel"
      aria-label="messages"
      onClose={closeInspector}
      style={box ? { left: box.x, top: box.y, width: box.w, height: box.h } : undefined}
      className={cn(
        FRAME,
        'fixed z-50 m-0 flex flex-col overflow-hidden p-0 text-sm text-textPrimary open:flex',
        !box && 'left-auto right-6 top-6 h-[min(440px,calc(100dvh-3rem))] w-[min(600px,calc(100vw-3rem))]'
      )}
    >
      <header
        className={cn('flex cursor-move items-center gap-2 border-b border-primaryStroke px-3 py-2', GRIP)}
        onPointerDown={(e) => press(e, 'move')}
        title="drag to move"
      >
        <span className="font-semibold">messages</span>
        <span className="text-xs text-textTertiary">
          /events {phase} · {transport === 'worker' ? 'one socket for the browser' : transport === 'tab' ? 'a socket for this tab' : 'no socket'}
        </span>
        <span className="ml-auto flex items-center gap-1">
          <button
            id="inspector-pause"
            type="button"
            aria-pressed={paused}
            aria-label={paused ? 'resume' : 'pause'}
            title={paused ? 'resume' : 'pause the view (the recorder goes on)'}
            onClick={toggleInspectorPaused}
            className={cn(
              'flex h-7 w-7 items-center justify-center border border-transparent hover:border-primaryBlue hover:text-primaryBlue',
              paused && 'border-primaryBlue text-primaryBlue'
            )}
          >
            {paused ? <RiPlayLine aria-hidden size={16} /> : <RiPauseLine aria-hidden size={16} />}
          </button>
          <button
            id="inspector-copy"
            type="button"
            aria-label="copy as json"
            title={copied ? 'copied' : 'copy the shown rows as json'}
            onClick={copy}
            className="flex h-7 w-7 items-center justify-center border border-transparent hover:border-primaryBlue hover:text-primaryBlue"
          >
            <RiFileCopyLine aria-hidden size={16} />
          </button>
          <button
            id="inspector-clear"
            type="button"
            aria-label="clear"
            title="clear"
            onClick={clearFrames}
            className="flex h-7 w-7 items-center justify-center border border-transparent hover:border-primaryBlue hover:text-primaryBlue"
          >
            <RiDeleteBinLine aria-hidden size={16} />
          </button>
          <button
            id="inspector-close"
            type="button"
            aria-label="close"
            title="close"
            onClick={closeInspector}
            className="flex h-7 w-7 items-center justify-center border border-transparent hover:border-primaryBlue hover:text-primaryBlue"
          >
            <RiCloseLine aria-hidden size={18} />
          </button>
        </span>
      </header>

      <div className="flex flex-wrap items-center gap-2 border-b border-primaryStroke px-3 py-2">
        <input
          id="inspector-filter"
          value={filter}
          onChange={(e) => setInspectorFilter(e.target.value)}
          placeholder="filter: a word in the frame, its type, its socket…"
          autoComplete="off"
          spellCheck={false}
          className="min-w-[160px] flex-1 border border-primaryStroke bg-background px-2 py-1 text-sm text-textPrimary placeholder:text-textTertiary"
        />
        <span id="inspector-types" role="group" aria-label="directions" className="flex gap-1">
          {FRAME_DIRS.map((dir) => (
            <button
              key={dir}
              id={`inspector-type-${dir}`}
              type="button"
              aria-pressed={dirs.has(dir)}
              onClick={() => toggleInspectorDir(dir)}
              className={cn('border px-2 py-0.5 text-xs uppercase tracking-wide', dirs.has(dir) ? DIR_TONE[dir] : 'border-primaryStroke text-textTertiary line-through')}
            >
              {dir}
            </button>
          ))}
        </span>
        <span id="inspector-count" className="text-xs text-textTertiary">
          {rows.length} of the last {ring.count}
          {since > 0 && ` · ${since} more since the pause`}
        </span>
      </div>

      <ul
        ref={listRef}
        onScroll={onScroll}
        id="inspector-frames"
        role="log"
        aria-live="off"
        className="min-h-0 flex-1 overflow-y-auto px-3 py-1 font-mono text-xs leading-5"
      >
        {rows.length === 0 && (
          <li id="inspector-notice" className="py-2 font-sans text-textTertiary">
            {ring.count === 0 ? 'nothing yet. the frames show up here as they come.' : 'nothing matches the filter.'}
          </li>
        )}
        {rows.map((e, i) => {
          const open = expanded === e;
          return (
            <li
              key={`${e.at}:${i}`}
              data-source={e.source}
              data-dir={e.dir}
              data-type={e.type}
              className="border-b border-primaryStroke/60 last:border-b-0 [content-visibility:auto]"
            >
              <button type="button" onClick={() => setExpanded(open ? null : e)} className="flex w-full items-baseline gap-2 py-1 text-left">
                <span className="w-[64px] shrink-0 tabular-nums text-textTertiary" title={new Date(e.at).toLocaleString()}>
                  {clock(e.at)}
                </span>
                <span className={cn('w-[34px] shrink-0 border text-center text-[10px] uppercase leading-4 tracking-wide', DIR_TONE[e.dir])}>{e.dir}</span>
                <span className="w-[80px] shrink-0 truncate text-textSecondary" title={e.source}>
                  {e.source}
                </span>
                <span className="w-[72px] shrink-0 truncate text-textPrimary">{e.type}</span>
                <span className="min-w-0 flex-1 truncate text-textSecondary">{e.text}</span>
                {e.bytes > e.text.length && <span className="shrink-0 text-textTertiary">{e.bytes} b</span>}
              </button>
              {open && (
                <pre className="mb-2 max-h-[240px] overflow-auto whitespace-pre-wrap border border-primaryStroke bg-backgroundTertiary p-2 text-textSecondary">
                  {pretty(e.text)}
                </pre>
              )}
            </li>
          );
        })}
      </ul>

      <div
        id="inspector-resize-se"
        aria-hidden
        onPointerDown={(e) => press(e, 'resize')}
        className={cn('absolute -bottom-px -right-px h-4 w-4 cursor-nwse-resize border-b-2 border-r-2 border-primaryBlue', GRIP)}
      />
    </dialog>
  );
}
