import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { type AboutBlock, type AboutDoc, type PageBlock, isSameOrigin, linkHref, mediaPath, safeCss } from '@/infra/about';
import { api } from '@/infra/api';
import { buttonClassName } from '@/shared-components/Button';
import { AboutCanvas } from '@/shared-components/AboutCanvas';
import { cn } from '@/utils/cn';

/** The longest a block's words get, whatever a document says. */
const HEADING_MAX = 80;
const TEXT_MAX = 2000;
const CAPTION_MAX = 200;
const LABEL_MAX = 80;
const GALLERY_MAX = 12;
const TRACKS_MAX = 20;
const LINKS_MAX = 20;

const SMALL = buttonClassName('secondary', 'px-2.5 py-1 text-sm', true);

function words(text: unknown, max: number): string {
  return typeof text === 'string' ? text.slice(0, max) : '';
}

function fmtClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

interface Track {
  title: string;
  src: string;
}

/**
 * A few tracks and the controls: one <audio>, the list, play and pause, previous and next, a
 * bar that seeks. The site's own widget, so a page cannot bring a player of its own; the css
 * over it reaches the classes (`about-music`, `about-music-track`, `about-music-bar`). Plays
 * only on a press, as the browser wants. Pauses with the tab: unmounted is silent.
 */
