import { RiExternalLinkLine, RiImageLine, RiMusic2Line, RiVideoLine } from '@remixicon/react';
import { useQuery } from '@tanstack/react-query';
import { type CSSProperties, type ReactNode, useRef, useState } from 'react';

import { ACCENTS, type AboutBlock, type AboutPage, WEEKDAYS, compactCount, fileSrc, joinedWord, markdownToHtml, weekdaysOf } from '@/infra/about-blocks';
import { api } from '@/infra/api';
import { hostOf } from '@/infra/socials';
import { buttonClassName } from '@/shared-components/Button';
import { ExternalLink } from '@/shared-components/ExternalLink';
import { Face } from '@/shared-components/Face';
import { SOCIAL_ICON } from '@/shared-components/Socials';
import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

import { FROM, HtmlView } from './HtmlView';

export type PageMeta = Omit<AboutPage, 'blocks' | 'changed'>;

export const NEUTRAL = 'linear-gradient(90deg, #0d1530, #1b2a55 55%, #2d2140)';
const DAY = 24 * 60 * 60 * 1000;

export function accentBg(accent: string): string {
  if (!accent) return NEUTRAL;
  return `linear-gradient(90deg, color-mix(in srgb, ${accent} 45%, #0b0b10), ${accent})`;
}

const FONT: Record<AboutBlock['font'], string> = { geist: 'font-sans', mono: 'font-mono', serif: 'font-serif', display: 'font-sans' };
const ALIGN: Record<AboutBlock['align'], string> = { left: 'text-left', center: 'text-center', right: 'text-right' };
const JUSTIFY: Record<AboutBlock['align'], string> = { left: 'justify-start', center: 'justify-center', right: 'justify-end' };
const CARD = 'rounded-card border border-primaryStroke bg-backgroundSecondary';
const TITLE = 'text-sm font-bold text-textPrimary';

function shortLink(href: string): string {
  try {
    const url = new URL(href);
    return `${url.host.replace(/^www\./, '')}${url.pathname === '/' ? '' : url.pathname}`;
  } catch {
    return href;
  }
}

function fmtClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
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

function htmlOf(b: AboutBlock): string {
  return b.html ?? markdownToHtml(b.md);
}

function Missing({ icon, word }: { icon: ReactNode; word: string }) {
  return (
    <div className="flex min-h-20 items-center justify-center gap-2 rounded-card border border-dashed border-secondaryStroke text-sm text-textTertiary">
      {icon}
      {word}
    </div>
  );
}

function Title({ b, children, className }: { b: AboutBlock; children: ReactNode; className?: string }) {
  return <h3 className={cn(TITLE, b.font === 'display' && 'font-extrabold uppercase tracking-wide', className)}>{children}</h3>;
}

function MoreLink({ href, align }: { href: string; align: AboutBlock['align'] }) {
  if (!href) return null;
  return (
    <p className={cn('text-sm', ALIGN[align])}>
      <ExternalLink href={href} from={FROM} className="inline-flex items-center gap-1 text-primaryBlue underline-offset-2 hover:underline">
        {shortLink(href)}
        <RiExternalLinkLine size={12} aria-hidden />
      </ExternalLink>
    </p>
  );
}

function Shell({ b, name, children, pad = true }: { b: AboutBlock; name: string; children: ReactNode; pad?: boolean }) {
  const style: CSSProperties | undefined =
    b.fill === 'accent'
      ? { backgroundImage: accentBg(b.accent) }
      : b.fill === 'image' && b.bg > 0
        ? { backgroundImage: `linear-gradient(rgb(0 0 0 / 0.55), rgb(0 0 0 / 0.55)), url("${fileSrc(name, b.bg)}")` }
        : undefined;
  return (
    <div
      style={style}
      className={cn(
        'relative flex h-full min-w-0 flex-col gap-2',
        FONT[b.font],
        ALIGN[b.align],
        b.fill === 'card' && CARD,
        (b.fill === 'accent' || b.fill === 'image') && 'overflow-hidden rounded-card border border-transparent bg-cover bg-center text-white [&_*]:text-inherit',
        b.fill === 'image' && b.bg === 0 && 'border-primaryStroke bg-backgroundTertiary',
        pad && b.fill !== 'none' && 'p-3'
      )}
    >
      {children}
    </div>
  );
}

