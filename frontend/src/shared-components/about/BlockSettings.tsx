import { RiAddLine, RiBold, RiDeleteBinLine, RiH2, RiItalic, RiLink, RiListUnordered } from '@remixicon/react';
import { type ChangeEvent, type ReactNode, useRef, useState } from 'react';

import {
  ACCENTS,
  type AboutBlock,
  ALIGNS,
  FILLS,
  FONT_WORD,
  FONTS,
  type FileKind,
  ITEMS_MAX,
  LABEL_MAX,
  MD_MAX,
  PHONES,
  SUB_MAX,
  TITLE_MAX,
  WANTS,
  cleanLink,
  fileSrc,
  spanOptions
} from '@/infra/about-blocks';
import { Button } from '@/shared-components/Button';
import { INPUT } from '@/shared-components/input';
import { Segmented } from '@/shared-components/Segmented';
import { Select } from '@/shared-components/Select';
import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

const ACCEPT: Record<FileKind, string> = { image: 'image/*', video: 'video/mp4,video/webm', sound: 'audio/*' };
const FILE_WORD: Record<FileKind, string> = { image: 'picture', video: 'clip', sound: 'sound' };
const ROW = 'grid grid-cols-[3rem_minmax(0,1fr)] items-center gap-2';
const KEY = 'text-xs text-textTertiary';
const TOOLS: readonly [string, ReactNode, string, string, boolean][] = [
  ['bold', <RiBold key="b" size={14} aria-hidden />, '**', '**', false],
  ['italic', <RiItalic key="i" size={14} aria-hidden />, '*', '*', false],
  ['heading', <RiH2 key="h" size={14} aria-hidden />, '### ', '', true],
  ['list', <RiListUnordered key="l" size={14} aria-hidden />, '- ', '', true],
  ['link', <RiLink key="a" size={14} aria-hidden />, '[', '](https://)', false]
];
const SMALL_INPUT = cn(INPUT, 'py-1 text-sm');
const ICON_BUTTON =
  'flex size-7 shrink-0 items-center justify-center rounded-control border border-primaryStroke bg-backgroundSecondary text-textSecondary transition-colors hover:border-primaryBlue hover:text-textPrimary';

export type Upload = (kind: FileKind, file: File) => Promise<number>;

function Row({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className={ROW}>
      {htmlFor ? (
        <label htmlFor={htmlFor} className={KEY}>
          {label}
        </label>
      ) : (
        <span className={KEY}>{label}</span>
      )}
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function LinkInput({ id, value, onChange, label = 'link' }: { id: string; value: string; onChange: (v: string) => void; label?: string }) {
  const bad = cleanLink(value) === null;
  return (
    <div className="flex flex-col gap-1">
      <input
        id={id}
        aria-label={label}
        aria-invalid={bad || undefined}
        value={value}
        maxLength={500}
        placeholder="link"
        onChange={(e) => onChange(e.target.value)}
        className={cn(SMALL_INPUT, bad && 'border-decrease focus:border-decrease')}
      />
      {bad && <span className="text-xs text-decrease">needs to be an http or https address</span>}
    </div>
  );
}

function wrap(el: HTMLTextAreaElement, before: string, after: string, line = false): { value: string; at: [number, number] } {
  const { value, selectionStart: a, selectionEnd: z } = el;
  if (line) {
    const start = value.lastIndexOf('\n', a - 1) + 1;
    return { value: value.slice(0, start) + before + value.slice(start), at: [a + before.length, z + before.length] };
  }
  const picked = value.slice(a, z) || 'text';
  return { value: value.slice(0, a) + before + picked + after + value.slice(z), at: [a + before.length, a + before.length + picked.length] };
}

function Markdown({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const apply = (before: string, after: string, line = false) => {
    const el = ref.current;
    if (!el) return;
    const next = wrap(el, before, after, line);
    onChange(next.value.slice(0, MD_MAX));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(next.at[0], next.at[1]);
    });
  };
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex gap-1" role="toolbar" aria-label="formatting">
        {TOOLS.map(([word, icon, before, after, line]) => (
          <Tooltip key={word} content={word}>
            <button id={`${id}-${word}`} type="button" aria-label={word} onClick={() => apply(before, after, line)} className={ICON_BUTTON}>
              {icon}
            </button>
          </Tooltip>
        ))}
      </div>
      <textarea
        ref={ref}
        id={id}
        aria-label="words"
        value={value}
        maxLength={MD_MAX}
        rows={6}
        placeholder="words"
        onChange={(e) => onChange(e.target.value)}
        className={cn(INPUT, 'resize-y rounded-card py-1.5 font-mono text-xs leading-relaxed')}
      />
    </div>
  );
}

