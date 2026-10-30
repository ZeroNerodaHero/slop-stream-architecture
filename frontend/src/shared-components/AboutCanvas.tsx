import { RiPencilLine } from '@remixicon/react';
import { type CSSProperties, type DragEvent, type PointerEvent as ReactPointerEvent, type ReactNode, useEffect, useRef, useState } from 'react';

import { BLOCKS_MAX, FONT_STACK, PAGE_FONTS, POS_MAX, type PageBlock, type PageType, TEXT_MAX, Z_MAX, sanitizeHtml } from '@/infra/about';
import { api } from '@/infra/api';
import { cn } from '@/utils/cn';

const ADD = 'text-sm font-semibold text-primaryBlue';
const QUIET = 'text-sm text-textTertiary';
const W_MIN = 80;
const H_MIN = 40;
const SIZE_MAX = 800;
/** Positions land on this grid, and on another block's edge when closer. */
const GRID = 8;
const SNAP = 8;
/** Room above the page for the move tab. The page under it is as wide as the column beside the chat. */
const TAB = 24;
const SIZES = [12, 14, 16, 20, 24, 32, 48, 64, 80, 96];
const STROKES = [0, 1, 2, 3, 4, 6, 8, 12];

interface Item {
  key: string;
  type: PageType;
  id: number;
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  r: number;
  font: string;
  size: number;
  color: string;
  bg: string;
  stroke: number;
  strokeColor: string;
  align: '' | 'left' | 'center' | 'right';
  html: string;
  src: string;
}

function usualSize(type: PageType): { w: number; h: number } {
  if (type === 'text') return { w: 280, h: 120 };
  if (type === 'video') return { w: 320, h: 200 };
  if (type === 'sound') return { w: 280, h: 56 };
  if (type === 'line') return { w: 240, h: 4 };
  if (type === 'box' || type === 'border') return { w: 200, h: 120 };
  return { w: 300, h: 180 };
}

function minBox(type: PageType): { w: number; h: number } {
  if (type === 'line') return { w: 8, h: 1 };
  return { w: W_MIN, h: H_MIN };
}

function isMedia(type: PageType): boolean {
  return type === 'image' || type === 'video' || type === 'sound';
}

function canTurn(type: PageType): boolean {
  return type === 'text' || type === 'image' || type === 'line' || type === 'box' || type === 'border';
}

function hex(color: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color.toLowerCase() : '';
}

function blankLook(): Pick<Item, 'r' | 'font' | 'size' | 'color' | 'bg' | 'stroke' | 'strokeColor' | 'align'> {
  return { r: 0, font: '', size: 0, color: '', bg: '', stroke: 0, strokeColor: '', align: '' };
}

function lookFrom(block: PageBlock): Pick<Item, 'r' | 'font' | 'size' | 'color' | 'bg' | 'stroke' | 'strokeColor' | 'align'> {
  let r = Math.round(block.r || 0) % 360;
  if (r > 180) r -= 360;
  if (r < -180) r += 360;
  const align = block.align === 'left' || block.align === 'center' || block.align === 'right' ? block.align : '';
  return {
    r,
    font: block.font && FONT_STACK[block.font] ? block.font : '',
    size: block.size && block.size >= 12 ? Math.min(96, Math.round(block.size)) : 0,
    color: hex(block.color || ''),
    bg: hex(block.bg || ''),
    stroke: Math.max(0, Math.min(16, Math.round(block.stroke || 0))),
    strokeColor: hex(block.strokeColor || ''),
    align
  };
}

function textStyle(block: Item): CSSProperties {
  const style: CSSProperties = {};
  const family = FONT_STACK[block.font];
  if (family) style.fontFamily = family;
  if (block.size) style.fontSize = block.size;
  if (block.color) style.color = block.color;
  if (block.bg) style.background = block.bg;
  if (block.align) style.textAlign = block.align;
  if (block.stroke > 0) style.WebkitTextStroke = `${block.stroke}px ${block.strokeColor || 'currentColor'}`;
  return style;
}

function localDelta(dx: number, dy: number, r: number): { x: number; y: number } {
  if (!r) return { x: dx, y: dy };
  const rad = (r * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return { x: dx * c + dy * s, y: -dx * s + dy * c };
}

function fromPage(block: PageBlock): Item {
  const size = usualSize(block.type);
  return {
    key: `${block.type}-${block.id}-${Math.random().toString(36).slice(2, 8)}`,
    type: block.type,
    id: block.id,
    x: block.x,
    y: block.y,
    z: block.z,
    w: block.w && block.w > 0 ? block.w : size.w,
    h: block.h && block.h > 0 ? block.h : size.h,
    ...lookFrom(block),
    html: block.html ?? '',
    src: block.src ?? ''
  };
}

function fileType(file: File): 'image' | 'video' | 'sound' | null {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type === 'video/mp4' || file.type === 'video/webm') return 'video';
  if (file.type.startsWith('audio/')) return 'sound';
  return null;
}

function clamp(n: number, max: number): number {
  return Math.max(0, Math.min(max, Math.round(n)));
}

function grid(n: number): number {
  return Math.round(n / GRID) * GRID;
}

function edgeLines(others: Item[], axis: 'x' | 'y', limit: number): number[] {
  const lines = [0, limit];
  for (const block of others) {
    if (axis === 'x') lines.push(block.x, block.x + block.w, block.x + block.w / 2);
    else lines.push(block.y, block.y + block.h, block.y + block.h / 2);
  }
  return lines;
}

