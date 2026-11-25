import { RiAddLine, RiDeleteBinLine, RiImageLine, RiLink, RiMusic2Line, RiPencilLine, RiRefreshLine, RiVideoLine } from '@remixicon/react';
import { type ChangeEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { BLOCKS_MAX } from '@/infra/about';
import {
  BODY_MAX,
  CARD_TITLES,
  type Card,
  type CardKey,
  type CardMedia,
  LINK_MAX,
  type MediaKind,
  TITLE_MAX,
  blocksToCards,
  cardsToBlocks,
  cleanLink,
  overLimit,
  shownCards,
  titleOf,
  withSavedIds
} from '@/infra/about-cards';
import { api } from '@/infra/api';
import { Button } from '@/shared-components/Button';
import { ExternalLink } from '@/shared-components/ExternalLink';
import { INPUT } from '@/shared-components/input';
import { splitLinks } from '@/shared-components/LinkedText';
import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

const ACCEPT: Record<MediaKind, string> = { image: 'image/*', video: 'video/mp4,video/webm', sound: 'audio/*' };
const MEDIA_WORD: Record<MediaKind, string> = { image: 'picture', video: 'clip', sound: 'sound' };
const MEDIA_ICON: Record<MediaKind, ReactNode> = {
  image: <RiImageLine size={16} aria-hidden />,
  video: <RiVideoLine size={16} aria-hidden />,
  sound: <RiMusic2Line size={16} aria-hidden />
};
const PLACEHOLDER: Record<CardKey, string> = {
  stream: 'games',
  when: 'schedule',
  setup: 'gear',
  rules: 'rules',
  links: 'links',
  faq: 'questions',
  more: 'about'
};
const FROM = 'the streamer put this link on their page, not this site.';

const LABEL = 'text-xs font-semibold uppercase tracking-wider text-textTertiary';
const LINK = 'text-primaryBlue underline-offset-2 hover:underline';

const uid = () => Math.random().toString(36).slice(2, 8);

function revoke(src: string | undefined): void {
  if (src?.startsWith('blob:')) URL.revokeObjectURL(src);
}

function fmtClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function shortLink(href: string): string {
  try {
    const url = new URL(href);
    const rest = `${url.pathname === '/' ? '' : url.pathname}${url.search}${url.hash}`;
    return `${url.host.replace(/^www\./, '')}${rest}`;
  } catch {
    return href;
  }
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

function Clip({ src }: { src: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [on, setOn] = useState(false);
  const [length, setLength] = useState(0);
  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-card border border-primaryStroke bg-black">
      <video
        ref={ref}
        src={src}
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
          onClick={() => {
            setOn(true);
            ref.current?.play().catch(() => setOn(false));
          }}
          className="absolute inset-0 flex items-center justify-center text-white"
        >
          <PlayGlyph size={40} />
          {length > 0 && <span className="absolute bottom-2 right-2 rounded-control bg-black/70 px-1.5 text-xs tabular-nums">{fmtClock(length)}</span>}
        </button>
      )}
    </div>
  );
}