function FilePick({
  id,
  name,
  kind,
  value,
  onPick,
  onClear
}: {
  id: string;
  name: string;
  kind: FileKind;
  value: number;
  onPick: (file: File) => void;
  onClear: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) onPick(file);
  };
  return (
    <div className="flex items-center gap-2">
      {value > 0 && kind === 'image' && <img src={fileSrc(name, value)} alt="" className="size-7 shrink-0 rounded-control border border-primaryStroke object-cover" />}
      <Button id={id} size="sm" className="px-2 py-1 text-xs max-md:min-h-0" onClick={() => ref.current?.click()}>
        {value > 0 ? `replace ${FILE_WORD[kind]}` : `add ${FILE_WORD[kind]}`}
      </Button>
      {value > 0 && (
        <Tooltip content={`remove the ${FILE_WORD[kind]}`}>
          <button id={`${id}-clear`} type="button" aria-label={`remove the ${FILE_WORD[kind]}`} onClick={onClear} className={ICON_BUTTON}>
            <RiDeleteBinLine size={14} aria-hidden />
          </button>
        </Tooltip>
      )}
      <input ref={ref} type="file" accept={ACCEPT[kind]} className="hidden" onChange={onFile} />
    </div>
  );
}

export function BlockSettings({
  block: b,
  index,
  count,
  name,
  onPatch,
  upload
}: {
  block: AboutBlock;
  index: number;
  count: number;
  name: string;
  onPatch: (part: Partial<AboutBlock>) => void;
  upload: Upload;
}) {
  const wants = WANTS[b.kind];
  const [busy, setBusy] = useState('');
  const id = (part: string) => `about-set-${part}`;
  const send = async (kind: FileKind, file: File, done: (fileId: number) => void) => {
    setBusy(`uploading ${FILE_WORD[kind]}…`);
    try {
      done(await upload(kind, file));
      setBusy('');
    } catch (err: unknown) {
      setBusy(err instanceof Error ? err.message : 'could not upload');
    }
  };
  const setItem = (i: number, part: Partial<AboutBlock['items'][number]>) => onPatch({ items: b.items.map((item, j) => (j === i ? { ...item, ...part } : item)) });

  return (
    <div id="about-settings" className="flex flex-col gap-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-bold text-textPrimary">{b.kind}</h3>
        <span className="text-xs text-textTertiary">
          block {index + 1} of {count}
        </span>
      </div>
      <Row label="width">
        <div className="flex items-center gap-2">
          <Segmented
            id={id('span')}
            label="width"
            value={String(b.span)}
            options={spanOptions(b.span).map((n) => ({ value: String(n), label: String(n) }))}
            onChange={(v) => onPatch({ span: Number(v) })}
            className="min-w-0 flex-1"
          />
        </div>
      </Row>
      <Row label="phone">
        <Segmented
          id={id('phone')}
          label="on phones"
          value={b.phone}
          options={PHONES.map((p) => ({ value: p, label: p }))}
          onChange={(phone) => onPatch({ phone })}
          className="w-full"
        />
      </Row>
      {b.kind !== 'divider' && (
        <Row label="fill">
          <Segmented
            id={id('fill')}
            label="fill"
            value={b.fill}
            options={FILLS.map((f) => ({ value: f, label: f }))}
            onChange={(fill) => onPatch({ fill })}
            className="w-full"
          />
        </Row>
      )}
      {b.fill === 'image' && (
        <Row label="bg">
          <FilePick
            id={id('bg')}
            name={name}
            kind="image"
            value={b.bg}
            onPick={(f) => void send('image', f, (bg) => onPatch({ bg }))}
            onClear={() => onPatch({ bg: 0 })}
          />
        </Row>
      )}
      <Row label="accent">
        <div role="radiogroup" aria-label="accent" className="flex flex-wrap gap-1.5">
          {ACCENTS.map((color) => {
            const on = b.accent === color;
            const word = color || 'default';
            return (
              <Tooltip key={word} content={word}>
                <button
                  id={id(`accent-${color.slice(1) || 'none'}`)}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  aria-label={word}
                  onClick={() => onPatch({ accent: color })}
                  style={{ backgroundColor: color || undefined }}
                  className={cn(
                    'size-5 rounded-control border-2 outline-offset-1',
                    color ? 'border-transparent' : 'border-secondaryStroke bg-background',
                    on && 'outline outline-2 outline-textPrimary'
                  )}
                />
              </Tooltip>
            );
          })}
        </div>
      </Row>
      <Row label="font">
        <Select id={id('font')} label="font" value={b.font} options={FONTS.map((f) => ({ value: f, label: FONT_WORD[f] }))} onChange={(font) => onPatch({ font })} className="w-full text-sm" />
      </Row>
      <Row label="align">
        <Segmented
          id={id('align')}
          label="align"
          value={b.align}
          options={ALIGNS.map((a) => ({ value: a, label: a }))}
          onChange={(align) => onPatch({ align })}
          className="w-full"
        />
      </Row>
      {wants.href && (
        <Row label="link" htmlFor={id('href')}>
          <LinkInput id={id('href')} value={b.href} onChange={(href) => onPatch({ href })} />
        </Row>
      )}

      <div className="mt-1 flex flex-col gap-2 border-t border-primaryStroke pt-2.5">
        {wants.title && (
          <Row label={b.kind === 'divider' ? 'word' : 'title'} htmlFor={id('title')}>
            <input
              id={id('title')}
              value={b.title}
              maxLength={TITLE_MAX}
              placeholder="title"
              onChange={(e) => onPatch({ title: e.target.value })}
              className={SMALL_INPUT}
            />
          </Row>
        )}
        {wants.sub && (
          <Row label={b.kind === 'quote' ? 'by' : 'tagline'} htmlFor={id('sub')}>
            <input
              id={id('sub')}
              value={b.sub}
              maxLength={SUB_MAX}
              placeholder={b.kind === 'quote' ? 'who' : 'tagline'}
              onChange={(e) => onPatch({ sub: e.target.value })}
              className={SMALL_INPUT}
            />
          </Row>
        )}
        {wants.file && (
          <Row label={FILE_WORD[wants.file]}>
            <FilePick
              id={id('file')}
              name={name}
              kind={wants.file}
              value={b.file}
              onPick={(f) => void send(wants.file ?? 'image', f, (file) => onPatch({ file }))}
              onClear={() => onPatch({ file: 0 })}
            />
          </Row>
        )}
        {wants.md && <Markdown id={id('md')} value={b.md} onChange={(md) => onPatch({ md })} />}
        {wants.button && (
          <>
            <Row label="button" htmlFor={id('label')}>
              <input
                id={id('label')}
                value={b.label}
                maxLength={LABEL_MAX}
                placeholder="label"
                onChange={(e) => onPatch({ label: e.target.value })}
                className={SMALL_INPUT}
              />
            </Row>
            {b.label && (
              <Row label="goes to" htmlFor={id('link')}>
                <LinkInput id={id('link')} label="button link" value={b.link} onChange={(link) => onPatch({ link })} />
              </Row>
            )}
          </>
        )}
        {b.kind === 'stats' && (
          <Row label="socials">
            <Segmented
              id={id('socials')}
              label="show socials"
              value={b.socials ? 'on' : 'off'}
              options={[
                { value: 'on', label: 'show' },
                { value: 'off', label: 'hide' }
              ]}
              onChange={(v) => onPatch({ socials: v === 'on' })}
              className="w-full"
            />
          </Row>
        )}
        {wants.items && (
          <div className="flex flex-col gap-2">
            {b.items.map((item, i) => (
              <div key={i} id={id(`item-${i}`)} className="flex flex-col gap-1.5 rounded-card border border-primaryStroke p-2">
                <div className="flex items-center gap-1.5">
                  <input
                    id={id(`item-${i}-label`)}
                    aria-label={`item ${i + 1} label`}
                    value={item.label}
                    maxLength={LABEL_MAX}
                    placeholder="label"
                    onChange={(e) => setItem(i, { label: e.target.value })}
                    className={SMALL_INPUT}
                  />
                  <Tooltip content="remove">
                    <button
                      id={id(`item-${i}-remove`)}
                      type="button"
                      aria-label={`remove item ${i + 1}`}
                      onClick={() => onPatch({ items: b.items.filter((_, j) => j !== i) })}
                      className={ICON_BUTTON}
                    >
                      <RiDeleteBinLine size={14} aria-hidden />
                    </button>
                  </Tooltip>
                </div>
                <LinkInput id={id(`item-${i}-href`)} label={`item ${i + 1} link`} value={item.href} onChange={(href) => setItem(i, { href })} />
                {b.kind === 'gallery' && (
                  <FilePick
                    id={id(`item-${i}-file`)}
                    name={name}
                    kind="image"
                    value={item.file}
                    onPick={(f) => void send('image', f, (file) => setItem(i, { file }))}
                    onClear={() => setItem(i, { file: 0 })}
                  />
                )}
              </div>
            ))}
            {b.items.length < ITEMS_MAX && (
              <Button
                id={id('item-add')}
                size="sm"
                className="gap-1 self-start px-2 py-1 text-xs max-md:min-h-0"
                onClick={() => onPatch({ items: [...b.items, { file: 0, label: '', href: '' }] })}
              >
                <RiAddLine size={14} aria-hidden />
                {b.kind === 'gallery' ? 'add a tile' : 'add a button'}
              </Button>
            )}
          </div>
        )}
        {b.kind === 'socials' && <p className="text-xs text-textTertiary">shows the links from your socials tab.</p>}
        {b.kind === 'schedule' && <p className="text-xs text-textTertiary">days light up from your last 4 weeks of streams.</p>}
        {busy && (
          <p role="status" className="text-xs text-textTertiary">
            {busy}
          </p>
        )}
      </div>
    </div>
  );
}