/** Where a block's left or top lands: on the grid, or on another block's edge when that is closer. */
function snapSpan(origin: number, size: number, lines: number[], limit: number): { at: number; guide: number | null } {
  const room = Math.max(0, limit - size);
  const edges = [0, size / 2, size];
  let bestAt = Math.min(room, Math.max(0, grid(origin)));
  let bestD = Math.abs(origin - bestAt);
  let guide: number | null = null;
  for (const edge of edges) {
    const raw = origin + edge;
    for (const line of lines) {
      const dist = Math.abs(raw - line);
      if (dist > SNAP) continue;
      const at = origin + (line - raw);
      if (at < 0 || at > room) continue;
      if (dist < bestD || (dist === bestD && guide === null)) {
        bestAt = at;
        bestD = dist;
        guide = line;
      }
    }
  }
  return { at: Math.round(bestAt), guide };
}

/** Where a scaled edge lands. `min` and `max` are the edge, not the size. */
function snapEdge(edge: number, lines: number[], min: number, max: number): { at: number; guide: number | null } {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  let best = Math.min(hi, Math.max(lo, grid(edge)));
  let bestD = Math.abs(edge - best);
  let guide: number | null = null;
  for (const line of lines) {
    if (line < lo || line > hi) continue;
    const dist = Math.abs(edge - line);
    if (dist <= SNAP && dist <= bestD) {
      best = line;
      bestD = dist;
      guide = line;
    }
  }
  return { at: Math.round(best), guide };
}

function overlaps(block: { x: number; y: number; w: number; h: number }, box: { x: number; y: number; w: number; h: number }): boolean {
  return block.x < box.x + box.w && block.x + block.w > box.x && block.y < box.y + box.h && block.y + block.h > box.y;
}

/** The leader's snapped delta, held back so the whole group stays on the page. */
function groupShift(starts: { x: number; y: number; w: number; h: number }[], dx: number, dy: number, width: number): { dx: number; dy: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxR = -Infinity;
  let maxB = -Infinity;
  for (const block of starts) {
    minX = Math.min(minX, block.x);
    minY = Math.min(minY, block.y);
    maxR = Math.max(maxR, block.x + block.w);
    maxB = Math.max(maxB, block.y + block.h);
  }
  return {
    dx: Math.max(-minX, Math.min(width - maxR, dx)),
    dy: Math.max(-minY, Math.min(POS_MAX - maxB, dy))
  };
}

function sameKeys(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((key, i) => key === b[i]);
}

function Rich({ html, style }: { html: string; style?: CSSProperties }) {
  const safe = sanitizeHtml(html);
  if (!safe) return null;
  const doc = new DOMParser().parseFromString(safe, 'text/html');
  const nodes = [...doc.body.childNodes].map((node, i) => richNode(node, `t${i}`));
  return <div className="about-text h-full overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere]" style={style}>{nodes}</div>;
}

function richNode(node: Node, key: string): ReactNode {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent;
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  const el = node as HTMLElement;
  const name = el.tagName.toLowerCase();
  const kids = [...el.childNodes].map((child, i) => richNode(child, `${key}-${i}`));
  if (name === 'br') return <br key={key} />;
  if (name === 'a') {
    const href = el.getAttribute('href') ?? '';
    return (
      <a key={key} href={href} target="_blank" rel="noopener noreferrer nofollow" className="text-primaryBlue">
        {kids}
      </a>
    );
  }
  if (name === 'p') return <p key={key}>{kids}</p>;
  if (name === 'b' || name === 'strong') return <strong key={key}>{kids}</strong>;
  if (name === 'i' || name === 'em') return <em key={key}>{kids}</em>;
  if (name === 'u') return <u key={key}>{kids}</u>;
  if (name === 's') return <s key={key}>{kids}</s>;
  if (name === 'ul') return <ul key={key} className="list-disc pl-5">{kids}</ul>;
  if (name === 'ol') return <ol key={key} className="list-decimal pl-5">{kids}</ol>;
  if (name === 'li') return <li key={key}>{kids}</li>;
  if (name === 'h2') return <h2 key={key} className="text-lg font-semibold">{kids}</h2>;
  if (name === 'h3') return <h3 key={key} className="font-semibold">{kids}</h3>;
  if (name === 'blockquote') return <blockquote key={key}>{kids}</blockquote>;
  return <span key={key}>{kids}</span>;
}

function TextEditor({ html, autoFocus, onChange, style }: { html: string; autoFocus?: boolean; onChange: (html: string) => void; style?: CSSProperties }) {
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
      className="about-text h-full min-h-[1.5rem] overflow-auto whitespace-pre-wrap outline-none [overflow-wrap:anywhere] empty:before:text-textTertiary empty:before:content-[attr(data-placeholder)]"
      style={style}
    />
  );
}

function BlockBody({
  block,
  live,
  focus,
  onHtml,
  onChoose
}: {
  block: Item;
  live: boolean;
  focus: boolean;
  onHtml: (html: string) => void;
  onChoose?: () => void;
}) {
  if (block.type === 'text') {
    const style = textStyle(block);
    if (live) return <TextEditor html={block.html} autoFocus={focus} onChange={onHtml} style={style} />;
    return <Rich html={block.html} style={style} />;
  }
  if (block.type === 'image' && !block.src && live && onChoose) {
    return (
      <button type="button" className="flex h-full w-full items-center justify-center text-sm text-textTertiary" onClick={onChoose}>
        choose image
      </button>
    );
  }
  if (block.type === 'image' && block.src) {
    return <img src={block.src} alt="" draggable={false} className="about-image h-full w-full bg-black object-contain" />;
  }
  if (block.type === 'video' && block.src) {
    return <video src={block.src} controls preload="metadata" playsInline className="about-video h-full w-full bg-black" />;
  }
  if (block.type === 'sound' && block.src) {
    return <audio src={block.src} controls preload="metadata" className="about-music w-full" />;
  }
  return null;
}

