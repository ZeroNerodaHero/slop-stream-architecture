import {
  RiAddLine,
  RiArrowLeftLine,
  RiArrowRightLine,
  RiCloseLine,
  RiDeleteBinLine,
  RiImageLine,
  RiMusic2Line,
  RiPencilLine,
  RiRefreshLine,
  RiText,
  RiVideoLine
} from '@remixicon/react';
import { type CSSProperties, type ChangeEvent, type PointerEvent as ReactPointerEvent, type ReactNode, useEffect, useRef, useState } from 'react';

import { BLOCKS_MAX, TEXT_MAX, sanitizeHtml } from '@/infra/about';
import { type PageWire, api } from '@/infra/api';
import { ExternalLink } from '@/shared-components/ExternalLink';
import { DragHandle, movedTo, useReorder } from '@/shared-components/Reorderable';
import { Tooltip, type TooltipAt } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

type Kind = 'text' | 'image' | 'video' | 'audio';

interface Cell {
  key: string;
  kind: Kind;
  id: number;
  cols: number;
  html: string;
  src: string;
  poster?: string;
}

interface Row {
  key: string;
  cells: Cell[];
}

const KINDS: readonly Kind[] = ['text', 'image', 'video', 'audio'];
const COLS = 12;
const COLS_MIN = 2;
const CELLS_MAX = COLS / COLS_MIN;
const GAP = 16;
const UNIT = 800 / COLS;
const HEIGHT: Record<Kind, number> = { text: 120, image: 180, video: 200, audio: 56 };
const WIRE: Record<Kind, PageWire['type']> = { text: 'text', image: 'image', video: 'video', audio: 'sound' };
const ACCEPT: Record<Exclude<Kind, 'text'>, string> = { image: 'image/*', video: 'video/mp4,video/webm', audio: 'audio/*' };
const NEW = 'new';

const ADD = 'text-sm font-semibold text-primaryBlue disabled:opacity-40';
const LABEL = 'text-xs font-semibold uppercase tracking-wider text-textTertiary';
const DASHED = 'border border-dashed border-primaryStroke';
const ICON = 'flex h-6 w-6 shrink-0 items-center justify-center text-textSecondary hover:text-textPrimary disabled:opacity-40 disabled:hover:text-textSecondary';
const PLATE = 'flex gap-0.5 border border-primaryStroke bg-background/90 p-0.5';
const inset = (n: number) => 6 + (n * 26 + 4) + 8;
const KIND_ICON: Record<Kind, ReactNode> = {
  text: <RiText size={16} aria-hidden />,
  image: <RiImageLine size={16} aria-hidden />,
  video: <RiVideoLine size={16} aria-hidden />,
  audio: <RiMusic2Line size={16} aria-hidden />
};

const uid = () => Math.random().toString(36).slice(2, 8);

function makeCell(kind: Kind, part: Partial<Cell> = {}): Cell {
  return { key: uid(), kind, id: 0, cols: COLS, html: '', src: '', ...part };
}

function filled(cell: Cell): boolean {
  return cell.kind === 'text' ? sanitizeHtml(cell.html).length > 0 : cell.src.length > 0;
}

function used(row: Row): number {
  return row.cells.reduce((sum, cell) => sum + cell.cols, 0);
}

function count(rows: Row[]): number {
  return rows.reduce((sum, row) => sum + row.cells.length, 0);
}

function revoke(src: string | undefined): void {
  if (src?.startsWith('blob:')) URL.revokeObjectURL(src);
}

function fmtClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function kindOf(type: PageWire['type']): Kind | null {
  if (type === 'text' || type === 'image' || type === 'video') return type;
  if (type === 'sound') return 'audio';
  return null;
}

function rowsOf(blocks: PageWire[]): Row[] {
  const byY = new Map<number, PageWire[]>();
  for (const block of blocks) {
    if (!kindOf(block.type)) continue;
    const list = byY.get(block.y) ?? [];
    list.push(block);
    byY.set(block.y, list);
  }
  const rows: Row[] = [];
  for (const y of [...byY.keys()].sort((a, b) => a - b)) {
    const list = (byY.get(y) ?? []).sort((a, b) => a.x - b.x || a.z - b.z);
    let row: Row = { key: uid(), cells: [] };
    for (const block of list) {
      const kind = kindOf(block.type);
      if (!kind) continue;
      const cols = Math.max(COLS_MIN, Math.min(COLS, Math.round((block.w ?? UNIT * 4) / UNIT)));
      if (row.cells.length > 0 && (used(row) + cols > COLS || row.cells.length >= CELLS_MAX)) {
        rows.push(row);
        row = { key: uid(), cells: [] };
      }
      row.cells.push(makeCell(kind, { id: block.id, cols, html: kind === 'text' ? (block.html ?? '') : '', src: block.src ?? '' }));
    }
    if (row.cells.length > 0) rows.push(row);
  }
  return rows;
}

