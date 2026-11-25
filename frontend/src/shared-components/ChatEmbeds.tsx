import { type RemixiconComponentType, RiFilmFill, RiPlayFill, RiTiktokFill, RiTwitchFill, RiVimeoFill, RiYoutubeFill } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { useMemo, useState } from 'react';

import { showEmbedsAtom } from '@/infra/atoms/settings-atoms';
import { ExternalLink, siteOf } from '@/shared-components/ExternalLink';
import { splitLinks, TALK_FROM } from '@/shared-components/LinkedText';
import { cn } from '@/utils/cn';

export type Provider = 'youtube' | 'vimeo' | 'twitch' | 'streamable' | 'dailymotion' | 'tiktok' | 'file';

export interface Embed {
  provider: Provider;
  href: string;
  player: string | null;
  poster?: string;
  tall: boolean;
}

export const MAX_EMBEDS = 2;

const YOUTUBE_ID = /^[\w-]{11}$/;
const TWITCH_PAGES = new Set([
  'directory',
  'downloads',
  'jobs',
  'p',
  'search',
  'settings',
  'subscriptions',
  'inventory',
  'wallet',
  'friends',
  'messages',
  'turbo',
  'prime',
  'store',
  'login',
  'signup',
  'videos',
  'drops'
]);

export function startOf(t: string | null): number {
  if (!t) return 0;
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(t);
  if (!m) return 0;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

function youtube(id: string | undefined, start: number, tall: boolean, href: string): Embed | null {
  if (!id || !YOUTUBE_ID.test(id)) return null;
  const player = `https://www.youtube-nocookie.com/embed/${id}?autoplay=1${start > 0 ? `&start=${start}` : ''}`;
  return { provider: 'youtube', href, player, poster: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, tall };
}

export function embedOf(href: string): Embed | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase().replace(/^(www|m)\./, '');
  const segs = url.pathname.split('/').filter(Boolean);
  const q = url.searchParams;

  if (host === 'youtu.be') return youtube(segs[0], startOf(q.get('t')), false, href);
  if (host === 'youtube.com' || host === 'music.youtube.com' || host === 'youtube-nocookie.com') {
    const start = startOf(q.get('t') ?? q.get('start'));
    if (segs[0] === 'watch') return youtube(q.get('v') ?? undefined, start, false, href);
    if (segs[0] === 'shorts') return youtube(segs[1], start, true, href);
    if (segs[0] === 'live' || segs[0] === 'embed') return youtube(segs[1], start, false, href);
    return null;
  }

  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const at = segs.findIndex((s) => /^\d+$/.test(s));
    if (at < 0) return null;
    const hash = q.get('h') ?? (/^[0-9a-f]{6,}$/i.test(segs[at + 1] ?? '') ? segs[at + 1] : null);
    return { provider: 'vimeo', href, player: `https://player.vimeo.com/video/${segs[at]}?autoplay=1&dnt=1${hash ? `&h=${hash}` : ''}`, tall: false };
  }

  if (host === 'twitch.tv' || host === 'clips.twitch.tv') {
    const parent = `parent=${encodeURIComponent(location.hostname)}`;
    const clip = host === 'clips.twitch.tv' ? segs[0] : segs[1] === 'clip' ? segs[2] : undefined;
    if (clip !== undefined) {
      if (!/^[\w-]+$/.test(clip) || clip === 'embed') return null;
      return { provider: 'twitch', href, player: `https://clips.twitch.tv/embed?clip=${clip}&${parent}&autoplay=true`, tall: false };
    }
    if (host !== 'twitch.tv') return null;
    if (segs[0] === 'videos' && /^\d+$/.test(segs[1] ?? '')) {
      return { provider: 'twitch', href, player: `https://player.twitch.tv/?video=v${segs[1]}&${parent}&autoplay=true`, tall: false };
    }
    const channel = segs[0]?.toLowerCase();
    if (segs.length !== 1 || !channel || !/^\w{3,25}$/.test(channel) || TWITCH_PAGES.has(channel)) return null;
    return { provider: 'twitch', href, player: `https://player.twitch.tv/?channel=${channel}&${parent}&autoplay=true`, tall: false };
  }

  if (host === 'streamable.com') {
    const id = segs[0] === 'e' || segs[0] === 'o' ? segs[1] : segs[0];
    if (!id || !/^[a-z0-9]{2,12}$/i.test(id) || segs.length > 2) return null;
    return { provider: 'streamable', href, player: `https://streamable.com/e/${id}?autoplay=1`, tall: false };
  }

  if (host === 'dailymotion.com' || host === 'dai.ly') {
    const raw = host === 'dai.ly' ? segs[0] : segs[0] === 'video' ? segs[1] : segs[0] === 'embed' && segs[1] === 'video' ? segs[2] : undefined;
    const id = raw?.split('_')[0];
    if (!id || !/^[a-z0-9]+$/i.test(id)) return null;
    return { provider: 'dailymotion', href, player: `https://www.dailymotion.com/embed/video/${id}?autoplay=1`, tall: false };
  }

  if (host === 'tiktok.com') {
    const at = segs.indexOf('video');
    const id = at >= 0 ? segs[at + 1] : undefined;
    if (!id || !/^\d+$/.test(id)) return null;
    return { provider: 'tiktok', href, player: `https://www.tiktok.com/embed/v2/${id}`, tall: true };
  }

  if (/\.(mp4|webm|mov)$/i.test(url.pathname)) return { provider: 'file', href, player: null, tall: false };
  return null;
}

