import {
  RiAddLine,
  RiArrowDownLine,
  RiArrowLeftLine,
  RiArrowRightLine,
  RiArrowUpLine,
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

import { type AboutDoc, BLOCKS_MAX, TEXT_MAX, sanitizeHtml } from '@/infra/about';
import { type PageWire, api } from '@/infra/api';
import { Tooltip, type TooltipAt } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

/**
 * The about tab (docs/about.md): the page under the player, as rows. A row holds one to six
 * components (text, an image, a video, a track) on twelve columns; each takes a width of its
 * own (two columns at the least), the rest of the row is empty, and under `sm` they stack. The
 * `+` at the end of a row adds to it; `add a row` under the last one starts another, made with
 * its first component, so a row is never empty. The edge of a component drags its width; when
 * the row is full the one beside it gives way.
 *
 * Saved through the page api as it is: `y` is the row, `x` and `w` the component's columns on
 * the api's 800-wide scale, `z` its place in the row. Text is html (a few tags, cleaned here
 * and again at the door); a picture, a clip or a track goes up first and the page names it by
 * id. It saves on its own a moment after a change, and on `done`.
 */

type Kind = 'text' | 'image' | 'video' | 'audio';

interface Cell {
  key: string;
  kind: Kind;
  /** The object's id on the api. 0 for a new text, or a file still going up. A dummy's is -1: nothing is saved. */
  id: number;
  /** Columns of the twelve. */
  cols: number;
  /** Text: the html, cleaned. */
  html: string;
  /** A picture, a clip, a track: where it is. A blob url while the file goes up. */
  src: string;
  /** A dummy clip's poster. An upload shows its first frame. */
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
/** `gap-4` between the cells, in the pitch of a column. */
const GAP = 16;
/** The api keeps `x` and `w` on a 0..800 scale (its largest block): a row is 800 wide, a column a twelfth of that. */
const UNIT = 800 / COLS;
/** A height for the api, which wants one. Rows are as tall as their content. */
const HEIGHT: Record<Kind, number> = { text: 120, image: 180, video: 200, audio: 56 };
const WIRE: Record<Kind, PageWire['type']> = { text: 'text', image: 'image', video: 'video', audio: 'sound' };
const ACCEPT: Record<Exclude<Kind, 'text'>, string> = { image: 'image/*', video: 'video/mp4,video/webm', audio: 'audio/*' };
/** Where the open menu adds to: a row's key, or this for a row of its own. */
const NEW = 'new';
/** What the owner starts from. Theirs to rewrite; it says so. */
const STARTER = "what you stream, when you're on, what to ask about. this is yours to rewrite.";
/** The sample's media, the site's own, uploaded as the owner's so the page can keep them. */
const SAMPLE_FILES: { kind: Exclude<Kind, 'text'>; path: string }[] = [
  { kind: 'image', path: '/about-demo/banner.jpg' },
  { kind: 'audio', path: '/about-demo/track-1.mp3' }
];

const ADD = 'text-sm font-semibold text-primaryBlue disabled:opacity-40';
const LABEL = 'text-xs font-semibold uppercase tracking-wider text-textTertiary';
const DASHED = 'border border-dashed border-primaryStroke';
/** An icon-only control: 24px square, the icon 16. Its name is its tooltip and its label. */
const ICON = 'flex h-6 w-6 shrink-0 items-center justify-center text-textSecondary hover:text-textPrimary disabled:opacity-40 disabled:hover:text-textSecondary';
/** The actions on a component sit on this, over the top right corner (`right-1.5 top-1.5`), so they read over a picture. */
const PLATE = 'flex gap-0.5 border border-primaryStroke bg-background/90 p-0.5';
/** How far in from the right edge a component's first line stops, with `n` actions on the plate: the plate (24 an icon, 2 between, 2 of padding and 1 of border a side) and the room either side of it. */
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

/** A component with something in it: words, or a file. */
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

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Plain lines as the text block's html: a paragraph a line, a blank line kept. */
function paragraphs(text: string): string {
  return text
    .split('\n')
    .map((line) => (line.trim() ? `<p>${escapeHtml(line)}</p>` : '<p><br></p>'))
    .join('');
}

function kindOf(type: PageWire['type']): Kind | null {
  if (type === 'text' || type === 'image' || type === 'video') return type;
  if (type === 'sound') return 'audio';
  return null;
}

// ---- the wire ------------------------------------------------------------------------------------------

/** The saved blocks as rows: a row a `y`, left to right by `x`, each as wide as its `w` says. A shape, or a kind unknown, is left out. */
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
      // one that does not fit starts a row of its own: an older page, or one that was wider than the api kept
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

/** The rows as blocks, in reading order. A file still going up (id 0) is not on the page yet. */
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

/** A fake stream's page from its document: the words; the picture beside the clip; the tracks. Nothing of it is saved. */
function dummyRows(doc: AboutDoc): Row[] {
  const rows: Row[] = [];
  const media: Cell[] = [];
  const tracks: Cell[] = [];
  for (const block of doc.blocks) {
    if (block.kind === 'text') rows.push({ key: uid(), cells: [makeCell('text', { id: -1, html: paragraphs(block.text) })] });
    if (block.kind === 'image') media.push(makeCell('image', { id: -1, src: block.src }));
    if (block.kind === 'video') media.push(makeCell('video', { id: -1, src: block.src, poster: block.poster }));
    if (block.kind === 'music') for (const t of block.tracks.slice(0, CELLS_MAX)) tracks.push(makeCell('audio', { id: -1, src: t.src }));
  }
  for (const group of [media, tracks]) {
    if (group.length === 0) continue;
    const cols = Math.max(COLS_MIN, Math.floor(COLS / group.length));
    rows.push({ key: uid(), cells: group.map((cell) => ({ ...cell, cols })) });
  }
  return rows;
}

// ---- text -----------------------------------------------------------------------------------------------

/** The cleaned html drawn by react, never written as a string: each tag it allows becomes its element. */
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
      <a key={key} href={el.getAttribute('href') ?? ''} target="_blank" rel="noopener noreferrer nofollow" className="text-primaryBlue hover:underline">
        {kids}
      </a>
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

/** The text box: contenteditable, so bold, italic and a pasted link survive. Cleaned on every keystroke and cut at TEXT_MAX. */
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
      data-placeholder="write here"
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
      // a float in the top right corner, as wide as the actions over it: the first lines wrap short of them, the rest run full width
      style={{ '--inset': `${inset}px` } as CSSProperties}
      className="about-text min-h-[3.5rem] whitespace-pre-wrap border border-primaryStroke bg-background px-2 py-1 outline-none [overflow-wrap:anywhere] before:float-right before:h-7 before:w-[var(--inset)] before:content-[''] focus:border-primaryBlue empty:after:text-textTertiary empty:after:content-[attr(data-placeholder)]"
    />
  );
}