function Shape({ block }: { block: Item }) {
  if (block.type === 'line') {
    return <div className="h-full w-full" style={{ background: block.bg || 'currentColor' }} />;
  }
  if (block.type === 'box' || block.type === 'border') {
    return (
      <div
        className="h-full w-full"
        style={{
          background: block.type === 'box' ? block.bg || 'transparent' : 'transparent',
          border: block.stroke > 0 ? `${block.stroke}px solid ${block.strokeColor || 'currentColor'}` : undefined
        }}
      />
    );
  }
  return null;
}

const FIELD = 'border border-primaryStroke bg-background px-1 text-sm text-textPrimary';

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (color: string) => void }) {
  return (
    <label className="flex items-center gap-1 text-sm text-textTertiary">
      {label}
      <input type="color" aria-label={label} value={value || '#e8eaed'} onChange={(e) => onChange(e.target.value)} className="h-5 w-5 border border-primaryStroke bg-background" />
      {value && (
        <button type="button" className={QUIET} onClick={() => onChange('')}>
          clear
        </button>
      )}
    </label>
  );
}

function LookBar({ block, onChange }: { block: Item; onChange: (part: Partial<Item>) => void }) {
  const text = block.type === 'text';
  const box = block.type === 'box' || block.type === 'border';
  if (!text && block.type !== 'line' && !box) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
      {text && (
        <>
          <select aria-label="font" value={block.font} onChange={(e) => onChange({ font: e.target.value })} className={FIELD}>
            <option value="">font</option>
            {PAGE_FONTS.map((font) => (
              <option key={font} value={font}>
                {font}
              </option>
            ))}
          </select>
          <select aria-label="size" value={block.size || ''} onChange={(e) => onChange({ size: Number(e.target.value) || 0 })} className={FIELD}>
            <option value="">size</option>
            {SIZES.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
          <ColorField label="color" value={block.color} onChange={(color) => onChange({ color })} />
          <ColorField label="background" value={block.bg} onChange={(bg) => onChange({ bg })} />
          <select aria-label="text border" value={block.stroke} onChange={(e) => onChange({ stroke: Number(e.target.value) })} className={FIELD}>
            {STROKES.map((n) => (
              <option key={n} value={n}>
                {n === 0 ? 'text border' : `${n}px`}
              </option>
            ))}
          </select>
          <ColorField label="border color" value={block.strokeColor} onChange={(strokeColor) => onChange({ strokeColor })} />
          {(['left', 'center', 'right'] as const).map((align) => (
            <button key={align} type="button" className={block.align === align ? ADD : QUIET} onClick={() => onChange({ align })}>
              {align}
            </button>
          ))}
        </>
      )}
      {block.type === 'line' && <ColorField label="color" value={block.bg} onChange={(bg) => onChange({ bg })} />}
      {box && (
        <>
          {block.type === 'box' && <ColorField label="fill" value={block.bg} onChange={(bg) => onChange({ bg })} />}
          <select aria-label="border" value={block.stroke} onChange={(e) => onChange({ stroke: Number(e.target.value) })} className={FIELD}>
            {STROKES.map((n) => (
              <option key={n} value={n}>
                {n === 0 ? 'border' : `${n}px`}
              </option>
            ))}
          </select>
          <ColorField label="border color" value={block.strokeColor} onChange={(strokeColor) => onChange({ strokeColor })} />
        </>
      )}
    </div>
  );
}

interface AboutCanvasProps {
  name: string;
  edit: boolean;
  scope: string;
  css: string;
  boxClass: string;
  /** A page already loaded. The owner's canvas loads its own. */
  initial?: PageBlock[] | null;
}

/**
 * The saved page. The preview at the bottom is what a visitor sees. On my own page, edit opens
 * the canvas above it: a tab on each block moves it, the corner and the edges scale it, and
 * save writes the layout (it also saves on its own). The page is as wide as the column beside the
 * chat and 1600 tall; you scroll it. Text, a picture, and a shape can turn. A block snaps to the
 * grid and to the others.
 */
/** A small picture of the preset: each column is a text block over a picture. */
function ColumnSketch({ n }: { n: 1 | 2 | 3 }) {
  return (
    <span aria-hidden className="flex h-12 w-16 gap-0.5">
      {Array.from({ length: n }, (_, i) => (
        <span key={i} className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex h-4 flex-col justify-center gap-px border border-primaryStroke px-0.5">
            <span className="h-px bg-textTertiary" />
            <span className="h-px w-2/3 bg-textTertiary" />
          </span>
          <span className="min-h-0 flex-1 border border-primaryStroke bg-backgroundSecondary" />
        </span>
      ))}
    </span>
  );
}