function Heading({ b, name, meta, phone }: { b: AboutBlock; name: string; meta: PageMeta; phone: boolean }) {
  const banner = b.fill === 'accent' || b.fill === 'image';
  const body = (
    <div className={cn('flex min-h-20 items-center gap-4', JUSTIFY[b.align], banner && 'px-3 py-5')}>
      <Face name={name} version={meta.avatar} className="size-14 shrink-0 rounded-avatar text-xl" />
      <div className={cn('min-w-0', ALIGN[b.align])}>
        <h2
          className={cn('truncate text-2xl leading-tight text-textPrimary', b.font === 'display' || b.font === 'geist' ? 'font-extrabold tracking-tight' : 'font-bold')}
        >
          {b.title || name}
        </h2>
        {b.sub && <p className="truncate text-sm text-textSecondary">{b.sub}</p>}
      </div>
    </div>
  );
  return (
    <Shell b={b} name={name} pad={!banner}>
      {banner && !phone && !b.accent && b.fill === 'accent' && <svg aria-hidden viewBox="0 0 40 40" className="absolute right-12 top-4 size-10">
          <circle cx="20" cy="20" r="20" fill="#f3e3a3" />
        </svg>}
      {b.href ? (
        <ExternalLink href={b.href} from={FROM} className="block">
          {body}
        </ExternalLink>
      ) : (
        body
      )}
    </Shell>
  );
}

