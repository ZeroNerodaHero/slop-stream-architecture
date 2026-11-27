import {
  RiArrowLeftSLine,
  RiArrowRightSLine,
  RiBarChart2Line,
  RiCalendarLine,
  RiCheckboxBlankLine,
  RiDeleteBinLine,
  RiDoubleQuotesL,
  RiFileCopyLine,
  RiGalleryView2,
  RiGroupLine,
  RiHeading,
  RiImageLine,
  RiMusic2Line,
  RiSeparator,
  RiStackLine,
  RiText,
  RiVideoLine
} from '@remixicon/react';
import { type DragEvent, type KeyboardEvent, type PointerEvent, type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import {
  type AboutBlock,
  type AboutPage,
  BLOCK_KINDS,
  BLOCKS_MAX,
  type BlockKind,
  GRID,
  blockWord,
  clampSpan,
  moved,
  newId,
  starterBlock,
  wireBlock
} from '@/infra/about-blocks';
import { api } from '@/infra/api';
import { Button } from '@/shared-components/Button';
import { DragHandle, useReorder } from '@/shared-components/Reorderable';
import { Segmented } from '@/shared-components/Segmented';
import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

import { cellStyle, GridFrame, PHONE_AT, shownOn, useWidth } from './AboutGrid';
import { BlockSettings } from './BlockSettings';
import { BlockView, type PageMeta } from './BlockView';
import { PageView } from './PageView';

const KIND_ICON: Record<BlockKind, ReactNode> = {
  heading: <RiHeading size={14} aria-hidden />,
  text: <RiText size={14} aria-hidden />,
  panel: <RiStackLine size={14} aria-hidden />,
  image: <RiImageLine size={14} aria-hidden />,
  gallery: <RiGalleryView2 size={14} aria-hidden />,
  buttons: <RiCheckboxBlankLine size={14} aria-hidden />,
  socials: <RiGroupLine size={14} aria-hidden />,
  schedule: <RiCalendarLine size={14} aria-hidden />,
  clip: <RiVideoLine size={14} aria-hidden />,
  sound: <RiMusic2Line size={14} aria-hidden />,
  stats: <RiBarChart2Line size={14} aria-hidden />,
  quote: <RiDoubleQuotesL size={14} aria-hidden />,
  divider: <RiSeparator size={14} aria-hidden />
};

const DRAG_TYPE = 'application/x-about-kind';
const LABEL = 'text-[11px] font-semibold uppercase tracking-wider text-textTertiary';
const TOOL =
  'flex size-6 items-center justify-center rounded-control border border-primaryStroke bg-backgroundSecondary text-textSecondary transition-colors hover:border-primaryBlue hover:text-textPrimary disabled:opacity-40 disabled:hover:border-primaryStroke';

type View = 'desktop' | 'phone';

function agoWord(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 5) return 'saved just now';
  if (s < 60) return `saved ${s}s ago`;
  return `saved ${Math.floor(s / 60)}m ago`;
}

function kindOf(e: DragEvent): BlockKind | null {
  const kind = e.dataTransfer.getData(DRAG_TYPE);
  return (BLOCK_KINDS as readonly string[]).includes(kind) ? (kind as BlockKind) : null;
}

function Resize({ span, onSpan, grid }: { span: number; onSpan: (n: number) => void; grid: () => HTMLElement | null }) {
  const grab = useRef<{ x: number; span: number; col: number } | null>(null);
  const [held, setHeld] = useState(false);
  const onPointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    const el = grid();
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    grab.current = { x: e.clientX, span, col: el.getBoundingClientRect().width / GRID };
    setHeld(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLButtonElement>) => {
    const g = grab.current;
    if (!g) return;
    const next = clampSpan(g.span + (e.clientX - g.x) / g.col);
    if (next !== span) onSpan(next);
  };
  const end = () => {
    grab.current = null;
    setHeld(false);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const by = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!by) return;
    e.preventDefault();
    onSpan(clampSpan(span + by));
  };
  return (
    <span className="absolute -right-1.5 top-1/2 flex -translate-y-1/2">
      <Tooltip content={`drag to resize · ${span}/${GRID}`} at="bottom">
        <button
          id="about-resize"
          type="button"
          role="slider"
          aria-label="width"
          aria-valuemin={3}
          aria-valuemax={GRID}
          aria-valuenow={span}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={end}
          onPointerCancel={end}
          onKeyDown={onKeyDown}
          className={cn('h-8 w-2 cursor-ew-resize touch-none rounded-control border border-primaryBlue bg-primaryBlue', held && 'bg-textPrimary')}
        />
      </Tooltip>
    </span>
  );
}