export function AboutCanvas({ name, edit, scope, css, boxClass, initial = null }: AboutCanvasProps) {
  const [items, setItems] = useState<Item[]>([]);
  const [loaded, setLoaded] = useState(initial !== null);
  const [status, setStatus] = useState('');
  const [editing, setEditing] = useState(false);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const ready = useRef(false);
  const dirty = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const previewPageRef = useRef<HTMLDivElement>(null);
  const [lines, setLines] = useState<{ x: number | null; y: number | null }>({ x: null, y: null });
  const place = useRef<{ x: number; y: number; key: string | null; accept: string }>({ x: 16, y: 16, key: null, accept: 'image/*' });
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const persist = (list: Item[]) => {
    const pending = list.some((block) => isMedia(block.type) && block.id === 0);
    const sent = list.filter((block) => !isMedia(block.type) || block.id !== 0);
    if (pending && sent.length === 0) return;
    dirty.current = false;
    setStatus('saving');
    api
      .saveAboutPage(
        name,
        sent.map((block) => ({
          type: block.type,
          id: block.id,
          x: block.x,
          y: block.y,
          z: block.z,
          w: block.w,
          h: block.h,
          r: block.r,
          font: block.font,
          size: block.size,
          color: block.color,
          bg: block.bg,
          stroke: block.stroke,
          strokeColor: block.strokeColor,
          align: block.align,
          ...(block.type === 'text' ? { html: sanitizeHtml(block.html) } : {})
        }))
      )
      .then((saved) => {
        setItems((current) =>
          current.map((block) => {
            const at = sent.findIndex((item) => item.key === block.key);
            const got = saved.blocks[at];
            if (!got || got.type !== block.type) return block;
            return { ...block, id: got.id, src: block.src.startsWith('blob:') ? block.src : got.src || block.src };
          })
        );
        setStatus('saved');
      })
      .catch((err: unknown) => {
        dirty.current = true;
        setStatus(`not saved: ${err instanceof Error ? err.message : 'could not save'}`);
      });
  };
  const persistRef = useRef(persist);
  persistRef.current = persist;

  useEffect(() => {
    let dead = false;
    dirty.current = false;
    ready.current = true;
    const apply = (blocks: PageBlock[]) => {
      if (dead) return;
      ready.current = true;
      if (dirty.current) return;
      setItems(blocks.map(fromPage));
    };
    if (initial) {
      apply(initial);
      setLoaded(true);
      return () => {
        dead = true;
      };
    }
    if (!edit) {
      setLoaded(true);
      return;
    }
    setLoaded(false);
    setItems([]);
    api
      .aboutPage(name)
      .then((page) => {
        apply(page.blocks);
        if (!dead) setLoaded(true);
      })
      .catch(() => {
        if (!dead) {
          ready.current = true;
          setLoaded(true);
        }
      });
    return () => {
      dead = true;
    };
  }, [name, edit, initial]);

  useEffect(() => {
    if (!edit || !ready.current || !dirty.current) return;
    const list = items;
    const handle = setTimeout(() => persistRef.current(list), 600);
    return () => clearTimeout(handle);
  }, [items, edit, name]);

  const touch = (next: Item[] | ((list: Item[]) => Item[])) => {
    dirty.current = true;
    setItems(next);
  };

  const pageWidth = () => {
    const w = pageRef.current?.clientWidth || previewPageRef.current?.clientWidth || 0;
    return w > 0 ? Math.min(POS_MAX, w) : POS_MAX;
  };

  const nextZ = (list: Item[]) => clamp(list.reduce((max, block) => Math.max(max, block.z), 0) + 1, Z_MAX);
  const nextY = (list: Item[]) => {
    if (list.length === 0) return GRID;
    const y = Math.max(...list.map((block) => block.y + block.h)) + GRID;
    return Math.min(grid(y), POS_MAX - usualSize('text').h);
  };

  const reveal = (y: number) => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const top = y + TAB;
    if (top < scroller.scrollTop || top > scroller.scrollTop + scroller.clientHeight - 120) {
      scroller.scrollTop = Math.max(0, top - 48);
    }
  };

  /** One, two, or three columns under what is already there. Each column is a text block over an empty image of the same width. */
  const addColumns = (n: 1 | 2 | 3) => {
    const need = n * 2;
    if (items.length + need > BLOCKS_MAX) {
      setStatus('40 blocks at most');
      return;
    }
    const width = pageWidth();
    const gap = GRID;
    const raw = (width - GRID * 2 - gap * (n - 1)) / n;
    const colW = Math.floor(raw / GRID) * GRID;
    if (colW < W_MIN) {
      setStatus('too narrow for that many columns');
      return;
    }
    const textH = usualSize('text').h;
    const imageH = Math.floor(usualSize('image').h / GRID) * GRID;
    const y = nextY(items);
    if (y + textH + gap + imageH > POS_MAX) {
      setStatus('no room under the page');
      return;
    }
    const made: Item[] = [];
    for (let i = 0; i < n; i++) {
      const x = GRID + i * (colW + gap);
      const stamp = Math.random().toString(36).slice(2, 8);
      made.push({
        key: `text-col-${stamp}`,
        type: 'text',
        id: 0,
        x,
        y,
        z: 0,
        w: colW,
        h: textH,
        ...blankLook(),
        html: '',
        src: ''
      });
      made.push({
        key: `image-col-${stamp}`,
        type: 'image',
        id: 0,
        x,
        y: y + textH + gap,
        z: 0,
        w: colW,
        h: imageH,
        ...blankLook(),
        html: '',
        src: ''
      });
    }
    const first = made[0];
    if (!first) return;
    setFocusKey(first.key);
    setPicked(first.key);
    setSelected(made.map((block) => block.key));
    touch((list) => {
      let z = list.reduce((max, block) => Math.max(max, block.z), 0);
      return [
        ...list,
        ...made.map((block) => {
          z = Math.min(Z_MAX, z + 1);
          return { ...block, z };
        })
      ];
    });
    reveal(y);
  };

  const addText = () => {
    if (items.length >= BLOCKS_MAX) {
      setStatus('40 blocks at most');
      return;
    }
    const key = `text-new-${Math.random().toString(36).slice(2, 8)}`;
    const size = usualSize('text');
    setFocusKey(key);
    setSelected([key]);
    const y = nextY(items);
    const width = Math.min(size.w, Math.max(minBox('text').w, pageWidth() - GRID));
    touch((list) => [...list, { key, type: 'text', id: 0, x: GRID, y, z: nextZ(list), w: width, h: size.h, ...blankLook(), html: '', src: '' }]);
    setPicked(key);
    reveal(y);
  };

  const addShape = (type: 'line' | 'box' | 'border') => {
    if (items.length >= BLOCKS_MAX) {
      setStatus('40 blocks at most');
      return;
    }
    const size = usualSize(type);
    const width = Math.min(size.w, Math.max(minBox(type).w, pageWidth() - GRID));
    const key = `${type}-${Math.random().toString(36).slice(2, 8)}`;
    const y = nextY(items);
    const look = blankLook();
    if (type === 'line') look.bg = '#d4d7de';
    if (type === 'box') {
      look.bg = '#3a4150';
      look.stroke = 2;
      look.strokeColor = '#d4d7de';
    }
    if (type === 'border') {
      look.stroke = 2;
      look.strokeColor = '#d4d7de';
    }
    setPicked(key);
    setSelected([key]);
    touch((list) => [...list, { key, type, id: 0, x: GRID, y, z: nextZ(list), w: width, h: size.h, ...look, html: '', src: '' }]);
    reveal(y);
  };

  const pick = (accept: string, x: number, y: number, key: string | null) => {
    place.current = { x, y, key, accept };
    const input = fileRef.current;
    if (!input) return;
    input.accept = accept;
    input.value = '';
    input.click();
  };

  const takeFile = async (file: File, x: number, y: number, replaceKey: string | null) => {
    const type = fileType(file);
    if (!type) {
      setStatus('use a picture, an mp4 or webm, or a sound');
      return;
    }
    if (!replaceKey && itemsRef.current.length >= BLOCKS_MAX) {
      setStatus('40 blocks at most');
      return;
    }
    const blob = URL.createObjectURL(file);
    const key = replaceKey ?? `${type}-${Math.random().toString(36).slice(2, 8)}`;
    const size = usualSize(type);
    if (replaceKey) {
      touch((list) =>
        list.map((block) => {
          if (block.key !== replaceKey) return block;
          if (block.src.startsWith('blob:')) URL.revokeObjectURL(block.src);
          return { ...block, id: 0, src: blob, type, ...blankLook(), r: block.r };
        })
      );
    } else {
      const width = pageWidth();
      const at = snapSpan(x, size.w, edgeLines(itemsRef.current, 'x', width), width);
      const down = snapSpan(y, size.h, edgeLines(itemsRef.current, 'y', POS_MAX), POS_MAX);
      touch((list) => [...list, { key, type, id: 0, x: at.at, y: down.at, z: nextZ(list), ...size, ...blankLook(), html: '', src: blob }]);
      reveal(down.at);
    }
    try {
      const saved = await api.saveAboutFile(name, type, file);
      URL.revokeObjectURL(blob);
      touch((list) => list.map((block) => (block.key === key ? { ...block, id: saved.id, src: saved.src } : block)));
    } catch (err: unknown) {
      setStatus(`not saved: ${err instanceof Error ? err.message : 'could not save'}`);
    }
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    if (!editing) return;
    const file = e.dataTransfer.files[0];
    if (!file) return;
    e.preventDefault();
    const page = pageRef.current;
    if (!page) return;
    const rect = page.getBoundingClientRect();
    void takeFile(file, e.clientX - rect.left, e.clientY - rect.top, null);
  };

  const turn = (key: string, r: number) => {
    setItems((list) => {
      const item = list.find((block) => block.key === key);
      if (!item || item.r === r) return list;
      dirty.current = true;
      return list.map((block) => (block.key === key ? { ...block, r } : block));
    });
  };

  const patch = (key: string, part: Partial<Item>) => {
    touch((list) => list.map((block) => (block.key === key ? { ...block, ...part } : block)));
  };

  const placeBlock = (key: string, x: number, y: number) => {
    setItems((list) => {
      const item = list.find((block) => block.key === key);
      if (!item || (item.x === x && item.y === y)) return list;
      dirty.current = true;
      return list.map((block) => (block.key === key ? { ...block, x, y } : block));
    });
  };

  /** Move a group from the positions it had when the drag started, so the pieces stay put relative to each other. */
  const placeGroup = (starts: { key: string; x: number; y: number }[], dx: number, dy: number) => {
    setItems((list) => {
      const by = new Map(starts.map((start) => [start.key, start]));
      let changed = false;
      const next = list.map((block) => {
        const start = by.get(block.key);
        if (!start) return block;
        const x = start.x + dx;
        const y = start.y + dy;
        if (block.x === x && block.y === y) return block;
        changed = true;
        return { ...block, x, y };
      });
      if (!changed) return list;
      dirty.current = true;
      return next;
    });
  };

  const sizeBlock = (key: string, w: number, h: number) => {
    setItems((list) => {
      const item = list.find((block) => block.key === key);
      if (!item || (item.w === w && item.h === h)) return list;
      dirty.current = true;
      return list.map((block) => (block.key === key ? { ...block, w, h } : block));
    });
  };

  /** Pointer position on the page, and a scroll when it sits on the edge of the window, so a drag
   * reaches the same spot however far down the page that spot is. */
  const dragOnPage = (e: ReactPointerEvent, apply: (x: number, y: number, clientX: number, clientY: number) => void, done: () => void) => {
    e.preventDefault();
    e.stopPropagation();
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    let lastX = e.clientX;
    let lastY = e.clientY;
    let frame = 0;
    const applyNow = () => {
      const page = pageRef.current;
      if (!page) return;
      const rect = page.getBoundingClientRect();
      apply(lastX - rect.left, lastY - rect.top, lastX, lastY);
    };
    const tick = () => {
      const scroller = scrollRef.current;
      if (!scroller) return;
      const view = scroller.getBoundingClientRect();
      const edge = 36;
      let sx = 0;
      let sy = 0;
      if (lastY > view.bottom - edge) sy = 16;
      else if (lastY < view.top + edge) sy = -16;
      if (lastX > view.right - edge) sx = 16;
      else if (lastX < view.left + edge) sx = -16;
      if (sx || sy) {
        const beforeL = scroller.scrollLeft;
        const beforeT = scroller.scrollTop;
        scroller.scrollLeft = Math.max(0, beforeL + sx);
        scroller.scrollTop = Math.max(0, beforeT + sy);
        if (scroller.scrollLeft !== beforeL || scroller.scrollTop !== beforeT) applyNow();
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    const move = (ev: globalThis.PointerEvent) => {
      lastX = ev.clientX;
      lastY = ev.clientY;
      applyNow();
    };
    const up = () => {
      cancelAnimationFrame(frame);
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      done();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  };

  const remove = (key: string) => {
    if (picked === key) setPicked(null);
    setSelected((keys) => keys.filter((item) => item !== key));
    touch((list) => {
      const gone = list.find((item) => item.key === key);
      if (gone?.src.startsWith('blob:')) URL.revokeObjectURL(gone.src);
      return list.filter((item) => item.key !== key);
    });
  };

  const stopEdit = () => {
    if (dirty.current) persistRef.current(itemsRef.current);
    setEditing(false);
  };

  const saveNow = () => {
    if (dirty.current) persistRef.current(itemsRef.current);
    else if (itemsRef.current.length > 0) setStatus('saved');
    setEditing(false);
  };

  const chosen = items.find((block) => block.key === picked) ?? null;

  return (
    <>
      {editing && (
        <>
          <p className="text-sm text-textTertiary">drag the tab to move a block. it snaps to the grid and to the others. drag across the page to select a group, then move that group from any of its tabs. rotate turns text, a picture, or a shape. a preset lays columns, text over a picture in each. the page is as wide as this column, up to the chat.</p>
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <span className="pb-2 text-xs font-semibold uppercase tracking-wider text-textTertiary">preset</span>
            {([1, 2, 3] as const).map((n) => (
              <button
                key={n}
                id={`about-preset-${n}`}
                type="button"
                aria-label={n === 1 ? '1 column' : `${n} columns`}
                className="flex flex-col items-center gap-1 border border-primaryStroke px-2 py-1.5 text-sm font-semibold text-primaryBlue hover:border-primaryBlue"
                onClick={() => addColumns(n)}
              >
                <ColumnSketch n={n} />
                {n === 1 ? '1 column' : `${n} columns`}
              </button>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="text-xs font-semibold uppercase tracking-wider text-textTertiary">add</span>
            <button id="about-add-text" type="button" className={ADD} onClick={addText}>
              text
            </button>
            <button id="about-add-image" type="button" className={ADD} onClick={() => pick('image/*', GRID, nextY(items), null)}>
              image
            </button>
            <button id="about-add-video" type="button" className={ADD} onClick={() => pick('video/mp4,video/webm', GRID, nextY(items), null)}>
              video
            </button>
            <button id="about-add-sound" type="button" className={ADD} onClick={() => pick('audio/*', GRID, nextY(items), null)}>
              sound
            </button>
            <button id="about-add-line" type="button" className={ADD} onClick={() => addShape('line')}>
              line
            </button>
            <button id="about-add-box" type="button" className={ADD} onClick={() => addShape('box')}>
              box
            </button>
            <button id="about-add-border" type="button" className={ADD} onClick={() => addShape('border')}>
              border
            </button>
          </div>
          {chosen && <LookBar block={chosen} onChange={(part) => patch(chosen.key, part)} />}
          <div id="about-canvas" ref={scrollRef} className="mt-3 h-[32rem] overflow-auto border border-dashed border-primaryStroke">
            <div style={{ height: TAB }} />
            <div
              ref={pageRef}
              className="relative w-full"
              style={{
                height: POS_MAX,
                backgroundImage:
                  'linear-gradient(to right, rgb(var(--primary-stroke) / 0.45) 1px, transparent 1px), linear-gradient(to bottom, rgb(var(--primary-stroke) / 0.45) 1px, transparent 1px)',
                backgroundSize: `${GRID * 2}px ${GRID * 2}px`
              }}
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes('Files')) return;
                e.preventDefault();
              }}
              onDrop={onDrop}
              onPointerDown={(e) => {
                if (e.target !== e.currentTarget || e.button !== 0) return;
                const page = pageRef.current;
                if (!page) return;
                const rect = page.getBoundingClientRect();
                const x0 = e.clientX - rect.left;
                const y0 = e.clientY - rect.top;
                let drew = false;
                dragOnPage(
                  e,
                  (x, y) => {
                    const box = { x: Math.min(x0, x), y: Math.min(y0, y), w: Math.abs(x - x0), h: Math.abs(y - y0) };
                    setMarquee(box);
                    if (box.w < 4 && box.h < 4) return;
                    drew = true;
                    const keys = itemsRef.current.filter((block) => overlaps(block, box)).map((block) => block.key);
                    setSelected((cur) => (sameKeys(cur, keys) ? cur : keys));
                    setPicked(keys.length === 1 ? (keys[0] ?? null) : null);
                  },
                  () => {
                    setMarquee(null);
                    if (!drew) {
                      setSelected([]);
                      setPicked(null);
                    }
                  }
                );
              }}
            >
              {lines.x !== null && <div className="pointer-events-none absolute bottom-0 top-0 z-30 w-px bg-primaryBlue" style={{ left: lines.x }} />}
              {lines.y !== null && <div className="pointer-events-none absolute left-0 right-0 z-30 h-px bg-primaryBlue" style={{ top: lines.y }} />}
              {marquee && marquee.w + marquee.h > 0 && (
                <div className="pointer-events-none absolute z-30 border border-primaryBlue bg-primaryBlue/10" style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }} />
              )}
              {items.map((block) => (
                <div
                  key={block.key}
                  data-selected={selected.includes(block.key) ? 'true' : undefined}
                  className={cn('absolute', selected.includes(block.key) && 'outline outline-1 outline-primaryBlue')}
                  style={{ left: block.x, top: block.y, width: block.w, height: block.h, zIndex: block.z + 1 }}
                >
                  <div
                    className={cn(
                      'absolute bottom-full left-0 z-10 flex h-6 cursor-grab touch-none select-none items-center gap-2 whitespace-nowrap border border-b-0 bg-background px-2',
                      selected.includes(block.key) ? 'border-primaryBlue' : 'border-primaryStroke'
                    )}
                    aria-label="drag to move"
                    onPointerDown={(e) => {
                      setPicked(block.key);
                      const inGroup = selected.includes(block.key) && selected.length > 1;
                      const keys = inGroup ? selected : [block.key];
                      if (!inGroup) setSelected([block.key]);
                      const starts = itemsRef.current
                        .filter((item) => keys.includes(item.key))
                        .map((item) => ({ key: item.key, x: item.x, y: item.y, w: item.w, h: item.h }));
                      const page = pageRef.current;
                      if (!page) return;
                      const rect = page.getBoundingClientRect();
                      const grabX = e.clientX - rect.left - block.x;
                      const grabY = e.clientY - rect.top - block.y;
                      const leader = { x: block.x, y: block.y, w: block.w, h: block.h };
                      dragOnPage(
                        e,
                        (x, y) => {
                          const rest = itemsRef.current.filter((item) => !keys.includes(item.key));
                          const width = pageWidth();
                          const sx = snapSpan(x - grabX, leader.w, edgeLines(rest, 'x', width), width);
                          const sy = snapSpan(y - grabY, leader.h, edgeLines(rest, 'y', POS_MAX), POS_MAX);
                          const shift = groupShift(starts, sx.at - leader.x, sy.at - leader.y, width);
                          const landed = shift.dx === sx.at - leader.x && shift.dy === sy.at - leader.y;
                          setLines((cur) => {
                            const next = landed ? { x: sx.guide, y: sy.guide } : { x: null, y: null };
                            return cur.x === next.x && cur.y === next.y ? cur : next;
                          });
                          if (keys.length > 1) placeGroup(starts, shift.dx, shift.dy);
                          else placeBlock(block.key, leader.x + shift.dx, leader.y + shift.dy);
                        },
                        () => setLines({ x: null, y: null })
                      );
                    }}
                  >
                    <span className="text-sm text-textSecondary">{block.type}</span>
                    <button
                      type="button"
                      className={QUIET}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => touch((list) => list.map((item) => (item.key === block.key ? { ...item, z: nextZ(list) } : item)))}
                    >
                      front
                    </button>
                    {isMedia(block.type) && (
                      <button
                        type="button"
                        className={QUIET}
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={() => pick(block.type === 'image' ? 'image/*' : block.type === 'video' ? 'video/mp4,video/webm' : 'audio/*', block.x, block.y, block.key)}
                      >
                        replace
                      </button>
                    )}
                    <button type="button" className={QUIET} onPointerDown={(e) => e.stopPropagation()} onClick={() => remove(block.key)}>
                      remove
                    </button>
                    {canTurn(block.type) && (
                      <button
                        type="button"
                        aria-label="rotate"
                        className={cn(QUIET, 'cursor-grab touch-none')}
                        onPointerDown={(e) => {
                          setPicked(block.key);
                          const box = e.currentTarget.parentElement?.parentElement?.getBoundingClientRect();
                          if (!box) return;
                          const cx = box.left + box.width / 2;
                          const cy = box.top + box.height / 2;
                          dragOnPage(
                            e,
                            (_x, _y, clientX, clientY) => {
                              let deg = (Math.atan2(clientY - cy, clientX - cx) * 180) / Math.PI + 90;
                              deg = ((deg + 180) % 360 + 360) % 360 - 180;
                              deg = Math.round(deg / 15) * 15;
                              if (deg <= -180) deg = 180;
                              turn(block.key, deg);
                            },
                            () => {}
                          );
                        }}
                      >
                        rotate
                      </button>
                    )}
                  </div>
                  <div className="relative h-full w-full" style={block.r ? { transform: `rotate(${block.r}deg)` } : undefined}>
                    <div
                      className={cn(
                        'h-full w-full overflow-hidden border border-primaryBlue',
                        block.type === 'line' || block.type === 'box' || block.type === 'border' ? 'bg-transparent' : 'bg-background'
                      )}
                      style={block.type === 'text' && block.bg ? { background: block.bg } : undefined}
                    >
                      {block.type === 'line' || block.type === 'box' || block.type === 'border' ? (
                        <Shape block={block} />
                      ) : (
                        <BlockBody
                          block={block}
                          live
                          focus={focusKey === block.key}
                          onHtml={(html) => touch((list) => list.map((item) => (item.key === block.key ? { ...item, html } : item)))}
                          onChoose={
                            block.type === 'image' && !block.src
                              ? () => pick('image/*', block.x, block.y, block.key)
                              : undefined
                          }
                        />
                      )}
                    </div>
                    <button
                      type="button"
                      aria-label="scale width"
                      className="absolute -right-1 bottom-3 top-3 z-10 w-2 cursor-ew-resize border-x border-primaryStroke bg-background"
                      onPointerDown={(e) => {
                        const page = pageRef.current;
                        if (!page) return;
                        const origin = page.getBoundingClientRect();
                        const start = e.clientX - origin.left;
                        const originW = block.w;
                        const floor = minBox(block.type);
                        dragOnPage(
                          e,
                          (x, y) => {
                            const others = itemsRef.current.filter((item) => item.key !== block.key);
                            const width = pageWidth();
                            const d = localDelta(x - start, y - (e.clientY - origin.top), block.r);
                            const edge = snapEdge(block.x + originW + d.x, edgeLines(others, 'x', width), block.x + floor.w, Math.min(block.x + SIZE_MAX, width));
                            setLines((cur) => (cur.x === edge.guide && cur.y === null ? cur : { x: edge.guide, y: null }));
                            sizeBlock(block.key, edge.at - block.x, block.h);
                          },
                          () => setLines({ x: null, y: null })
                        );
                      }}
                    />
                    <button
                      type="button"
                      aria-label="scale height"
                      className="absolute -bottom-1 left-3 right-3 z-10 h-2 cursor-ns-resize border-y border-primaryStroke bg-background"
                      onPointerDown={(e) => {
                        const page = pageRef.current;
                        if (!page) return;
                        const origin = page.getBoundingClientRect();
                        const start = e.clientY - origin.top;
                        const originH = block.h;
                        const floor = minBox(block.type);
                        dragOnPage(
                          e,
                          (x, y) => {
                            const others = itemsRef.current.filter((item) => item.key !== block.key);
                            const d = localDelta(x - (e.clientX - origin.left), y - start, block.r);
                            const edge = snapEdge(block.y + originH + d.y, edgeLines(others, 'y', POS_MAX), block.y + floor.h, Math.min(block.y + SIZE_MAX, POS_MAX));
                            setLines((cur) => (cur.x === null && cur.y === edge.guide ? cur : { x: null, y: edge.guide }));
                            sizeBlock(block.key, block.w, edge.at - block.y);
                          },
                          () => setLines({ x: null, y: null })
                        );
                      }}
                    />
                    <button
                      type="button"
                      aria-label="scale"
                      className="absolute -bottom-1.5 -right-1.5 z-20 h-3 w-3 cursor-nwse-resize border border-primaryStroke bg-background"
                      onPointerDown={(e) => {
                        const page = pageRef.current;
                        if (!page) return;
                        const origin = page.getBoundingClientRect();
                        const startX = e.clientX - origin.left;
                        const startY = e.clientY - origin.top;
                        const originW = block.w;
                        const originH = block.h;
                        const floor = minBox(block.type);
                        dragOnPage(
                          e,
                          (x, y) => {
                            const others = itemsRef.current.filter((item) => item.key !== block.key);
                            const width = pageWidth();
                            const d = localDelta(x - startX, y - startY, block.r);
                            const right = snapEdge(block.x + originW + d.x, edgeLines(others, 'x', width), block.x + floor.w, Math.min(block.x + SIZE_MAX, width));
                            const bottom = snapEdge(block.y + originH + d.y, edgeLines(others, 'y', POS_MAX), block.y + floor.h, Math.min(block.y + SIZE_MAX, POS_MAX));
                            setLines((cur) => (cur.x === right.guide && cur.y === bottom.guide ? cur : { x: right.guide, y: bottom.guide }));
                            sizeBlock(block.key, right.at - block.x, bottom.at - block.y);
                          },
                          () => setLines({ x: null, y: null })
                        );
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
      <input
        ref={fileRef}
        type="file"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          const at = place.current;
          void takeFile(file, at.x, at.y, at.key);
        }}
      />
      {edit && (
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1">
          <button id="about-edit" type="button" className={ADD} onClick={() => (editing ? stopEdit() : setEditing(true))}>
            {editing ? 'stop edit' : 'edit'}
          </button>
          {editing && (
            <button id="about-save" type="button" className={ADD} onClick={saveNow}>
              save
            </button>
          )}
          {status && <span className="text-sm text-textTertiary">{status}</span>}
        </div>
      )}
      <section id={scope} className={cn(boxClass, 'h-[32rem] min-w-0 p-0')} aria-label={`about ${name}`}>
        {css && <style>{css}</style>}
        {edit && loaded && !editing && items.length === 0 ? (
          <button type="button" className="flex min-h-0 w-full flex-1 flex-col items-center justify-center gap-3 text-textTertiary hover:text-primaryBlue" onClick={() => setEditing(true)}>
            <RiPencilLine size={36} aria-hidden />
            <span className="text-sm">edit this. make it yours</span>
          </button>
        ) : (
        <div ref={previewPageRef} className="relative w-full shrink-0" style={{ height: POS_MAX }}>
          {items.map((block) => (
            <div
              key={block.key}
              className="absolute"
              style={{ left: block.x, top: block.y, width: block.w, height: block.h, zIndex: block.z + 1, transform: block.r ? `rotate(${block.r}deg)` : undefined }}
            >
              <div className="h-full w-full overflow-hidden" style={block.type === 'text' && block.bg ? { background: block.bg } : undefined}>
                {block.type === 'line' || block.type === 'box' || block.type === 'border' ? (
                  <Shape block={block} />
                ) : (
                  <BlockBody block={block} live={false} focus={false} onHtml={() => {}} />
                )}
              </div>
            </div>
          ))}
        </div>
        )}
      </section>
    </>
  );
}