function Track({ src }: { src: string }) {
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
    <div className="about-track flex w-full flex-col gap-1.5 rounded-card border border-primaryStroke p-3" data-playing={playing || undefined}>
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
      <div className="flex items-center gap-3">
        <button type="button" onClick={toggle} disabled={broken} className="inline-flex shrink-0 items-center gap-1 text-sm font-semibold text-primaryBlue disabled:opacity-40">
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

function MediaView({ media }: { media: CardMedia }) {
  if (media.kind === 'image')
    return <img src={media.src} alt="" draggable={false} className="about-image block h-auto max-h-[28rem] max-w-full rounded-card border border-primaryStroke bg-black" />;
  if (media.kind === 'video') return <Clip key={media.src} src={media.src} />;
  return <Track key={media.src} src={media.src} />;
}

function Body({ text }: { text: string }) {
  return (
    <p className="about-text whitespace-pre-wrap text-sm leading-relaxed text-textPrimary [overflow-wrap:anywhere]">
      {splitLinks(text).map((part, i) =>
        typeof part === 'string' ? (
          part
        ) : (
          <ExternalLink key={i} href={part.href} from={FROM} className={LINK}>
            {part.text}
          </ExternalLink>
        )
      )}
    </p>
  );
}

function CardView({ card }: { card: Card }) {
  const link = cleanLink(card.link);
  const body = card.body.trim() ? card.body.replace(/^\n+|\s+$/g, '') : '';
  return (
    <section id={`about-view-${card.key}`} aria-label={titleOf(card)} className="flex min-w-0 flex-col gap-2">
      <h3 className={LABEL}>{titleOf(card)}</h3>
      {body && <Body text={body} />}
      {link && (
        <ExternalLink href={link} from={FROM} className={cn(LINK, 'inline-flex min-w-0 items-center gap-1.5 self-start text-sm')}>
          <RiLink size={16} aria-hidden className="shrink-0" />
          <span className="truncate">{shortLink(link)}</span>
        </ExternalLink>
      )}
      {card.media
        .filter((m) => m.src)
        .map((m) => (
          <MediaView key={m.key} media={m} />
        ))}
    </section>
  );
}

function Switch({ id, on, label, onChange }: { id: string; on: boolean; label: string; onChange: (on: boolean) => void }) {
  const name = `show ${label}`;
  return (
    <Tooltip content={name} at="left">
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={name}
        onClick={() => onChange(!on)}
        className="flex shrink-0 items-center p-0.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primaryBlue"
      >
        <span
          aria-hidden
          className={cn(
            'relative h-5 w-9 rounded-control border transition-colors duration-150',
            on ? 'border-primaryBlue bg-primaryBlue/15' : 'border-primaryStroke bg-background hover:border-secondaryStroke'
          )}
        >
          <span
            className={cn(
              'absolute left-px top-px h-4 w-4 rounded-control transition-transform duration-150 motion-reduce:transition-none',
              on ? 'translate-x-4 bg-primaryBlue' : 'bg-textTertiary'
            )}
          />
        </span>
      </button>
    </Tooltip>
  );
}

interface CardEditorProps {
  card: Card;
  onPatch: (part: Partial<Card>) => void;
  onAdd: (kind: MediaKind) => void;
  onReplace: (media: CardMedia) => void;
  onRemove: (media: CardMedia) => void;
}

function CardEditor({ card, onPatch, onAdd, onReplace, onRemove }: CardEditorProps) {
  const [linking, setLinking] = useState(false);
  const fallback = CARD_TITLES[card.key];
  const shownTitle = titleOf(card);
  const showLink = linking || card.link !== '';
  const badLink = card.link.trim() !== '' && cleanLink(card.link) === null;
  const empty = card.media.length === 0 && !showLink;
  const id = `about-card-${card.key}`;
  return (
    <section id={id} data-on={card.on || undefined} aria-label={shownTitle} className="rounded-card border border-primaryStroke bg-backgroundSecondary">
      <div className="flex min-h-12 items-center gap-3 py-2 pl-3 pr-2.5">
        {card.on ? (
          <input
            id={`${id}-title`}
            aria-label={`title of ${fallback}`}
            value={card.title}
            maxLength={TITLE_MAX}
            placeholder="title"
            onChange={(e) => onPatch({ title: e.target.value })}
            onBlur={() => {
              if (!card.title.trim()) onPatch({ title: fallback });
            }}
            className="-ml-1.5 min-w-0 flex-1 rounded-control border border-transparent bg-transparent px-1.5 py-0.5 text-sm font-semibold text-textPrimary outline-none placeholder:font-normal placeholder:text-textTertiary hover:border-primaryStroke focus:border-primaryBlue"
          />
        ) : (
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-textTertiary">{shownTitle}</span>
        )}
        <Switch id={`${id}-on`} on={card.on} label={shownTitle} onChange={(on) => onPatch({ on })} />
      </div>
      {card.on && (
        <div className="flex flex-col gap-3 px-3 pb-3">
          <textarea
            id={`${id}-body`}
            aria-label={shownTitle}
            value={card.body}
            maxLength={Math.max(BODY_MAX, card.body.length)}
            placeholder={PLACEHOLDER[card.key]}
            rows={Math.min(10, Math.max(card.key === 'when' ? 2 : 3, card.body.split('\n').length + 1))}
            onChange={(e) => onPatch({ body: e.target.value })}
            className={cn(INPUT, 'block resize-y py-1.5 leading-snug md:text-sm bubble:rounded-card')}
          />
          {card.media.map((m) => (
            <div key={m.key} className="flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-3">
              <div className={cn('min-w-0', m.kind === 'image' ? 'sm:max-w-[12rem]' : 'sm:flex-1')}>
                {m.kind === 'image' ? (
                  <img src={m.src} alt="" draggable={false} className="block h-auto max-h-40 max-w-full rounded-card border border-primaryStroke bg-black" />
                ) : (
                  <MediaView media={m} />
                )}
                {m.id <= 0 && <span className="mt-1 block text-xs text-textTertiary">uploading</span>}
              </div>
              <div className="flex shrink-0 gap-2 sm:flex-col">
                <Button id={`${id}-replace-${m.key}`} size="sm" className="gap-1.5" onClick={() => onReplace(m)}>
                  <RiRefreshLine size={16} aria-hidden />
                  replace
                </Button>
                <Button id={`${id}-remove-${m.key}`} size="sm" variant="outline-danger" className="gap-1.5" onClick={() => onRemove(m)}>
                  <RiDeleteBinLine size={16} aria-hidden />
                  remove
                </Button>
              </div>
            </div>
          ))}
          {showLink && (
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <label htmlFor={`${id}-link`} className="sr-only">
                  link for {shownTitle}
                </label>
                <input
                  id={`${id}-link`}
                  type="url"
                  inputMode="url"
                  value={card.link}
                  maxLength={LINK_MAX}
                  placeholder="link"
                  autoFocus={linking && card.link === ''}
                  aria-invalid={badLink || undefined}
                  aria-describedby={badLink ? `${id}-link-bad` : undefined}
                  onChange={(e) => onPatch({ link: e.target.value })}
                  className={cn(INPUT, 'min-w-0 flex-1 py-1.5 leading-snug md:text-sm')}
                />
                <Button
                  id={`${id}-link-remove`}
                  size="sm"
                  variant="outline-danger"
                  className="gap-1.5"
                  onClick={() => {
                    setLinking(false);
                    onPatch({ link: '' });
                  }}
                >
                  <RiDeleteBinLine size={16} aria-hidden />
                  remove
                </Button>
              </div>
              {badLink && (
                <p id={`${id}-link-bad`} className="text-xs text-decrease">
                  not a link. it needs to be an http or https address
                </p>
              )}
            </div>
          )}
          {empty && (
            <div className="flex flex-wrap items-center gap-1.5">
              <RiAddLine size={16} aria-hidden className="mr-0.5 text-textTertiary" />
              <span className="sr-only">add</span>
              {(['image', 'video', 'sound'] as const).map((kind) => (
                <Button key={kind} id={`${id}-add-${kind}`} size="sm" className="gap-1.5 px-2.5 font-medium text-textSecondary hover:text-textPrimary" onClick={() => onAdd(kind)}>
                  {MEDIA_ICON[kind]}
                  {MEDIA_WORD[kind]}
                </Button>
              ))}
              <Button id={`${id}-add-link`} size="sm" className="gap-1.5 px-2.5 font-medium text-textSecondary hover:text-textPrimary" onClick={() => setLinking(true)}>
                <RiLink size={16} aria-hidden />
                link
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

const TWO_COLUMNS = 640;

function useTwoColumns(el: HTMLElement | null): boolean {
  const [two, setTwo] = useState(false);
  useLayoutEffect(() => {
    if (!el) return;
    const measure = () => setTwo(el.getBoundingClientRect().width >= TWO_COLUMNS);
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, [el]);
  return two;
}

function Columns({ items, two, gap }: { items: ReactNode[]; two: boolean; gap: string }) {
  if (!two) return <div className={cn('flex flex-col', gap)}>{items}</div>;
  return (
    <div className={cn('grid grid-cols-2 items-start', gap)}>
      {[0, 1].map((col) => (
        <div key={col} className={cn('flex min-w-0 flex-col', gap)}>
          {items.filter((_, i) => i % 2 === col)}
        </div>
      ))}
    </div>
  );
}

interface Pending {
  card: CardKey;
  kind: MediaKind;
  replace?: string;
}

interface AboutProps {
  name: string;
  edit?: boolean;
  id?: string;
}

export function About({ name, edit = false, id }: AboutProps) {
  const box = id ?? `about-${name}`;
  const [cards, setCards] = useState<Card[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState('');
  const dirty = useRef(false);
  const uploads = useRef(0);
  const saving = useRef<Promise<void> | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const pending = useRef<Pending | null>(null);
  const cardsRef = useRef(cards);
  const [frame, setFrame] = useState<HTMLDivElement | null>(null);
  const two = useTwoColumns(frame);
  useEffect(() => {
    cardsRef.current = cards;
  }, [cards]);

  useEffect(() => {
    if (failed) return;
    let dead = false;
    api
      .aboutPage(name)
      .then((page) => {
        if (dead || dirty.current) return;
        setCards(blocksToCards(page.blocks));
        setLoaded(true);
      })
      .catch(() => {
        if (!dead) setFailed(true);
      });
    return () => {
      dead = true;
    };
  }, [name, failed]);

  const persist = (list: Card[]) => {
    if (uploads.current > 0 || saving.current) {
      dirty.current = true;
      setStatus('saving');
      return;
    }
    const blocks = cardsToBlocks(list);
    if (overLimit(blocks)) {
      dirty.current = true;
      setStatus(`not saved: ${BLOCKS_MAX} pieces at most. take something out`);
      return;
    }
    dirty.current = false;
    setStatus('saving');
    let ok = false;
    const flight = api
      .saveAboutPage(name, blocks)
      .then((saved) => {
        ok = true;
        setCards((current) => withSavedIds(current, saved.blocks));
        setStatus('saved');
      })
      .catch((err: unknown) => {
        dirty.current = true;
        setStatus(`not saved: ${err instanceof Error ? err.message : 'could not save'}`);
      })
      .finally(() => {
        if (saving.current === flight) saving.current = null;
        if (ok && dirty.current) persistRef.current(cardsRef.current);
      });
    saving.current = flight;
  };
  const persistRef = useRef(persist);
  useEffect(() => {
    persistRef.current = persist;
  });

  useEffect(() => {
    if (!edit || failed || !dirty.current) return;
    const list = cards;
    const handle = setTimeout(() => {
      if (dirty.current) persistRef.current(list);
    }, 700);
    return () => clearTimeout(handle);
  }, [cards, edit, failed]);

  const touch = (change: (cards: Card[]) => Card[]) => {
    dirty.current = true;
    setCards(change);
  };

  const patch = (key: CardKey, part: Partial<Card>) => touch((list) => list.map((c) => (c.key === key ? { ...c, ...part } : c)));

  const patchMedia = (key: CardKey, mediaKey: string, change: (m: CardMedia) => CardMedia | null) =>
    setCards((list) =>
      list.map((c) =>
        c.key === key
          ? {
              ...c,
              media: c.media.flatMap((m) => {
                if (m.key !== mediaKey) return [m];
                const next = change(m);
                return next ? [next] : [];
              })
            }
          : c
      )
    );

  const openFile = (want: Pending) => {
    pending.current = want;
    const input = fileRef.current;
    if (!input) return;
    input.accept = ACCEPT[want.kind];
    input.value = '';
    input.click();
  };

  const upload = async (key: CardKey, mediaKey: string, kind: MediaKind, file: Blob) => {
    uploads.current += 1;
    try {
      await saving.current;
      const saved = await api.saveAboutFile(name, kind, file);
      dirty.current = true;
      patchMedia(key, mediaKey, (m) => {
        revoke(m.src);
        return { ...m, id: saved.id, src: saved.src };
      });
    } catch (err: unknown) {
      patchMedia(key, mediaKey, (m) => {
        revoke(m.src);
        return null;
      });
      setStatus(`not saved: ${err instanceof Error ? err.message : 'could not upload'}`);
    } finally {
      uploads.current -= 1;
      if (uploads.current === 0 && dirty.current) setCards((list) => [...list]);
    }
  };

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const want = pending.current;
    pending.current = null;
    if (!file || !want) return;
    const src = URL.createObjectURL(file);
    const mediaKey = want.replace ?? uid();
    if (want.replace) {
      touch((list) =>
        list.map((c) =>
          c.key === want.card
            ? {
                ...c,
                media: c.media.map((m) => {
                  if (m.key !== want.replace) return m;
                  revoke(m.src);
                  return { ...m, kind: want.kind, id: 0, src };
                })
              }
            : c
        )
      );
    } else {
      touch((list) => list.map((c) => (c.key === want.card ? { ...c, link: '', media: [...c.media, { key: mediaKey, kind: want.kind, id: 0, src }] } : c)));
    }
    void upload(want.card, mediaKey, want.kind, file);
  };

  const removeMedia = (key: CardKey, media: CardMedia) => {
    revoke(media.src);
    touch((list) => list.map((c) => (c.key === key ? { ...c, media: c.media.filter((m) => m.key !== media.key) } : c)));
  };

  const finish = () => {
    setEditing(false);
    if (dirty.current) persistRef.current(cardsRef.current);
  };

  if (failed) {
    return (
      <p id={box} data-failed className="text-textSecondary">
        could not load the page.{' '}
        <button id="about-retry" type="button" className="text-primaryBlue hover:underline" onClick={() => setFailed(false)}>
          try again
        </button>
      </p>
    );
  }

  if (!loaded) return null;

  const fileInput = <input ref={fileRef} type="file" className="hidden" onChange={onFile} />;

  if (editing) {
    return (
      <div ref={setFrame} className="flex flex-col gap-3">
        <div className="flex min-h-8 items-center gap-3">
          <span className={LABEL}>your about</span>
          <span className="text-sm text-textTertiary max-md:hidden">· turn on what you want people to see</span>
          <span role="status" className="ml-auto min-w-0 truncate text-sm text-textTertiary">
            {status}
          </span>
          <Button id="about-done" size="sm" variant="primary" onClick={finish}>
            done
          </Button>
        </div>
        <section id={box} aria-label={`about ${name}`}>
          <Columns
            two={two}
            gap="gap-3"
            items={cards.map((card) => (
              <CardEditor
                key={card.key}
                card={card}
                onPatch={(part) => patch(card.key, part)}
                onAdd={(kind) => openFile({ card: card.key, kind })}
                onReplace={(m) => openFile({ card: card.key, kind: m.kind, replace: m.key })}
                onRemove={(m) => removeMedia(card.key, m)}
              />
            ))}
          />
        </section>
        {fileInput}
      </div>
    );
  }

  const shown = shownCards(cards);
  const editButton = edit && (
    <Button id="about-edit" size="sm" className="gap-1.5 self-start" onClick={() => setEditing(true)}>
      <RiPencilLine size={16} aria-hidden />
      edit
    </Button>
  );

  if (shown.length === 0) {
    if (!edit) {
      return (
        <p id={box} className="text-sm text-textSecondary">
          {name} hasn't made a page yet.
        </p>
      );
    }
    return (
      <div ref={setFrame} id={box} className="flex flex-col items-start gap-3">
        <p className="text-sm text-textSecondary">nothing on your about yet. turn on a card or two and fill them in.</p>
        {editButton}
        {status && <span className="text-sm text-textTertiary">{status}</span>}
      </div>
    );
  }

  return (
    <div ref={setFrame} className="flex flex-col gap-4">
      <section id={box} aria-label={`about ${name}`}>
        <Columns two={two} gap="gap-x-10 gap-y-6" items={shown.map((card) => <CardView key={card.key} card={card} />)} />
      </section>
      {edit && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          {editButton}
          {status && <span className="text-sm text-textTertiary">{status}</span>}
        </div>
      )}
    </div>
  );
}