export function AboutEditor({ name, start, meta, onClose }: { name: string; start: AboutPage; meta: PageMeta; onClose: (live: AboutPage | null) => void }) {
  const [blocks, setBlocks] = useState<AboutBlock[]>(start.blocks);
  const [sel, setSel] = useState<string | null>(start.blocks[0]?.id ?? null);
  const [view, setView] = useState<View>('desktop');
  const [preview, setPreview] = useState(false);
  const [changed, setChanged] = useState(Boolean(start.changed));
  const [status, setStatus] = useState('');
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const published = useRef<AboutPage | null>(null);
  const [frame, setFrame] = useState<HTMLDivElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const width = useWidth(frame);
  const layout = width >= 900 ? 'wide' : width >= 600 ? 'mid' : 'narrow';
  const narrow = layout !== 'wide';
  const dirty = useRef(false);
  const timer = useRef<number | null>(null);
  const saving = useRef<Promise<void>>(Promise.resolve());
  const latest = useRef(blocks);
  useLayoutEffect(() => {
    latest.current = blocks;
  }, [blocks]);

  const save = useCallback(
    (list: AboutBlock[]) => {
      const run = saving.current.then(async () => {
        try {
          const page = await api.saveAboutDraft(name, list.map(wireBlock));
          setChanged(page.changed ?? true);
          setSavedAt(Date.now());
          setStatus('');
        } catch (err: unknown) {
          setStatus(`not saved: ${err instanceof Error ? err.message : 'could not save'}`);
        }
      });
      saving.current = run;
      return run;
    },
    [name]
  );

  const flush = useCallback(async () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    if (dirty.current) {
      dirty.current = false;
      await save(latest.current);
    } else await saving.current;
  }, [save]);

  useEffect(() => {
    if (!dirty.current) return;
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      dirty.current = false;
      void save(latest.current);
    }, 700);
  }, [blocks, save]);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      if (dirty.current) void save(latest.current);
    },
    [save]
  );

  useEffect(() => {
    if (savedAt === null) return;
    const t = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(t);
  }, [savedAt]);

  const touch = (fn: (list: AboutBlock[]) => AboutBlock[]) => {
    dirty.current = true;
    setBlocks(fn);
  };
  const patch = (id: string, part: Partial<AboutBlock>) => touch((list) => list.map((b) => (b.id === id ? { ...b, ...part, html: undefined } : b)));

  const add = (kind: BlockKind, after?: string) => {
    if (blocks.length >= BLOCKS_MAX) {
      setStatus(`${BLOCKS_MAX} blocks at most`);
      return;
    }
    const block = starterBlock(kind);
    const anchor = after ?? sel;
    touch((list) => {
      const at = anchor ? list.findIndex((b) => b.id === anchor) : -1;
      const next = [...list];
      next.splice(at < 0 ? next.length : at + 1, 0, block);
      return next;
    });
    setSel(block.id);
  };
  const move = (id: string, to: number) =>
    touch((list) =>
      moved(
        list,
        list.findIndex((b) => b.id === id),
        to
      )
    );
  const copy = (id: string) => {
    const src = blocks.find((b) => b.id === id);
    if (!src || blocks.length >= BLOCKS_MAX) return;
    const twin = { ...src, id: newId(), items: src.items.map((i) => ({ ...i })) };
    touch((list) => {
      const next = [...list];
      next.splice(list.findIndex((b) => b.id === id) + 1, 0, twin);
      return next;
    });
    setSel(twin.id);
  };
  const remove = (id: string) => {
    const at = blocks.findIndex((b) => b.id === id);
    touch((list) => list.filter((b) => b.id !== id));
    setSel(blocks[at + 1]?.id ?? blocks[at - 1]?.id ?? null);
  };

  const publish = async () => {
    await flush();
    try {
      const page = await api.publishAbout(name);
      published.current = page;
      setChanged(Boolean(page.changed));
      setStatus('published');
    } catch (err: unknown) {
      setStatus(`not published: ${err instanceof Error ? err.message : 'could not publish'}`);
    }
  };
  const done = async () => {
    await flush();
    onClose(published.current);
  };
  const upload = async (kind: 'image' | 'video' | 'sound', file: File) => {
    const saved = await api.saveAboutFile(name, kind, file);
    return saved.id;
  };

  const reorder = useReorder({ keys: blocks.map((b) => b.id), name: (id) => blockWord(blocks.find((b) => b.id === id) ?? starterBlock('text')), onMove: move });
  const selIndex = blocks.findIndex((b) => b.id === sel);
  const selected = selIndex >= 0 ? blocks[selIndex] : undefined;
  const small = width > 0 && width < PHONE_AT;
  const phone = view === 'phone' || small;

  const dropOn = (after: string | undefined) => ({
    onDragOver: (e: DragEvent) => {
      if (e.dataTransfer.types.includes(DRAG_TYPE)) e.preventDefault();
    },
    onDrop: (e: DragEvent) => {
      const kind = kindOf(e);
      if (!kind) return;
      e.preventDefault();
      add(kind, after ?? blocks[blocks.length - 1]?.id);
    }
  });

  const palette = (
    <div className="flex flex-col gap-1.5">
      <span className={LABEL}>add</span>
      <div className={cn('flex gap-1', narrow ? 'flex-wrap' : 'flex-col')}>
        {BLOCK_KINDS.map((kind) => (
          <button
            key={kind}
            id={`about-add-${kind}`}
            type="button"
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(DRAG_TYPE, kind);
              e.dataTransfer.effectAllowed = 'copy';
            }}
            onClick={() => add(kind)}
            className="flex h-7 items-center gap-2 rounded-control border border-primaryStroke bg-backgroundSecondary px-2 text-xs text-textPrimary transition-colors hover:border-primaryBlue"
          >
            <span className="text-textTertiary">{KIND_ICON[kind]}</span>
            {kind}
          </button>
        ))}
      </div>
    </div>
  );

  const layers = blocks.length > 0 && (
    <div className="flex flex-col gap-1.5">
      <span className={LABEL}>blocks</span>
      <ul {...reorder.list} id="about-layers" className="m-0 flex list-none flex-col gap-0.5 p-0">
        {reorder.order.map((id) => {
          const b = blocks.find((x) => x.id === id);
          if (!b) return null;
          return (
            <li
              key={id}
              {...reorder.item(id)}
              className={cn('flex min-w-0 items-center gap-1 rounded-control border px-1', id === sel ? 'border-primaryBlue bg-primaryBlue/10' : 'border-transparent')}
            >
              <DragHandle {...reorder.handle(id)} />
              <button
                type="button"
                id={`about-layer-${id}`}
                onClick={() => setSel(id)}
                className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left text-xs text-textSecondary hover:text-textPrimary"
              >
                <span className="shrink-0 text-textTertiary">{KIND_ICON[b.kind]}</span>
                <span className="min-w-0 truncate">{blockWord(b)}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {reorder.status}
    </div>
  );

  const canvas =
    blocks.length === 0 ? (
      <div className="flex flex-col gap-2 rounded-card border border-dashed border-secondaryStroke p-3">
        <p className="text-sm text-textSecondary">add blocks on the left.</p>
      </div>
    ) : (
      <div className={cn(phone && 'mx-auto w-[390px] max-w-full rounded-panel border border-primaryStroke bg-background p-2')}>
        <div ref={gridRef} className="relative">
          {!phone && (
            <div aria-hidden className="pointer-events-none absolute inset-0 grid grid-cols-12 gap-2">
              {Array.from({ length: GRID }, (_, i) => (
                <span key={i} className="rounded-control bg-primaryBlue/[0.04]" />
              ))}
            </div>
          )}
          <GridFrame phone={phone}>
            {blocks.map((b, i) => {
              if (!shownOn(b, phone)) return null;
              const on = b.id === sel;
              return (
                <div key={b.id} data-block={b.id} data-kind={b.kind} style={cellStyle(b, phone)} className="relative min-w-0" {...dropOn(b.id)}>
                  <div
                    role="button"
                    tabIndex={0}
                    aria-label={`select ${blockWord(b)}`}
                    aria-pressed={on}
                    onClick={() => setSel(b.id)}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter' && e.key !== ' ') return;
                      e.preventDefault();
                      setSel(b.id);
                    }}
                    className={cn(
                      'h-full cursor-pointer rounded-card outline-offset-2 focus-visible:outline focus-visible:outline-1 focus-visible:outline-primaryBlue',
                      on ? 'outline outline-2 outline-primaryBlue' : 'hover:outline hover:outline-1 hover:outline-secondaryStroke'
                    )}
                  >
                    <div className="pointer-events-none h-full">
                      <BlockView b={b} name={name} meta={meta} phone={phone} edit />
                    </div>
                  </div>
                  {on && (
                    <>
                      <div role="toolbar" aria-label="block" className="absolute -top-3 left-2 flex gap-0.5">
                        <Tooltip content="move earlier">
                          <button id="about-move-earlier" type="button" aria-label="move earlier" disabled={i === 0} onClick={() => move(b.id, i - 1)} className={TOOL}>
                            <RiArrowLeftSLine size={14} aria-hidden />
                          </button>
                        </Tooltip>
                        <Tooltip content="move later">
                          <button
                            id="about-move-later"
                            type="button"
                            aria-label="move later"
                            disabled={i === blocks.length - 1}
                            onClick={() => move(b.id, i + 1)}
                            className={TOOL}
                          >
                            <RiArrowRightSLine size={14} aria-hidden />
                          </button>
                        </Tooltip>
                        <Tooltip content="copy">
                          <button id="about-copy" type="button" aria-label="copy" onClick={() => copy(b.id)} className={TOOL}>
                            <RiFileCopyLine size={14} aria-hidden />
                          </button>
                        </Tooltip>
                        <Tooltip content="delete">
                          <button
                            id="about-delete"
                            type="button"
                            aria-label="delete"
                            onClick={() => remove(b.id)}
                            className={cn(TOOL, 'text-decrease hover:border-decrease hover:text-decrease')}
                          >
                            <RiDeleteBinLine size={14} aria-hidden />
                          </button>
                        </Tooltip>
                      </div>
                      {!phone && <Resize span={b.span} onSpan={(span) => patch(b.id, { span })} grid={() => gridRef.current} />}
                    </>
                  )}
                </div>
              );
            })}
            {blocks.length < BLOCKS_MAX && (
              <button
                id="about-drop"
                type="button"
                style={{ gridColumn: phone ? 'span 2 / span 2' : 'span 3 / span 3' }}
                onClick={() => add('text', blocks[blocks.length - 1]?.id)}
                {...dropOn(undefined)}
                className="flex min-h-10 items-center justify-center gap-1 rounded-card border border-dashed border-secondaryStroke text-xs text-textTertiary transition-colors hover:border-primaryBlue hover:text-textPrimary"
              >
                + drop here
              </button>
            )}
          </GridFrame>
        </div>
      </div>
    );

  const inspector = selected ? (
    <BlockSettings key={selected.id} block={selected} index={selIndex} count={blocks.length} name={name} onPatch={(part) => patch(selected.id, part)} upload={upload} />
  ) : (
    <p className="text-sm text-textTertiary">pick a block to change it.</p>
  );

  return (
    <div ref={setFrame} id="about-editor" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {!small && (
          <Segmented
            id="about-view"
            label="preview size"
            value={view}
            options={[
              { value: 'desktop', label: 'desktop' },
              { value: 'phone', label: 'phone' }
            ]}
            onChange={setView}
            className="[&_[aria-checked=true]]:text-primaryBlue"
          />
        )}
        <span role="status" className="ml-auto min-w-0 truncate text-xs text-textTertiary">
          {status || (savedAt !== null ? agoWord(savedAt, Math.max(now, savedAt)) : changed ? 'not published yet' : '')}
        </span>
        <Button id="about-preview" size="sm" className="px-2.5 py-1 text-xs max-md:min-h-0" aria-pressed={preview} onClick={() => setPreview((p) => !p)}>
          {preview ? 'edit' : 'preview'}
        </Button>
        <Button id="about-publish" size="sm" variant="outline" className="px-2.5 py-1 text-xs max-md:min-h-0" disabled={!changed} onClick={() => void publish()}>
          publish
        </Button>
        <Button id="about-done" size="sm" variant="primary" className="px-2.5 py-1 text-xs max-md:min-h-0" onClick={() => void done()}>
          done
        </Button>
      </div>
      {preview ? (
        <div id="about-preview-page" className={cn(phone && 'mx-auto w-[390px] max-w-full rounded-panel border border-primaryStroke bg-background p-2')}>
          <PageView blocks={blocks} meta={meta} name={name} phone={phone} />
        </div>
      ) : layout === 'narrow' ? (
        <div className="flex flex-col gap-3">
          {palette}
          {canvas}
          {layers}
          <div className="rounded-card border border-primaryStroke p-2.5">{inspector}</div>
        </div>
      ) : layout === 'mid' ? (
        <div className="flex flex-col gap-3">
          {palette}
          <div className="grid grid-cols-[minmax(0,1fr)_17rem] items-start gap-3">
            {canvas}
            <div className="flex flex-col gap-3">
              <div className="rounded-card border border-primaryStroke p-2.5">{inspector}</div>
              {layers}
            </div>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-[8rem_minmax(0,1fr)_17rem] items-start gap-3">
          <div className="flex flex-col gap-3">
            {palette}
            {layers}
          </div>
          {canvas}
          <div className="rounded-card border border-primaryStroke p-2.5">{inspector}</div>
        </div>
      )}
    </div>
  );
}