function blocksOf(rows: Row[]): PageWire[] {
  const out: PageWire[] = [];
  rows.forEach((row, y) => {
    let start = 0;
    row.cells.forEach((cell, z) => {
      const x = Math.round(start * UNIT);
      start += cell.cols;
      if (cell.kind !== 'text' && cell.id <= 0) return;
      const block: PageWire = { type: WIRE[cell.kind], id: Math.max(0, cell.id), x, y, z, w: Math.round(cell.cols * UNIT), h: HEIGHT[cell.kind] };
      if (cell.kind === 'text') block.html = sanitizeHtml(cell.html);
      out.push(block);
    });
  });
  return out;
}

function Rich({ html }: { html: string }) {
  const safe = sanitizeHtml(html);
  if (!safe) return null;
  const doc = new DOMParser().parseFromString(safe, 'text/html');
  return <div className="about-text whitespace-pre-wrap [overflow-wrap:anywhere]">{[...doc.body.childNodes].map((node, i) => richNode(node, `t${i}`))}</div>;
}

function richNode(node: Node, key: string): ReactNode {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent;
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  const el = node as HTMLElement;
  const name = el.tagName.toLowerCase();
  const kids = [...el.childNodes].map((child, i) => richNode(child, `${key}-${i}`));
  if (name === 'br') return <br key={key} />;
  if (name === 'a') {
    return (
      <ExternalLink
        key={key}
        href={el.getAttribute('href') ?? ''}
        from="external link"
        className="text-primaryBlue hover:underline"
      >
        {kids}
      </ExternalLink>
    );
  }
  if (name === 'p') return <p key={key}>{kids}</p>;
  if (name === 'b' || name === 'strong') return <strong key={key}>{kids}</strong>;
  if (name === 'i' || name === 'em') return <em key={key}>{kids}</em>;
  if (name === 'u') return <u key={key}>{kids}</u>;
  if (name === 's') return <s key={key}>{kids}</s>;
  if (name === 'ul')
    return (
      <ul key={key} className="list-disc pl-5">
        {kids}
      </ul>
    );
  if (name === 'ol')
    return (
      <ol key={key} className="list-decimal pl-5">
        {kids}
      </ol>
    );
  if (name === 'li') return <li key={key}>{kids}</li>;
  if (name === 'h2')
    return (
      <h2 key={key} className="text-lg font-semibold">
        {kids}
      </h2>
    );
  if (name === 'h3')
    return (
      <h3 key={key} className="font-semibold">
        {kids}
      </h3>
    );
  if (name === 'blockquote') return <blockquote key={key}>{kids}</blockquote>;
  return <span key={key}>{kids}</span>;
}

