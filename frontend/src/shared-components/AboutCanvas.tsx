import { type DragEvent, type PointerEvent as ReactPointerEvent, type ReactNode, useEffect, useRef, useState } from 'react';

import { BLOCKS_MAX, POS_MAX, type PageBlock, type PageType, TEXT_MAX, Z_MAX, sanitizeHtml } from '@/infra/about';
import { api } from '@/infra/api';

const ADD = 'text-sm font-semibold text-primaryBlue';
const QUIET = 'text-sm text-textTertiary';
const W_MIN = 80;
const H_MIN = 40;
const SIZE_MAX = 800;

interface Item {
  key: string;
  type: PageType;
  id: number;
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  html: string;
  src: string;
}

function usualSize(type: PageType): { w: number; h: number } {
  if (type === 'text') return { w: 280, h: 120 };
  if (type === 'video') return { w: 320, h: 200 };
  if (type === 'sound') return { w: 280, h: 56 };
  return { w: 300, h: 180 };
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

function clampSize(n: number, min: number): number {
  return Math.max(min, Math.min(SIZE_MAX, Math.round(n)));
}

function Rich({ html }: { html: string }) {
  const safe = sanitizeHtml(html);
  if (!safe) return null;
  const doc = new DOMParser().parseFromString(safe, 'text/html');
  const nodes = [...doc.body.childNodes].map((node, i) => richNode(node, `t${i}`));
  return <div className="about-text h-full overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere]">{nodes}</div>;
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

function TextEditor({ html, autoFocus, onChange }: { html: string; autoFocus?: boolean; onChange: (html: string) => void }) {
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
    />
  );
}

function BlockBody({ block, live, focus, onHtml }: { block: Item; live: boolean; focus: boolean; onHtml: (html: string) => void }) {
  if (block.type === 'text') {
    if (live) return <TextEditor html={block.html} autoFocus={focus} onChange={onHtml} />;
    return <Rich html={block.html} />;
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
 * save writes the layout (it also saves on its own).
 */
export function AboutCanvas({ name, edit, scope, css, boxClass, initial = null }: AboutCanvasProps) {
  const [items, setItems] = useState<Item[]>([]);
  const [status, setStatus] = useState('');
  const [editing, setEditing] = useState(false);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const ready = useRef(false);
  const dirty = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const place = useRef<{ x: number; y: number; key: string | null; accept: string }>({ x: 16, y: 16, key: null, accept: 'image/*' });
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const persist = (list: Item[]) => {
    const pending = list.some((block) => block.type !== 'text' && block.id === 0);
    const sent = list.filter((block) => block.type === 'text' || block.id !== 0);
    if (pending && sent.length === 0) return;
    dirty.current = false;
    setStatus('saving');
    api
      .saveAboutPage(
        name,
        sent.map((block) =>
          block.type === 'text'
            ? { type: 'text', id: block.id, x: block.x, y: block.y, z: block.z, w: block.w, h: block.h, html: sanitizeHtml(block.html) }
            : { type: block.type, id: block.id, x: block.x, y: block.y, z: block.z, w: block.w, h: block.h }
        )
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
      return () => {
        dead = true;
      };
    }
    if (!edit) return;
    setItems([]);
    api
      .aboutPage(name)
      .then((page) => apply(page.blocks))
      .catch(() => {
        if (!dead) ready.current = true;
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

  const nextZ = (list: Item[]) => clamp(list.reduce((max, block) => Math.max(max, block.z), 0) + 1, Z_MAX);
  const nextY = (list: Item[]) => {
    if (list.length === 0) return 16;
    return clamp(Math.max(...list.map((block) => block.y + block.h)) + 16, POS_MAX);
  };

  const addText = () => {
    if (items.length >= BLOCKS_MAX) {
      setStatus('40 blocks at most');
      return;
    }
    const key = `text-new-${Math.random().toString(36).slice(2, 8)}`;
    const size = usualSize('text');
    setFocusKey(key);
    touch((list) => [...list, { key, type: 'text', id: 0, x: 16, y: nextY(list), z: nextZ(list), ...size, html: '', src: '' }]);
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
          return { ...block, id: 0, src: blob, type };
        })
      );
    } else {
      touch((list) => [...list, { key, type, id: 0, x: clamp(x, POS_MAX), y: clamp(y, POS_MAX), z: nextZ(list), ...size, html: '', src: blob }]);
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
    const rect = e.currentTarget.getBoundingClientRect();
    void takeFile(file, e.clientX - rect.left, e.clientY - rect.top, null);
  };

  const dragBy = (e: ReactPointerEvent, apply: (dx: number, dy: number) => void) => {
    e.preventDefault();
    e.stopPropagation();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startY = e.clientY;
    const move = (ev: PointerEvent) => apply(ev.clientX - startX, ev.clientY - startY);
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  };

  const remove = (key: string) => {
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
    if (!dirty.current) {
      setStatus(itemsRef.current.length === 0 ? '' : 'saved');
      return;
    }
    persistRef.current(itemsRef.current);
  };

  const bottom = items.reduce((max, block) => Math.max(max, block.y + block.h), 0);
  const editorHeight = Math.max(320, bottom + 24);
  const previewHeight = Math.max(160, bottom + 16);

  return (
    <>
      {editing && (
        <>
          <p className="text-sm text-textTertiary">drag the tab to move a block. the corner and the edges scale it. the preview under this is the page.</p>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="text-xs font-semibold uppercase tracking-wider text-textTertiary">add</span>
            <button id="about-add-text" type="button" className={ADD} onClick={addText}>
              text
            </button>
            <button id="about-add-image" type="button" className={ADD} onClick={() => pick('image/*', 16, nextY(items), null)}>
              image
            </button>
            <button id="about-add-video" type="button" className={ADD} onClick={() => pick('video/mp4,video/webm', 16, nextY(items), null)}>
              video
            </button>
            <button id="about-add-sound" type="button" className={ADD} onClick={() => pick('audio/*', 16, nextY(items), null)}>
              sound
            </button>
          </div>
          <div className="relative mt-3 border border-dashed border-primaryStroke" style={{ height: editorHeight + 28 }}>
            <div
              className="absolute inset-x-0 bottom-0 top-7"
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes('Files')) return;
                e.preventDefault();
              }}
              onDrop={onDrop}
            >
              {items.map((block) => (
                <div key={block.key} className="absolute" style={{ left: block.x, top: block.y, width: block.w, height: block.h, zIndex: block.z + 1 }}>
                  <div
                    className="absolute bottom-full left-0 z-10 flex h-6 cursor-grab touch-none select-none items-center gap-2 whitespace-nowrap border border-b-0 border-primaryStroke bg-background px-2"
                    aria-label="drag to move"
                    onPointerDown={(e) => {
                      const originX = block.x;
                      const originY = block.y;
                      dragBy(e, (dx, dy) => {
                        touch((list) =>
                          list.map((item) =>
                            item.key === block.key ? { ...item, x: clamp(originX + dx, POS_MAX), y: clamp(originY + dy, POS_MAX) } : item
                          )
                        );
                      });
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
                    {block.type !== 'text' && (
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
                  </div>
                  <div className="h-full w-full overflow-hidden border border-primaryBlue bg-background">
                    <BlockBody
                      block={block}
                      live
                      focus={focusKey === block.key}
                      onHtml={(html) => touch((list) => list.map((item) => (item.key === block.key ? { ...item, html } : item)))}
                    />
                  </div>
                  <button
                    type="button"
                    aria-label="scale width"
                    className="absolute -right-1 bottom-3 top-3 z-10 w-2 cursor-ew-resize border-x border-primaryStroke bg-background"
                    onPointerDown={(e) => {
                      const origin = block.w;
                      dragBy(e, (dx) => {
                        touch((list) => list.map((item) => (item.key === block.key ? { ...item, w: clampSize(origin + dx, W_MIN) } : item)));
                      });
                    }}
                  />
                  <button
                    type="button"
                    aria-label="scale height"
                    className="absolute -bottom-1 left-3 right-3 z-10 h-2 cursor-ns-resize border-y border-primaryStroke bg-background"
                    onPointerDown={(e) => {
                      const origin = block.h;
                      dragBy(e, (_dx, dy) => {
                        touch((list) => list.map((item) => (item.key === block.key ? { ...item, h: clampSize(origin + dy, H_MIN) } : item)));
                      });
                    }}
                  />
                  <button
                    type="button"
                    aria-label="scale"
                    className="absolute -bottom-1.5 -right-1.5 z-20 h-3 w-3 cursor-nwse-resize border border-primaryStroke bg-background"
                    onPointerDown={(e) => {
                      const originW = block.w;
                      const originH = block.h;
                      dragBy(e, (dx, dy) => {
                        touch((list) =>
                          list.map((item) =>
                            item.key === block.key ? { ...item, w: clampSize(originW + dx, W_MIN), h: clampSize(originH + dy, H_MIN) } : item
                          )
                        );
                      });
                    }}
                  />
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
      <section id={scope} className={boxClass} aria-label={`about ${name}`}>
        {css && <style>{css}</style>}
        <div className="relative w-full" style={{ height: previewHeight }}>
          {items.length === 0 && <p className="text-sm text-textTertiary">nothing on the page yet.</p>}
          {items.map((block) => (
            <div key={block.key} className="absolute overflow-hidden" style={{ left: block.x, top: block.y, width: block.w, height: block.h, zIndex: block.z + 1 }}>
              <BlockBody block={block} live={false} focus={false} onHtml={() => {}} />
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