// ---- media ----------------------------------------------------------------------------------------------

/** An icon-only control: its name is its accessible label and the tooltip on hover and focus (tooltips.mdc). */
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

/** The clip before it plays: its first frame (or poster), the glyph, how long it is. The native bar comes with the press. */
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

/** One track: the word and the clock, and a bar that seeks. Plays on a press; silent when the tab is left. */
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
      {/* the clock stops short of the actions over the corner */}
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

/** A component's content. `inset` is the room its first line leaves for the actions over its corner while editing; 0 otherwise. */
function Body({ cell, editing, focus, inset, onHtml }: { cell: Cell; editing: boolean; focus: boolean; inset: number; onHtml: (html: string) => void }) {
  if (cell.kind === 'text') return editing ? <TextEditor html={cell.html} autoFocus={focus} inset={inset} onChange={onHtml} /> : <Rich html={cell.html} />;
  if (cell.kind === 'image')
    return <img src={cell.src} alt="" draggable={false} className="about-image aspect-video w-full border border-primaryStroke bg-black object-cover" />;
  // keyed on the file: another one starts over, first frame up and length unknown
  if (cell.kind === 'video') return <Clip key={cell.src} src={cell.src} poster={cell.poster} editing={editing} />;
  return <Track key={cell.src} src={cell.src} inset={inset} />;
}