function TextEditor({ html, autoFocus, inset, onChange }: { html: string; autoFocus: boolean; inset: number; onChange: (html: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const last = useRef(html);
  useEffect(() => {
    const el = ref.current;
    if (!el || document.activeElement === el) return;
    if (el.innerHTML !== html) el.innerHTML = html;
    last.current = html;
  }, [html]);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);
  return (
    <div
      ref={ref}
      contentEditable
      role="textbox"
      aria-label="text"
      aria-multiline
      data-placeholder="about"
      suppressContentEditableWarning
      onInput={() => {
        const el = ref.current;
        if (!el) return;
        const next = sanitizeHtml(el.innerHTML);
        if (next.length > TEXT_MAX) {
          el.innerHTML = last.current;
          return;
        }
        last.current = next;
        onChange(next);
      }}
      onBlur={() => {
        const el = ref.current;
        if (!el) return;
        const next = sanitizeHtml(el.innerHTML);
        el.innerHTML = next;
        last.current = next;
        onChange(next);
      }}
      style={{ '--inset': `${inset}px` } as CSSProperties}
      className="about-text min-h-[3.5rem] whitespace-pre-wrap border border-primaryStroke bg-background px-2 py-1 outline-none [overflow-wrap:anywhere] before:float-right before:h-7 before:w-[var(--inset)] before:content-[''] focus:border-primaryBlue empty:after:text-textTertiary empty:after:content-[attr(data-placeholder)]"
    />
  );
}

function Icon({ label, at, onClick, disabled, children }: { label: string; at?: TooltipAt; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <Tooltip content={label} at={at}>
      <button type="button" aria-label={label} disabled={disabled} onClick={onClick} className={ICON}>
        {children}
      </button>
    </Tooltip>
  );
}

function PlayGlyph({ size, playing = false }: { size: number; playing?: boolean }) {
  return (
    <svg aria-hidden viewBox="0 0 24 24" width={size} height={size} fill="currentColor">
      {playing ? (
        <>
          <rect x="6" y="5" width="4" height="14" />
          <rect x="14" y="5" width="4" height="14" />
        </>
      ) : (
        <polygon points="6,4 20,12 6,20" />
      )}
    </svg>
  );
}

function Clip({ src, poster, editing }: { src: string; poster?: string; editing: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [on, setOn] = useState(false);
  const [length, setLength] = useState(0);
  return (
    <div className="relative aspect-video border border-primaryStroke bg-black">
      <video
        ref={ref}
        src={src}
        poster={poster}
        preload="metadata"
        playsInline
        controls={on}
        onLoadedMetadata={(e) => setLength(e.currentTarget.duration)}
        onEnded={() => setOn(false)}
        className="h-full w-full"
      />
      {!on && (
        <button
          type="button"
          aria-label="play the clip"
          disabled={editing}
          onClick={() => {
            setOn(true);
            ref.current?.play().catch(() => setOn(false));
          }}
          className="absolute inset-0 flex items-center justify-center text-white disabled:cursor-default"
        >
          <PlayGlyph size={40} />
          {length > 0 && <span className="absolute bottom-2 right-2 bg-black/70 px-1.5 text-xs tabular-nums">{fmtClock(length)}</span>}
        </button>
      )}
    </div>
  );
}

function Track({ src, inset }: { src: string; inset: number }) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [length, setLength] = useState(0);
  const [broken, setBroken] = useState(false);

  const toggle = () => {
    const el = audio.current;
    if (!el) return;
    if (el.paused) el.play().catch(() => setPlaying(false));
    else el.pause();
  };
  const seekTo = (fraction: number) => {
    const el = audio.current;
    if (!el || !length) return;
    el.currentTime = Math.min(length, Math.max(0, fraction * length));
  };

  return (
    <div className="about-track flex flex-col gap-1.5 border border-primaryStroke p-3" data-playing={playing || undefined}>
      <audio
        ref={audio}
        src={src}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setLength(e.currentTarget.duration)}
        onError={() => setBroken(true)}
      />
      <div className="flex items-center gap-3" style={{ paddingRight: inset }}>
        <button type="button" onClick={toggle} disabled={broken} className={cn(ADD, 'inline-flex shrink-0 items-center gap-1')}>
          <PlayGlyph size={14} playing={playing} />
          {playing ? 'pause' : 'play'}
        </button>
        {broken && <span className="min-w-0 truncate text-sm text-textTertiary">cannot play this track</span>}
        <span className="ml-auto shrink-0 text-sm tabular-nums text-textTertiary">
          {fmtClock(time)} / {fmtClock(length)}
        </span>
      </div>
      <div
        role="slider"
        aria-label="position in the track"
        aria-valuemin={0}
        aria-valuemax={Math.floor(length)}
        aria-valuenow={Math.floor(time)}
        tabIndex={0}
        onKeyDown={(e) => {
          const by = e.key === 'ArrowRight' ? 5 : e.key === 'ArrowLeft' ? -5 : 0;
          if (!by || !length) return;
          e.preventDefault();
          seekTo((time + by) / length);
        }}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          seekTo((e.clientX - r.left) / r.width);
        }}
        className="h-[3px] cursor-pointer bg-backgroundTertiary focus:outline-none focus-visible:outline focus-visible:outline-1 focus-visible:outline-primaryBlue"
      >
        <div className="h-full bg-primaryBlue" style={{ width: `${length ? (time / length) * 100 : 0}%` }} />
      </div>
    </div>
  );
}