export function MusicPlayer({ title, tracks }: { title?: string; tracks: Track[] }) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [length, setLength] = useState(0);
  const [broken, setBroken] = useState(false);
  const track = tracks[index];

  // a new track: the element reloads its source. it keeps playing if it was
  useEffect(() => {
    const el = audio.current;
    if (!el) return;
    setTime(0);
    setLength(0);
    setBroken(false);
    el.load();
    if (playing) el.play().catch(() => setPlaying(false));
  }, [index]);

  const toggle = () => {
    const el = audio.current;
    if (!el) return;
    if (el.paused) el.play().catch(() => setPlaying(false));
    else el.pause();
  };
  const step = (by: number) => setIndex((i) => (i + by + tracks.length) % tracks.length);
  const seekTo = (fraction: number) => {
    const el = audio.current;
    if (!el || !length) return;
    el.currentTime = Math.min(length, Math.max(0, fraction * length));
  };
  const onBarKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const by = e.key === 'ArrowRight' ? 5 : e.key === 'ArrowLeft' ? -5 : 0;
    if (!by || !length) return;
    e.preventDefault();
    seekTo((time + by) / length);
  };

  if (!track) return null;
  return (
    <div className="about-music border border-primaryStroke bg-background p-3" data-playing={playing || undefined}>
      <audio
        ref={audio}
        src={track.src}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => (tracks.length > 1 ? step(1) : setPlaying(false))}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setLength(e.currentTarget.duration)}
        onError={() => setBroken(true)}
      />
      <div className="flex flex-wrap items-baseline gap-x-3">
        {title && <span className="about-music-title font-semibold">{title}</span>}
        <span className="about-music-now text-sm text-textSecondary">{broken ? 'cannot play this track' : track.title}</span>
        <span className="ml-auto text-sm tabular-nums text-textTertiary">
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
        onKeyDown={onBarKey}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          seekTo((e.clientX - r.left) / r.width);
        }}
        className="about-music-bar mt-2 h-2 cursor-pointer bg-backgroundTertiary focus:outline-none focus-visible:outline focus-visible:outline-1 focus-visible:outline-primaryBlue"
      >
        <div className="h-full bg-primaryBlue" style={{ width: `${length ? (time / length) * 100 : 0}%` }} />
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button type="button" className={SMALL} aria-label="previous track" disabled={tracks.length < 2} onClick={() => step(-1)}>
          ‹
        </button>
        <button type="button" className={cn(SMALL, 'about-music-play min-w-[4.5rem]')} onClick={toggle}>
          {playing ? 'pause' : 'play'}
        </button>
        <button type="button" className={SMALL} aria-label="next track" disabled={tracks.length < 2} onClick={() => step(1)}>
          ›
        </button>
      </div>
      {tracks.length > 1 && (
        <ol className="mt-2 text-sm">
          {tracks.map((t, i) => (
            <li key={`${t.src}-${i}`}>
              <button
                type="button"
                aria-current={i === index}
                onClick={() => setIndex(i)}
                className={cn('about-music-track py-0.5 text-left hover:text-textPrimary', i === index ? 'font-semibold text-textPrimary' : 'text-textSecondary')}
              >
                {i + 1}. {t.title}
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** One link of a `links` block: a router link on this origin, a new tab anywhere else, and never a scheme that is not http(s). */
function SafeLink({ label, href }: { label: string; href: string }) {
  const target = linkHref(href);
  if (!target) return null;
  const text = words(label, LABEL_MAX) || target;
  if (isSameOrigin(target)) {
    const url = new URL(target);
    return (
      <Link to={url.pathname + url.search + url.hash} className="text-textSecondary hover:text-textPrimary">
        {text}
      </Link>
    );
  }
  return (
    <a href={target} target="_blank" rel="noopener noreferrer nofollow" className="text-textSecondary hover:text-textPrimary">
      {text}
    </a>
  );
}

/** A block as react draws it. A block with nothing allowed in it draws nothing. */
function Block({ block }: { block: AboutBlock }) {
  switch (block.kind) {
    case 'heading': {
      const text = words(block.text, HEADING_MAX);
      return text ? <h3 className="about-heading text-xl font-semibold [overflow-wrap:anywhere]">{text}</h3> : null;
    }
    case 'text': {
      const text = words(block.text, TEXT_MAX);
      return text ? <p className="about-text whitespace-pre-wrap [overflow-wrap:anywhere]">{text}</p> : null;
    }
    case 'image': {
      const src = mediaPath(block.src);
      if (!src) return null;
      const caption = words(block.caption, CAPTION_MAX);
      return (
        <figure className="about-image">
          <img
            src={src}
            alt={words(block.alt, LABEL_MAX)}
            loading="lazy"
            decoding="async"
            draggable={false}
            className="max-h-[480px] w-full border border-primaryStroke bg-black object-cover"
          />
          {caption && <figcaption className="mt-1 text-sm text-textTertiary">{caption}</figcaption>}
        </figure>
      );
    }
    case 'gallery': {
      const images = (Array.isArray(block.images) ? block.images : [])
        .slice(0, GALLERY_MAX)
        .map((i) => ({ src: mediaPath(i.src), alt: words(i.alt, LABEL_MAX) }))
        .filter((i): i is { src: string; alt: string } => i.src !== null);
      if (images.length === 0) return null;
      return (
        <div className="about-gallery grid grid-cols-3 gap-2">
          {images.map((i, n) => (
            <img
              key={`${i.src}-${n}`}
              src={i.src}
              alt={i.alt}
              loading="lazy"
              decoding="async"
              draggable={false}
              className="aspect-video w-full border border-primaryStroke bg-black object-cover"
            />
          ))}
        </div>
      );
    }
    case 'video': {
      const src = mediaPath(block.src);
      if (!src) return null;
      const poster = mediaPath(block.poster) ?? undefined;
      const caption = words(block.caption, CAPTION_MAX);
      return (
        <figure className="about-video">
          <video src={src} poster={poster} controls preload="metadata" playsInline className="aspect-video w-full border border-primaryStroke bg-black" />
          {caption && <figcaption className="mt-1 text-sm text-textTertiary">{caption}</figcaption>}
        </figure>
      );
    }
    case 'music': {
      const tracks = (Array.isArray(block.tracks) ? block.tracks : [])
        .slice(0, TRACKS_MAX)
        .map((t) => ({ src: mediaPath(t.src), title: words(t.title, LABEL_MAX) || 'untitled' }))
        .filter((t): t is Track => t.src !== null);
      return tracks.length > 0 ? <MusicPlayer title={words(block.title, LABEL_MAX) || undefined} tracks={tracks} /> : null;
    }
    case 'links': {
      const links = (Array.isArray(block.links) ? block.links : []).slice(0, LINKS_MAX);
      if (links.length === 0) return null;
      return (
        <ul className="about-links flex flex-wrap gap-x-4 gap-y-1 text-base">
          {links.map((l, n) => (
            <li key={`${l.href}-${n}`}>
              <SafeLink label={l.label} href={l.href} />
            </li>
          ))}
        </ul>
      );
    }
    case 'divider':
      return <hr className="about-divider border-primaryStroke" />;
    default:
      return null;
  }
}

const BOX = 'about relative isolate mt-3 flex max-h-[1200px] flex-col gap-4 overflow-auto border border-primaryStroke bg-backgroundSecondary p-4 [contain:layout_paint_style]';

interface AboutProps {
  /** Whose page: the box's id is `about-<name>`, the scope every selector goes under. */
  name: string;
  doc: AboutDoc;
  /** My own page: the blocks are the canvas. Drag to place, drop a file to add. */
  edit?: boolean;
  /** The sample line under a page nobody has built. A fake stream's page is not a sample. */
  sample?: boolean;
}

/**
 * The page under the player (docs/about.md). A page nobody has saved is the sample. My own page,
 * and a page that has been saved, is the canvas: blocks of text, image, video and sound, placed
 * by x, y and z. The bytes of those live in the bucket.
 */
export function About({ name, doc, edit = false, sample = true }: AboutProps) {
  const scope = `about-${name}`;
  const [remote, setRemote] = useState<PageBlock[] | null>(null);
  useEffect(() => {
    if (edit || !sample) return;
    let dead = false;
    api
      .aboutPage(name)
      .then((page) => {
        if (!dead) setRemote(page.blocks);
      })
      .catch(() => {
        if (!dead) setRemote([]);
      });
    return () => {
      dead = true;
    };
  }, [edit, name, sample]);
  const safe = useMemo(() => safeCss(doc.css, scope), [doc.css, scope]);
  const saved = remote !== null && remote.length > 0;

  return (
    <div>
      {edit || saved ? (
        <AboutCanvas name={name} edit={edit} scope={scope} css="" boxClass={BOX} initial={edit ? null : remote} />
      ) : (
        <>
          {sample && (
            <p className="text-sm text-textTertiary">
              a sample of what this tab can hold: pictures, a clip, a few tracks, and links. nothing here is saved.
            </p>
          )}
          <section id={scope} className={BOX} aria-label={`about ${name}`}>
            {safe.css && <style>{safe.css}</style>}
            {doc.blocks.map((block, i) => (
              <Block key={i} block={block} />
            ))}
          </section>
        </>
      )}
    </div>
  );
}