function Panel({ b, name }: { b: AboutBlock; name: string }) {
  const header = b.fill === 'accent' || b.fill === 'image' || b.file > 0;
  const headStyle: CSSProperties =
    b.file > 0
      ? { backgroundImage: `linear-gradient(transparent 40%, rgb(0 0 0 / 0.6)), url("${fileSrc(name, b.file)}")` }
      : { backgroundImage: b.fill === 'image' && b.bg > 0 ? `url("${fileSrc(name, b.bg)}")` : accentBg(b.accent) };
  return (
    <div className={cn('flex h-full min-w-0 flex-col overflow-hidden', FONT[b.font], ALIGN[b.align], b.fill !== 'none' && CARD)}>
      {header ? (
        <div style={headStyle} className={cn('flex min-h-14 items-end bg-cover bg-center px-3 py-2.5', b.file > 0 && 'min-h-28')}>
          <h3 className={cn('w-full text-lg font-extrabold uppercase leading-tight tracking-wide text-white', ALIGN[b.align])}>{b.title}</h3>
        </div>
      ) : (
        b.title && (
          <Title b={b} className={cn(b.fill !== 'none' ? 'px-3 pt-3' : '')}>
            {b.title}
          </Title>
        )
      )}
      <div className={cn('flex flex-1 flex-col gap-2', b.fill !== 'none' ? 'p-3' : 'pt-2', !header && b.title && b.fill !== 'none' && 'pt-1.5')}>
        <HtmlView html={htmlOf(b)} />
        <MoreLink href={b.href} align={b.align} />
        {b.label && (
          <div className={cn('flex', JUSTIFY[b.align])}>
            {b.link ? (
              <ExternalLink href={b.link} from={FROM} className={buttonClassName('outline', 'gap-1.5 px-3 py-1 text-xs', 'sm')}>
                <RiExternalLinkLine size={12} aria-hidden />
                {b.label}
              </ExternalLink>
            ) : (
              <span className={buttonClassName('outline', 'gap-1.5 px-3 py-1 text-xs opacity-60', 'sm')}>{b.label}</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Picture({ b, name, edit }: { b: AboutBlock; name: string; edit: boolean }) {
  if (b.file === 0) return edit ? <Missing icon={<RiImageLine size={16} aria-hidden />} word="picture" /> : null;
  const img = (
    <img
      src={fileSrc(name, b.file)}
      alt={b.title}
      draggable={false}
      className="block h-auto max-h-[28rem] w-full rounded-card border border-primaryStroke bg-black object-cover"
    />
  );
  return (
    <Shell b={b} name={name}>
      {b.href ? (
        <ExternalLink href={b.href} from={FROM} className="block">
          {img}
        </ExternalLink>
      ) : (
        img
      )}
      {b.title && <p className="text-xs text-textTertiary">{b.title}</p>}
    </Shell>
  );
}

function Gallery({ b, name }: { b: AboutBlock; name: string }) {
  if (b.items.length === 0) return null;
  return (
    <Shell b={b} name={name}>
      <ul className="m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(8.5rem,1fr))] gap-2 p-0">
        {b.items.map((item, i) => {
          const tile = (
            <div
              style={{
                backgroundImage:
                  item.file > 0
                    ? `linear-gradient(transparent 50%, rgb(0 0 0 / 0.65)), url("${fileSrc(name, item.file)}")`
                    : accentBg(ACCENTS[(i % (ACCENTS.length - 1)) + 1] ?? '')
              }}
              className="flex h-[84px] items-end overflow-hidden rounded-card bg-cover bg-center px-2 py-1.5"
            >
              {item.label && <span className="truncate text-xs font-semibold text-white">{item.label}</span>}
            </div>
          );
          return (
            <li key={`${item.file}-${i}`} className="min-w-0">
              {item.href ? (
                <ExternalLink href={item.href} from={FROM} aria-label={item.label || shortLink(item.href)} className="block">
                  {tile}
                </ExternalLink>
              ) : (
                tile
              )}
            </li>
          );
        })}
      </ul>
    </Shell>
  );
}

function Buttons({ b, name }: { b: AboutBlock; name: string }) {
  const items = b.items.filter((i) => i.label);
  if (items.length === 0) return null;
  return (
    <Shell b={b} name={name}>
      <div className="flex flex-col gap-2">
        {items.map((item, i) => {
          const cls = buttonClassName(i === 0 ? 'primary' : 'secondary', 'w-full gap-1.5 py-2 text-xs', 'sm');
          return item.href ? (
            <ExternalLink key={`${item.label}-${i}`} href={item.href} from={FROM} className={cls}>
              <RiExternalLinkLine size={12} aria-hidden />
              <span className="truncate">{item.label}</span>
            </ExternalLink>
          ) : (
            <span key={`${item.label}-${i}`} className={cls}>
              <span className="truncate">{item.label}</span>
            </span>
          );
        })}
      </div>
    </Shell>
  );
}

function Chips({ name, meta, edit }: { name: string; meta: PageMeta; edit: boolean }) {
  if (meta.socials.links.length === 0) return edit ? <p className="text-xs text-textTertiary">add links on the socials tab</p> : null;
  return (
    <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
      {meta.socials.links.map((link, i) => {
        const Icon = SOCIAL_ICON[link.kind];
        const word = link.label || link.kind;
        const host = hostOf(link.url);
        return (
          <li key={`${link.url}-${i}`}>
            <Tooltip content={`${word} · ${host}`}>
              <ExternalLink
                href={link.url}
                from={`${name} put this link here, not this site.`}
                aria-label={`${word}, ${host}`}
                className="flex size-7 items-center justify-center rounded-control border border-primaryStroke bg-background text-textSecondary transition-colors hover:border-primaryBlue hover:text-textPrimary"
              >
                <Icon size={14} aria-hidden />
              </ExternalLink>
            </Tooltip>
          </li>
        );
      })}
    </ul>
  );
}

function SocialsBlock({ b, name, meta, edit }: { b: AboutBlock; name: string; meta: PageMeta; edit: boolean }) {
  if (meta.socials.links.length === 0 && !edit) return null;
  return (
    <Shell b={b} name={name}>
      {b.title && <Title b={b}>{b.title}</Title>}
      <div className={cn('flex', JUSTIFY[b.align])}>
        <Chips name={name} meta={meta} edit={edit} />
      </div>
    </Shell>
  );
}

function useWeekdays(name: string): boolean[] {
  const { data } = useQuery({
    queryKey: ['about-weekdays', name],
    queryFn: async () => {
      const to = new Date();
      const rows = await api.sessions(name, new Date(to.getTime() - 28 * DAY), to);
      return weekdaysOf(rows.map((r) => r.started_at));
    },
    staleTime: 10 * 60 * 1000
  });
  return data ?? WEEKDAYS.map(() => false);
}

function Schedule({ b, name }: { b: AboutBlock; name: string }) {
  const on = useWeekdays(name);
  return (
    <Shell b={b} name={name}>
      {b.title && <Title b={b}>{b.title}</Title>}
      <ul aria-label="days streamed in the last 4 weeks" className="m-0 grid list-none grid-cols-7 gap-1 p-0">
        {WEEKDAYS.map((day, i) => (
          <li
            key={day}
            aria-label={`${day}${on[i] ? ', streamed' : ''}`}
            className={cn(
              'rounded-control border py-0.5 text-center text-[11px] font-semibold',
              on[i] ? 'border-primaryBlue/50 bg-primaryBlue/15 text-textPrimary' : 'border-primaryStroke text-textTertiary'
            )}
          >
            {day}
          </li>
        ))}
      </ul>
      <HtmlView html={htmlOf(b)} />
    </Shell>
  );
}

function Clip({ b, name, edit }: { b: AboutBlock; name: string; edit: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [on, setOn] = useState(false);
  const [length, setLength] = useState(0);
  if (b.file === 0) return edit ? <Missing icon={<RiVideoLine size={16} aria-hidden />} word="clip" /> : null;
  return (
    <Shell b={b} name={name}>
      {b.title && <Title b={b}>{b.title}</Title>}
      <div className="relative aspect-video w-full overflow-hidden rounded-card border border-primaryStroke bg-black">
        <video
          ref={ref}
          src={fileSrc(name, b.file)}
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
    </Shell>
  );
}

function Sound({ b, name, edit }: { b: AboutBlock; name: string; edit: boolean }) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [length, setLength] = useState(0);
  const [broken, setBroken] = useState(false);
  if (b.file === 0) return edit ? <Missing icon={<RiMusic2Line size={16} aria-hidden />} word="sound" /> : null;
  const seekTo = (fraction: number) => {
    const el = audio.current;
    if (!el || !length) return;
    el.currentTime = Math.min(length, Math.max(0, fraction * length));
  };
  return (
    <Shell b={b} name={name}>
      {b.title && <Title b={b}>{b.title}</Title>}
      <audio
        ref={audio}
        src={fileSrc(name, b.file)}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setLength(e.currentTarget.duration)}
        onError={() => setBroken(true)}
      />
      <div className="flex items-center gap-2">
        <Tooltip content={broken ? 'cannot play this sound' : playing ? 'pause' : 'play'}>
          <button
            type="button"
            aria-label={playing ? 'pause' : 'play'}
            disabled={broken}
            onClick={() => {
              const el = audio.current;
              if (!el) return;
              if (el.paused) el.play().catch(() => setPlaying(false));
              else el.pause();
            }}
            className="flex size-6 shrink-0 items-center justify-center rounded-control border border-primaryStroke bg-background text-primaryBlue hover:border-primaryBlue disabled:opacity-40"
          >
            <PlayGlyph size={10} playing={playing} />
          </button>
        </Tooltip>
        <div
          role="slider"
          aria-label="position in the sound"
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
          className="h-5 flex-1 cursor-pointer overflow-hidden rounded-control bg-backgroundTertiary focus:outline-none focus-visible:outline focus-visible:outline-1 focus-visible:outline-primaryBlue"
        >
          <div className="h-full bg-primaryBlue/40" style={{ width: `${length ? (time / length) * 100 : 0}%` }} />
        </div>
        <span className="shrink-0 text-xs tabular-nums text-textTertiary">{fmtClock(length ? length - time : 0)}</span>
      </div>
    </Shell>
  );
}

function Stats({ b, name, meta, edit }: { b: AboutBlock; name: string; meta: PageMeta; edit: boolean }) {
  const figures: [string, string][] = [
    [compactCount(meta.followers), 'followers'],
    [compactCount(meta.streams), 'streams']
  ];
  const joined = joinedWord(meta.joined);
  if (joined) figures.push([joined, 'joined']);
  return (
    <Shell b={b} name={name}>
      <dl className={cn('flex flex-wrap gap-x-6 gap-y-2', JUSTIFY[b.align])}>
        {figures.map(([value, word]) => (
          <div key={word} className="flex flex-col">
            <dt className="order-2 text-[10px] font-semibold uppercase tracking-wider text-textTertiary">{word}</dt>
            <dd className="order-1 text-base font-extrabold tabular-nums text-textPrimary">{value}</dd>
          </div>
        ))}
      </dl>
      {b.socials && (
        <div className={cn('mt-auto flex pt-1', JUSTIFY[b.align])}>
          <Chips name={name} meta={meta} edit={edit} />
        </div>
      )}
    </Shell>
  );
}

function Quote({ b, name }: { b: AboutBlock; name: string }) {
  const html = htmlOf(b);
  if (!html) return null;
  return (
    <Shell b={b} name={name}>
      <figure className="flex flex-col gap-1.5">
        <blockquote className="border-l-2 border-primaryBlue pl-3">
          <HtmlView html={html} className="text-base italic text-textPrimary" />
        </blockquote>
        {b.sub && <figcaption className="pl-3 text-xs text-textTertiary">— {b.sub}</figcaption>}
      </figure>
    </Shell>
  );
}

function Divider({ b }: { b: AboutBlock }) {
  return (
    <div role="separator" className="flex items-center gap-3 py-1">
      <span className="h-px flex-1 bg-primaryStroke" />
      {b.title && <span className="text-[11px] font-semibold uppercase tracking-wider text-textTertiary">{b.title}</span>}
      <span className="h-px flex-1 bg-primaryStroke" />
    </div>
  );
}

function TextBlock({ b, name, edit }: { b: AboutBlock; name: string; edit: boolean }) {
  const html = htmlOf(b);
  if (!html && !edit) return null;
  return (
    <Shell b={b} name={name}>
      {html ? <HtmlView html={html} className="[&_h3]:text-sm" /> : <p className="text-sm text-textTertiary">write something in the settings</p>}
      <MoreLink href={b.href} align={b.align} />
    </Shell>
  );
}

export function BlockView({ b, name, meta, edit = false, phone = false }: { b: AboutBlock; name: string; meta: PageMeta; edit?: boolean; phone?: boolean }) {
  switch (b.kind) {
    case 'heading':
      return <Heading b={b} name={name} meta={meta} phone={phone} />;
    case 'text':
      return <TextBlock b={b} name={name} edit={edit} />;
    case 'panel':
      return <Panel b={b} name={name} />;
    case 'image':
      return <Picture b={b} name={name} edit={edit} />;
    case 'gallery':
      return b.items.length === 0 && edit ? <Missing icon={<RiImageLine size={16} aria-hidden />} word="gallery" /> : <Gallery b={b} name={name} />;
    case 'buttons':
      return <Buttons b={b} name={name} />;
    case 'socials':
      return <SocialsBlock b={b} name={name} meta={meta} edit={edit} />;
    case 'schedule':
      return <Schedule b={b} name={name} />;
    case 'clip':
      return <Clip b={b} name={name} edit={edit} />;
    case 'sound':
      return <Sound b={b} name={name} edit={edit} />;
    case 'stats':
      return <Stats b={b} name={name} meta={meta} edit={edit} />;
    case 'quote':
      return <Quote b={b} name={name} />;
    case 'divider':
      return <Divider b={b} />;
  }
}