function Body({ cell, editing, focus, inset, onHtml }: { cell: Cell; editing: boolean; focus: boolean; inset: number; onHtml: (html: string) => void }) {
  if (cell.kind === 'text') return editing ? <TextEditor html={cell.html} autoFocus={focus} inset={inset} onChange={onHtml} /> : <Rich html={cell.html} />;
  if (cell.kind === 'image')
    return <img src={cell.src} alt="" draggable={false} className="about-image aspect-video w-full border border-primaryStroke bg-black object-cover" />;
  if (cell.kind === 'video') return <Clip key={cell.src} src={cell.src} poster={cell.poster} editing={editing} />;
  return <Track key={cell.src} src={cell.src} inset={inset} />;
}

function KindMenu({ column, onPick, onClose }: { column: boolean; onPick: (kind: Kind) => void; onClose: () => void }) {
  return (
    <div className={cn('flex items-center gap-1', column && 'flex-col')}>
      {KINDS.map((kind) => (
        <Tooltip key={kind} content={kind} at={column ? 'left' : 'top'}>
          <button type="button" aria-label={kind} onClick={() => onPick(kind)} className={cn(ICON, 'h-8 w-8 text-primaryBlue hover:text-primaryBlueHover')}>
            {KIND_ICON[kind]}
          </button>
        </Tooltip>
      ))}
      <span aria-hidden className={cn('bg-primaryStroke', column ? 'my-1 h-px w-5' : 'mx-1 h-5 w-px')} />
      <Icon label="close" at={column ? 'left' : 'top'} onClick={onClose}>
        <RiCloseLine size={16} aria-hidden />
      </Icon>
    </div>
  );
}

function AddToRow({ open, onOpen, onPick, onClose }: { open: boolean; onOpen: () => void; onPick: (kind: Kind) => void; onClose: () => void }) {
  if (open) {
    return (
      <div className={cn(DASHED, 'flex w-12 shrink-0 items-center justify-center py-2')}>
        <KindMenu column onPick={onPick} onClose={onClose} />
      </div>
    );
  }
  return (
    <Tooltip content="add to this row" at="left">
      <button
        type="button"
        aria-label="add to this row"
        onClick={onOpen}
        className={cn(DASHED, 'flex w-10 shrink-0 items-center justify-center text-primaryBlue hover:border-primaryBlue hover:text-primaryBlueHover')}
      >
        <RiAddLine size={20} aria-hidden />
      </button>
    </Tooltip>
  );
}

interface Pending {
  at: string;
  kind: Exclude<Kind, 'text'>;
  replace?: string;
}

interface AboutProps {
  name: string;
  edit?: boolean;
  id?: string;
}