export function embedsOf(text: string): Embed[] {
  const out: Embed[] = [];
  const seen = new Set<string>();
  for (const part of splitLinks(text)) {
    if (typeof part === 'string') continue;
    const embed = embedOf(part.href);
    const key = embed && (embed.player ?? embed.href);
    if (!embed || !key || seen.has(key)) continue;
    seen.add(key);
    out.push(embed);
    if (out.length === MAX_EMBEDS) break;
  }
  return out;
}

const LOOKS: Record<Provider, { name: string; bg: string; Icon: RemixiconComponentType }> = {
  youtube: { name: 'youtube', bg: 'bg-[#ff0033]', Icon: RiYoutubeFill },
  vimeo: { name: 'vimeo', bg: 'bg-[#1ab7ea]', Icon: RiVimeoFill },
  twitch: { name: 'twitch', bg: 'bg-[#9146ff]', Icon: RiTwitchFill },
  streamable: { name: 'streamable', bg: 'bg-[#0f90fa]', Icon: RiFilmFill },
  dailymotion: { name: 'dailymotion', bg: 'bg-[#0d0d0d]', Icon: RiFilmFill },
  tiktok: { name: 'tiktok', bg: 'bg-[#010101]', Icon: RiTiktokFill },
  file: { name: 'video', bg: 'bg-black', Icon: RiFilmFill }
};

export function ChatEmbeds({ text }: { text: string }) {
  const on = useAtomValue(showEmbedsAtom);
  const embeds = useMemo(() => (on && text ? embedsOf(text) : []), [on, text]);
  if (embeds.length === 0) return null;
  return (
    <span data-embeds="" className="mt-1 flex max-w-full flex-col gap-1">
      {embeds.map((embed) => (
        <EmbedCard key={embed.player ?? embed.href} embed={embed} />
      ))}
    </span>
  );
}

function EmbedCard({ embed }: { embed: Embed }) {
  const [playing, setPlaying] = useState(false);
  const { name, bg, Icon } = LOOKS[embed.provider];
  const site = siteOf(embed.href);
  return (
    <span
      data-embed={embed.provider}
      data-playing={playing || undefined}
      className={cn('flex max-w-full flex-col overflow-hidden rounded-card border border-primaryStroke bg-backgroundSecondary', embed.tall ? 'w-[12rem]' : 'w-[28rem]')}
    >
      <span className={cn('relative block w-full overflow-hidden bg-black', embed.tall ? 'aspect-[9/16]' : 'aspect-video')}>
        {embed.player === null ? (
          <video src={embed.href} controls preload="none" className="absolute inset-0 h-full w-full object-contain" />
        ) : playing ? (
          <iframe
            src={embed.player}
            title={`${name} player`}
            className="absolute inset-0 h-full w-full border-0"
            sandbox="allow-scripts allow-same-origin allow-presentation"
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
          />
        ) : (
          <button
            type="button"
            data-embed-play=""
            aria-label={`play the ${name} video`}
            title="play it here"
            onClick={() => setPlaying(true)}
            className={cn('group/embed absolute inset-0 flex h-full w-full items-center justify-center focus-visible:outline-none', !embed.poster && bg)}
          >
            {embed.poster ? (
              <img src={embed.poster} alt="" loading="lazy" referrerPolicy="no-referrer" className="absolute inset-0 h-full w-full object-cover" />
            ) : (
              <>
                <Icon aria-hidden size={embed.tall ? 24 : 32} className="absolute left-3 top-3 text-white" />
                <span className="absolute inset-x-3 bottom-2 truncate text-left text-xs text-white/80">{site + new URL(embed.href).pathname}</span>
              </>
            )}
            <span className="relative flex h-12 w-12 items-center justify-center rounded-control border border-white/30 bg-black/70 text-white transition-colors duration-150 group-hover/embed:bg-black/90 group-focus-visible/embed:border-primaryBlue">
              <RiPlayFill aria-hidden size={26} />
            </span>
          </button>
        )}
      </span>
      <span className="flex min-w-0 items-center gap-1.5 px-2 py-1 text-xs text-textTertiary">
        <Icon aria-hidden size={14} className="shrink-0" />
        <span className="shrink-0">{name}</span>
        <ExternalLink
          href={embed.href}
          from={TALK_FROM}
          title={site}
          data-site={site}
          className="ml-auto min-w-0 truncate text-primaryBlue underline-offset-2 hover:underline"
        >
          open on {site}
        </ExternalLink>
      </span>
    </span>
  );
}
