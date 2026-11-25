import { RiCloseLine, RiDeleteBinLine, RiFileCopyLine, RiPauseLine, RiPlayLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { type UIEvent, useLayoutEffect, useRef, useState } from 'react';

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
  frameRing,
  setInspectorFilter,
  shownEntries,
  toggleInspectorDir,
  toggleInspectorPaused
} from '@/infra/atoms/inspector-atoms';
import type { FrameEntry } from '@/infra/frames';
import { useIsMobile } from '@/infra/mobile';
import { SocketRow } from '@/shared-components/debug/SocketRow';
import { FRAME, GRIP, useDialogBox } from '@/shared-components/debug/useDialogBox';
import { SHEET_CLOSE, SheetGrab, useSheetBack } from '@/shared-components/MobileSheet';
import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

const STUCK_PX = 40;

const DIR_TONE: Record<FrameEntry['dir'], string> = {
  out: 'border-primaryBlue text-primaryBlue',
  in: 'border-secondaryStroke text-textSecondary',
  link: 'border-increase text-increase'
};

function clock(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour12: false });
}

function pretty(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

export function Inspector() {
  const open = useAtomValue(inspectorOpenAtom);
  return open ? <InspectorPanel /> : null;
}

function InspectorPanel() {
  const { dialogRef, box, press } = useDialogBox('messages');
  const listRef = useRef<HTMLUListElement | null>(null);
  const stuck = useRef(true);
  const [expanded, setExpanded] = useState<FrameEntry | null>(null);
  const [copied, setCopied] = useState(false);
  const tick = useAtomValue(framesTickAtom);
  const filter = useAtomValue(inspectorFilterAtom);
  const dirs = useAtomValue(inspectorDirsAtom);
  const paused = useAtomValue(inspectorPausedAtom);
  const frozen = useAtomValue(inspectorFrozenAtom);
  const mobile = useIsMobile();
  useSheetBack(closeInspector);

  const count = frameRing()?.count ?? 0;
  const rows = frozen?.rows ?? shownEntries(filter, dirs);
  const since = frozen ? count - frozen.count : 0;

  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stuck.current) el.scrollTop = el.scrollHeight;
  }, [tick, filter, dirs, paused]);

  function onScroll(e: UIEvent<HTMLUListElement>) {
    const el = e.currentTarget;
    stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STUCK_PX;
  }

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
      data-sheet={mobile ? '' : undefined}
      style={box && !mobile ? { left: box.x, top: box.y, width: box.w, height: box.h } : undefined}
      className={cn(
        FRAME,
        'fixed z-50 m-0 flex flex-col overflow-hidden p-0 text-sm text-textPrimary open:flex',
        mobile
          ? 'inset-x-0 bottom-0 top-auto h-[60dvh] w-full max-w-none border-x-0 border-b-0 pb-[env(safe-area-inset-bottom)]'
          : !box && 'left-auto right-6 top-6 h-[min(440px,calc(100dvh-3rem))] w-[min(600px,calc(100vw-3rem))]'
      )}
    >
      {mobile && <SheetGrab onDismiss={closeInspector} />}
      <header
        className={cn('flex cursor-move items-center gap-2 border-b border-primaryStroke px-3 py-2', GRIP, mobile && 'cursor-auto')}
        onPointerDown={(e) => {
          if (!mobile) press(e, 'move');
        }}
        title={mobile ? undefined : 'drag to move'}
      >
        <span className="font-semibold">messages</span>
        <span className="ml-auto flex items-center gap-1">
          <Tooltip content={paused ? 'resume' : 'pause the view (the recorder goes on)'}>
            <button
              id="inspector-pause"
              type="button"
              aria-pressed={paused}
              aria-label={paused ? 'resume' : 'pause'}
              onClick={toggleInspectorPaused}
              className={cn(
                'flex h-7 w-7 items-center justify-center border border-transparent hover:border-primaryBlue hover:text-primaryBlue',
                paused && 'border-primaryBlue text-primaryBlue'
              )}
            >
              {paused ? <RiPlayLine aria-hidden size={16} /> : <RiPauseLine aria-hidden size={16} />}
            </button>
          </Tooltip>
          <Tooltip content={copied ? 'copied' : 'copy the shown rows as json'}>
            <button
              id="inspector-copy"
              type="button"
              aria-label="copy as json"
              onClick={copy}
              className="flex h-7 w-7 items-center justify-center border border-transparent hover:border-primaryBlue hover:text-primaryBlue"
            >
              <RiFileCopyLine aria-hidden size={16} />
            </button>
          </Tooltip>
          <Tooltip content="clear">
            <button
              id="inspector-clear"
              type="button"
              aria-label="clear"
              onClick={clearFrames}
              className="flex h-7 w-7 items-center justify-center border border-transparent hover:border-primaryBlue hover:text-primaryBlue"
            >
              <RiDeleteBinLine aria-hidden size={16} />
            </button>
          </Tooltip>
          <Tooltip content="close">
            <button
              id="inspector-close"
              type="button"
              aria-label="close"
              onClick={closeInspector}
              className={cn('flex h-7 w-7 items-center justify-center border border-transparent hover:border-primaryBlue hover:text-primaryBlue', SHEET_CLOSE)}
            >
              <RiCloseLine aria-hidden size={18} />
            </button>
          </Tooltip>
        </span>
      </header>
      <SocketRow />

      <div className="flex flex-wrap items-center gap-2 border-b border-primaryStroke px-3 py-2">
        <input
          id="inspector-filter"
          value={filter}
          onChange={(e) => setInspectorFilter(e.target.value)}
          placeholder="filter"
          aria-label="filter: a word in the frame, its type, its socket…"
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
          {rows.length} of the last {count}
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
            {count === 0 ? 'nothing yet. the frames show up here as they come.' : 'nothing matches the filter.'}
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

      {!mobile && (
        <div
          id="inspector-resize-se"
          aria-hidden
          onPointerDown={(e) => press(e, 'resize')}
          className={cn('absolute -bottom-px -right-px h-4 w-4 cursor-nwse-resize border-b-2 border-r-2 border-primaryBlue', GRIP)}
        />
      )}
    </dialog>
  );
}