export function About({ name, edit = false, id }: AboutProps) {
  const box = id ?? `about-${name}`;
  const [rows, setRows] = useState<Row[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState('');
  const [menu, setMenu] = useState<string | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const dirty = useRef(false);
  const uploads = useRef(0);
  const saving = useRef<Promise<void> | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const pending = useRef<Pending | null>(null);
  const rowsRef = useRef(rows);
  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  useEffect(() => {
    if (failed) return;
    let dead = false;
    api
      .aboutPage(name)
      .then((page) => {
        if (dead || dirty.current) return;
        setRows(rowsOf(page.blocks));
        setLoaded(true);
      })
      .catch(() => {
        if (!dead) setFailed(true);
      });
    return () => {
      dead = true;
    };
  }, [name, failed]);

  const persist = (list: Row[]) => {
    if (uploads.current > 0) {
      dirty.current = true;
      setStatus('saving');
      return;
    }
    dirty.current = false;
    const blocks = blocksOf(list);
    setStatus('saving');
    const flight = api
      .saveAboutPage(name, blocks)
      .then((saved) => {
        const ids = new Map<string, number>();
        let at = 0;
        for (const row of list)
          for (const cell of row.cells) {
            if (cell.kind !== 'text' && cell.id <= 0) continue;
            const got = saved.blocks[at++];
            if (got && cell.id === 0) ids.set(cell.key, got.id);
          }
        if (ids.size > 0)
          setRows((current) =>
            current.map((row) => ({ ...row, cells: row.cells.map((cell) => (ids.has(cell.key) ? { ...cell, id: ids.get(cell.key) ?? cell.id } : cell)) }))
          );
        setStatus('saved');
      })
      .catch((err: unknown) => {
        dirty.current = true;
        setStatus(`not saved: ${err instanceof Error ? err.message : 'could not save'}`);
      })
      .finally(() => {
        if (saving.current === flight) saving.current = null;
      });
    saving.current = flight;
  };
  const persistRef = useRef(persist);
  useEffect(() => {
    persistRef.current = persist;
  });

  useEffect(() => {
    if (!edit || failed || !dirty.current) return;
    const list = rows;
    const handle = setTimeout(() => persistRef.current(list), 700);
    return () => clearTimeout(handle);
  }, [rows, edit, failed]);

  const touch = (change: (rows: Row[]) => Row[]) => {
    dirty.current = true;
    setRows(change);
  };

  const patchCell = (key: string, part: Partial<Cell>) =>
    touch((list) => list.map((row) => ({ ...row, cells: row.cells.map((c) => (c.key === key ? { ...c, ...part } : c)) })));

  const place = (at: string, cell: Cell) => {
    if (count(rowsRef.current) >= BLOCKS_MAX) {
      setStatus(`${BLOCKS_MAX} blocks at most`);
      return;
    }
    touch((list) => {
      if (at === NEW) return [...list, { key: uid(), cells: [{ ...cell, cols: COLS }] }];
      return list.map((row) => {
        if (row.key !== at || row.cells.length >= CELLS_MAX) return row;
        const free = COLS - used(row);
        if (free >= COLS_MIN + 1) return { ...row, cells: [...row.cells, { ...cell, cols: free }] };
        const n = row.cells.length + 1;
        const base = Math.floor(COLS / n);
        let extra = COLS - base * n;
        return { ...row, cells: [...row.cells, cell].map((c) => ({ ...c, cols: base + (extra-- > 0 ? 1 : 0) })) };
      });
    });
  };

  const openFile = (want: Pending) => {
    pending.current = want;
    const input = fileRef.current;
    if (!input) return;
    input.accept = ACCEPT[want.kind];
    input.value = '';
    input.click();
  };

  const add = (at: string, kind: Kind) => {
    setMenu(null);
    if (kind === 'text') {
      const cell = makeCell('text');
      setFocusKey(cell.key);
      place(at, cell);
      return;
    }
    openFile({ at, kind });
  };

  const upload = async (key: string, kind: Exclude<Kind, 'text'>, file: Blob) => {
    uploads.current += 1;
    try {
      await saving.current;
      const saved = await api.saveAboutFile(name, WIRE[kind] as 'image' | 'video' | 'sound', file);
      dirty.current = true;
      setRows((list) =>
        list.map((row) => ({
          ...row,
          cells: row.cells.map((c) => {
            if (c.key !== key) return c;
            revoke(c.src);
            return { ...c, id: saved.id, src: saved.src, poster: undefined };
          })
        }))
      );
    } catch (err: unknown) {
      setStatus(`not saved: ${err instanceof Error ? err.message : 'could not upload'}`);
    } finally {
      uploads.current -= 1;
      if (uploads.current === 0 && dirty.current) setRows((list) => [...list]);
    }
  };

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const want = pending.current;
    pending.current = null;
    if (!file || !want) return;
    const src = URL.createObjectURL(file);
    let key = want.replace;
    if (key) {
      const swap = key;
      touch((list) =>
        list.map((row) => ({
          ...row,
          cells: row.cells.map((c) => {
            if (c.key !== swap) return c;
            revoke(c.src);
            return { ...c, id: 0, src, poster: undefined };
          })
        }))
      );
    } else {
      const cell = makeCell(want.kind, { src });
      key = cell.key;
      place(want.at, cell);
    }
    void upload(key, want.kind, file);
  };

  const removeCell = (key: string) =>
    touch((list) =>
      list
        .map((row) => ({
          ...row,
          cells: row.cells.filter((c) => {
            if (c.key !== key) return true;
            revoke(c.src);
            return false;
          })
        }))
        .filter((row) => row.cells.length > 0)
    );

  const moveCell = (rowKey: string, from: number, to: number) =>
    touch((list) =>
      list.map((row) => {
        if (row.key !== rowKey || to < 0 || to >= row.cells.length) return row;
        const cells = [...row.cells];
        const [cell] = cells.splice(from, 1);
        if (!cell) return row;
        cells.splice(to, 0, cell);
        return { ...row, cells };
      })
    );

  const rowKeys = rows.map((row) => row.key);
  const reorder = useReorder({
    keys: rowKeys,
    name: (key) => `row ${rowKeys.indexOf(key) + 1}`,
    onMove: (key, to) =>
      touch((list) => {
        const row = list.find((r) => r.key === key);
        return row ? movedTo(list, row, to) : list;
      })
  });

  const removeRow = (key: string) =>
    touch((list) =>
      list.filter((row) => {
        if (row.key !== key) return true;
        for (const c of row.cells) revoke(c.src);
        return false;
      })
    );

  const resize = (rowKey: string, index: number, want: number) => {
    setRows((list) => {
      const row = list.find((r) => r.key === rowKey);
      const me = row?.cells[index];
      if (!row || !me) return list;
      const cells = row.cells.map((c) => ({ ...c }));
      const mine = cells[index];
      if (!mine) return list;
      let cols = Math.max(COLS_MIN, Math.min(COLS, want));
      const others = used(row) - me.cols;
      let over = cols - (COLS - others);
      if (over > 0) {
        const next = cells[index + 1];
        if (next) {
          const give = Math.min(over, next.cols - COLS_MIN);
          next.cols -= give;
          over -= give;
        }
        if (over > 0) cols -= over;
      }
      mine.cols = cols;
      if (cells.every((c, i) => c.cols === row.cells[i]?.cols)) return list;
      dirty.current = true;
      return list.map((r) => (r.key === rowKey ? { ...r, cells } : r));
    });
  };

  const startResize = (e: ReactPointerEvent<HTMLButtonElement>, rowKey: string, index: number, cellKey: string, startCols: number) => {
    const grid = e.currentTarget.closest<HTMLElement>('[data-row]');
    if (!grid) return;
    e.preventDefault();
    const pitch = (grid.getBoundingClientRect().width + GAP) / COLS;
    const handle = e.currentTarget;
    const startX = e.clientX;
    handle.setPointerCapture(e.pointerId);
    setDragging(cellKey);
    const move = (ev: PointerEvent) => resize(rowKey, index, startCols + Math.round((ev.clientX - startX) / pitch));
    const up = () => {
      setDragging(null);
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  };

  const finish = () => {
    const kept = rowsRef.current.map((row) => ({ ...row, cells: row.cells.filter((c) => c.kind !== 'text' || filled(c)) })).filter((row) => row.cells.length > 0);
    setRows(kept);
    setMenu(null);
    setEditing(false);
    persistRef.current(kept);
  };

  if (failed) {
    return (
      <p id={box} data-failed className="text-textSecondary">
        could not load the page.{' '}
        <button id="about-retry" type="button" className={ADD} onClick={() => setFailed(false)}>
          try again
        </button>
      </p>
    );
  }

  if (!loaded) return null;

  const shown = editing
    ? reorder.order.flatMap((key) => rows.filter((row) => row.key === key))
    : rows.filter((row) => row.cells.some(filled)).map((row) => ({ ...row, cells: row.cells.filter(filled) }));

  if (shown.length === 0 && !editing) {
    if (!edit) {
      return (
        <p id={box} className="text-textSecondary">
          {name} hasn't made a page yet.
        </p>
      );
    }
    return (
      <div id={box} className={cn(DASHED, 'flex h-40 flex-col items-center justify-center gap-2')}>
        <RiPencilLine size={28} aria-hidden className="text-textTertiary" />
        <span className="text-textSecondary">nothing here yet</span>
        <button
          id="about-blank"
          type="button"
          className={ADD}
          onClick={() => {
            setEditing(true);
            setMenu(NEW);
          }}
        >
          start blank
        </button>
      </div>
    );
  }

  const full = count(rows) >= BLOCKS_MAX;

  return (
    <div className="relative">
      <section id={box} aria-label={`about ${name}`} {...(editing ? reorder.list : {})} className={cn('flex flex-col', editing ? 'gap-6' : 'gap-4')}>
        {shown.map((row, r) => (
          <div key={row.key} {...reorder.item(row.key)} className="flex flex-col gap-1.5">
            {editing && (
              <div className="flex items-center gap-3">
                <DragHandle id={`about-row-drag-${r}`} {...reorder.handle(row.key)} />
                <span className={LABEL}>row {r + 1}</span>
                <span className="ml-auto flex gap-0.5">
                  <Icon label="remove the row" onClick={() => removeRow(row.key)}>
                    <RiDeleteBinLine size={16} aria-hidden />
                  </Icon>
                </span>
              </div>
            )}
            <div className="flex items-stretch gap-3">
              <div data-row className="grid min-w-0 flex-1 grid-cols-12 gap-4">
                {row.cells.map((cell, i) => {
                  const fileKind = cell.kind === 'text' ? null : cell.kind;
                  const actions = (row.cells.length > 1 ? 2 : 0) + (fileKind ? 1 : 0) + 1;
                  return (
                    <div key={cell.key} className="relative col-span-12 min-w-0 sm:[grid-column:span_var(--cols)]" style={{ '--cols': cell.cols } as CSSProperties}>
                      <Body
                        cell={cell}
                        editing={editing}
                        focus={cell.key === focusKey}
                        inset={editing ? inset(actions) : 0}
                        onHtml={(html) => patchCell(cell.key, { html })}
                      />
                      {editing && (
                        <span className={cn(PLATE, 'absolute right-1.5 top-1.5 z-10')}>
                          {row.cells.length > 1 && (
                            <>
                              <Icon label="move left" disabled={i === 0} onClick={() => moveCell(row.key, i, i - 1)}>
                                <RiArrowLeftLine size={16} aria-hidden />
                              </Icon>
                              <Icon label="move right" disabled={i === row.cells.length - 1} onClick={() => moveCell(row.key, i, i + 1)}>
                                <RiArrowRightLine size={16} aria-hidden />
                              </Icon>
                            </>
                          )}
                          {fileKind && (
                            <Icon label="replace" onClick={() => openFile({ at: row.key, kind: fileKind, replace: cell.key })}>
                              <RiRefreshLine size={16} aria-hidden />
                            </Icon>
                          )}
                          <Icon label="remove" onClick={() => removeCell(cell.key)}>
                            <RiCloseLine size={16} aria-hidden />
                          </Icon>
                        </span>
                      )}
                      {editing && (
                        <Tooltip content={dragging === cell.key ? null : 'drag to resize'} at="right">
                          <button
                            type="button"
                            aria-label="drag to resize"
                            className="absolute -right-3 bottom-0 top-0 hidden w-2 cursor-ew-resize touch-none border-x border-primaryStroke bg-background hover:border-primaryBlue sm:block"
                            onPointerDown={(e) => startResize(e, row.key, i, cell.key, cell.cols)}
                          />
                        </Tooltip>
                      )}
                      {dragging === cell.key && (
                        <span className="pointer-events-none absolute -right-3 top-1/2 z-20 -translate-y-1/2 translate-x-full whitespace-nowrap border border-primaryStroke bg-background px-1.5 text-xs tabular-nums text-textSecondary">
                          {cell.cols} of {COLS}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
              {editing && row.cells.length < CELLS_MAX && !full && (
                <AddToRow open={menu === row.key} onOpen={() => setMenu(row.key)} onPick={(kind) => add(row.key, kind)} onClose={() => setMenu(null)} />
              )}
            </div>
          </div>
        ))}
        {editing && !full && (
          <div className={cn(DASHED, 'flex min-h-14 items-center justify-center px-3 py-3', menu !== NEW && 'hover:border-primaryBlue')}>
            {menu === NEW ? (
              <KindMenu column={false} onPick={(kind) => add(NEW, kind)} onClose={() => setMenu(null)} />
            ) : (
              <button id="about-add-row" type="button" className={cn(ADD, 'inline-flex items-center gap-1')} onClick={() => setMenu(NEW)}>
                <RiAddLine size={16} aria-hidden />
                add a row
              </button>
            )}
          </div>
        )}
      </section>
      {edit && (
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1">
          {editing ? (
            <button id="about-done" type="button" className={ADD} onClick={finish}>
              done
            </button>
          ) : (
            <button id="about-edit" type="button" className={ADD} onClick={() => setEditing(true)}>
              edit
            </button>
          )}
          {status && <span className="text-sm text-textTertiary">{status}</span>}
        </div>
      )}
      <input ref={fileRef} type="file" className="hidden" onChange={onFile} />
      {editing && reorder.status}
    </div>
  );
}