// ---- adding ----------------------------------------------------------------------------------------------

/** The four kinds, as icons, then a close. Down the strip at the end of a row, across the strip under the page. */
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

/** The `+` at the end of a row: as tall as the row; opens into the four kinds. */
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

// ---- the tab ----------------------------------------------------------------------------------------------

interface Pending {
  at: string;
  kind: Exclude<Kind, 'text'>;
  /** A cell whose file is being swapped, instead of a new cell. */
  replace?: string;
}

interface AboutProps {
  name: string;
  /** A fake stream's document, drawn as its page. Null for a real name: the page is read from the api. */
  doc: AboutDoc | null;
  /** My own page: it edits. */
  edit?: boolean;
}

/** Keyed on the name by the caller: another name is another page, read fresh. */
export function About({ name, doc, edit = false }: AboutProps) {
  const [rows, setRows] = useState<Row[]>(() => (doc ? dummyRows(doc) : []));
  const [loaded, setLoaded] = useState(doc !== null);
  /** The api did not answer for the page. Not an empty page: no editor, and nothing saves off it. */
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState('');
  /** Which `+` is open: a row's key, `NEW`, or none. */
  const [menu, setMenu] = useState<string | null>(null);
  /** A text just made: its box takes the focus. */
  const [focusKey, setFocusKey] = useState<string | null>(null);
  /** The component whose edge is being dragged: its width shows beside the handle while it is. */
  const [dragging, setDragging] = useState<string | null>(null);
  const dirty = useRef(false);
  /** Files on their way up. The page does not save while there are any: the api drops every file a saved page does not name. */
  const uploads = useRef(0);
  /** A save in flight. An upload waits for it, for the same reason the other way round. */
  const saving = useRef<Promise<void> | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const pending = useRef<Pending | null>(null);
  const rowsRef = useRef(rows);
  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  // a real name's page, from the api. a failed ask is not an empty page: it is its own state, until `try again` clears it and this asks once more
  useEffect(() => {
    if (doc || failed) return;
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
  }, [name, doc, failed]);

  const persist = (list: Row[]) => {
    if (uploads.current > 0) {
      // the last upload's end saves the page, with the file on it
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
        // a new text's id comes back in the order it was sent
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

  // a moment after a change, the page saves itself. never off a failed load: the page's content is unknown, and a save would replace it
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

  /**
   * A component into a row, or into a row of its own under the last. In a row with room it takes
   * the room; in a full one every component gives way and they share the row evenly.
   */
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

  /**
   * The file up to the api, the cell showing it from a blob url meanwhile. No save runs until
   * every upload is back; then the page saves once, with the files on it.
   */
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
      // a save that waited for this: a fresh list wakes the effect that saves
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

  const moveRow = (from: number, to: number) =>
    touch((list) => {
      if (to < 0 || to >= list.length) return list;
      const next = [...list];
      const [row] = next.splice(from, 1);
      if (!row) return list;
      next.splice(to, 0, row);
      return next;
    });

  const removeRow = (key: string) =>
    touch((list) =>
      list.filter((row) => {
        if (row.key !== key) return true;
        for (const c of row.cells) revoke(c.src);
        return false;
      })
    );

  /** A component's width, from a drag on its edge. Past the row's end the one beside it gives way, down to its least; then no further. */
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

  /** Done: an empty text goes, and a row left with nothing goes with it. Then the page saves. */
  const finish = () => {
    const kept = rowsRef.current.map((row) => ({ ...row, cells: row.cells.filter((c) => c.kind !== 'text' || filled(c)) })).filter((row) => row.cells.length > 0);
    setRows(kept);
    setMenu(null);
    setEditing(false);
    persistRef.current(kept);
  };

  /** The sample: the words now; the site's picture and track fetched and put up as the owner's own, then a row of the two. */
  const startSample = async () => {
    const words = makeCell('text', { html: paragraphs(STARTER) });
    setEditing(true);
    touch(() => [{ key: uid(), cells: [words] }]);
    setStatus('making the sample');
    uploads.current += 1;
    try {
      await saving.current;
      const cells = await Promise.all(
        SAMPLE_FILES.map(async ({ kind, path }) => {
          const res = await fetch(path);
          if (!res.ok) throw new Error(`${path}: ${res.status}`);
          const saved = await api.saveAboutFile(name, WIRE[kind] as 'image' | 'video' | 'sound', await res.blob());
          return makeCell(kind, { id: saved.id, src: saved.src, cols: COLS / SAMPLE_FILES.length });
        })
      );
      dirty.current = true;
      setRows((list) => [...list, { key: uid(), cells }]);
    } catch (err: unknown) {
      setStatus(`the sample's media did not load: ${err instanceof Error ? err.message : 'unknown'}`);
    } finally {
      uploads.current -= 1;
      if (uploads.current === 0 && dirty.current) setRows((list) => [...list]);
    }
  };

  // the api did not answer: the same line for a viewer and the owner, and no editor. an empty page it is not
  if (failed) {
    return (
      <p id={`about-${name}`} data-failed className="text-textSecondary">
        could not load the page.{' '}
        <button id="about-retry" type="button" className={ADD} onClick={() => setFailed(false)}>
          try again
        </button>
      </p>
    );
  }

  if (!loaded) return null;

  const shown = editing ? rows : rows.filter((row) => row.cells.some(filled)).map((row) => ({ ...row, cells: row.cells.filter(filled) }));

  if (shown.length === 0 && !editing) {
    if (!edit) {
      return (
        <p id={`about-${name}`} className="text-textSecondary">
          {name} hasn't made a page yet.
        </p>
      );
    }
    return (
      <div id={`about-${name}`} className={cn(DASHED, 'flex h-40 flex-col items-center justify-center gap-2')}>
        <RiPencilLine size={28} aria-hidden className="text-textTertiary" />
        <span className="text-textSecondary">nothing here yet</span>
        <span className="flex items-center gap-2.5">
          <button id="about-sample" type="button" className={ADD} onClick={() => void startSample()}>
            start from a sample
          </button>
          <span aria-hidden className="text-sm text-textTertiary">
            ·
          </span>
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
        </span>
      </div>
    );
  }

  const full = count(rows) >= BLOCKS_MAX;

  return (
    <div>
      <section id={`about-${name}`} aria-label={`about ${name}`} className={cn('flex flex-col', editing ? 'gap-6' : 'gap-4')}>
        {shown.map((row, r) => (
          <div key={row.key} className="flex flex-col gap-1.5">
            {editing && (
              <div className="flex items-center gap-3">
                <span className={LABEL}>row {r + 1}</span>
                <span className="ml-auto flex gap-0.5">
                  <Icon label="move the row up" disabled={r === 0} onClick={() => moveRow(r, r - 1)}>
                    <RiArrowUpLine size={16} aria-hidden />
                  </Icon>
                  <Icon label="move the row down" disabled={r === shown.length - 1} onClick={() => moveRow(r, r + 1)}>
                    <RiArrowDownLine size={16} aria-hidden />
                  </Icon>
                  <Icon label="remove the row" onClick={() => removeRow(row.key)}>
                    <RiDeleteBinLine size={16} aria-hidden />
                  </Icon>
                </span>
              </div>
            )}
            <div className="flex items-stretch gap-3">
              <div data-row className="grid min-w-0 flex-1 grid-cols-12 gap-4">
                {row.cells.map((cell, i) => {
                  // the kind a file would replace; null for text. read here: a closure below does not keep the narrowing
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
                        // the width label takes the tooltip's place while the edge is held
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
    </div>
  );
}
