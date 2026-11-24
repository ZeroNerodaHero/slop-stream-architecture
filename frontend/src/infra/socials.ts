import { linkHref } from '@/infra/about';

export const SOCIAL_KINDS = [
  'tiktok',
  'youtube',
  'twitch',
  'kick',
  'discord',
  'instagram',
  'x',
  'threads',
  'bluesky',
  'facebook',
  'snapchat',
  'reddit',
  'github',
  'spotify',
  'soundcloud',
  'patreon',
  'telegram',
  'steam',
  'web'
] as const;
export type SocialKind = (typeof SOCIAL_KINDS)[number];
export const SOCIALS_LAYOUTS = ['row', 'grid'] as const;
export type SocialsLayout = (typeof SOCIALS_LAYOUTS)[number];
export const SOCIALS_SIZES = ['small', 'medium', 'large'] as const;
export type SocialsSize = (typeof SOCIALS_SIZES)[number];

export interface SocialLink {
  kind: SocialKind;
  url: string;
  label: string;
}

export interface Socials {
  layout: SocialsLayout;
  size: SocialsSize;
  links: SocialLink[];
}

export const MAX_SOCIALS = 20;
export const MAX_SOCIAL_URL_CHARS = 500;
export const MAX_SOCIAL_LABEL_CHARS = 40;

export const EMPTY_SOCIALS: Socials = { layout: 'row', size: 'medium', links: [] };

export const SOCIAL_EXAMPLE: Record<SocialKind, string> = {
  tiktok: 'https://tiktok.com/@you',
  youtube: 'https://youtube.com/@you',
  twitch: 'https://twitch.tv/you',
  kick: 'https://kick.com/you',
  discord: 'https://discord.gg/yourserver',
  instagram: 'https://instagram.com/you',
  x: 'https://x.com/you',
  threads: 'https://threads.net/@you',
  bluesky: 'https://bsky.app/profile/you.bsky.social',
  facebook: 'https://facebook.com/you',
  snapchat: 'https://snapchat.com/add/you',
  reddit: 'https://reddit.com/u/you',
  github: 'https://github.com/you',
  spotify: 'https://open.spotify.com/artist/…',
  soundcloud: 'https://soundcloud.com/you',
  patreon: 'https://patreon.com/you',
  telegram: 'https://t.me/you',
  steam: 'https://steamcommunity.com/id/you',
  web: 'https://your.site'
};

const SOCIAL_HOSTS: [SocialKind, string[]][] = [
  ['tiktok', ['tiktok.com']],
  ['youtube', ['youtube.com', 'youtu.be']],
  ['twitch', ['twitch.tv']],
  ['kick', ['kick.com']],
  ['discord', ['discord.gg', 'discord.com']],
  ['instagram', ['instagram.com']],
  ['x', ['x.com', 'twitter.com']],
  ['threads', ['threads.net', 'threads.com']],
  ['bluesky', ['bsky.app']],
  ['facebook', ['facebook.com', 'fb.com']],
  ['snapchat', ['snapchat.com']],
  ['reddit', ['reddit.com']],
  ['github', ['github.com']],
  ['spotify', ['spotify.com']],
  ['soundcloud', ['soundcloud.com']],
  ['patreon', ['patreon.com']],
  ['telegram', ['t.me', 'telegram.me']],
  ['steam', ['steamcommunity.com', 'steampowered.com']]
];

export function isSocialKind(x: unknown): x is SocialKind {
  return typeof x === 'string' && (SOCIAL_KINDS as readonly string[]).includes(x);
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function kindOfUrl(url: string): SocialKind | null {
  const host = hostOf(url);
  if (!host) return null;
  for (const [kind, hosts] of SOCIAL_HOSTS) {
    if (hosts.some((h) => host === h || host.endsWith(`.${h}`))) return kind;
  }
  return null;
}

export function socialHref(typed: string): string | null {
  const raw = typed.trim();
  if (!raw || [...raw].length > MAX_SOCIAL_URL_CHARS) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  if (!/^https?:\/\//i.test(withScheme)) return null;
  const href = linkHref(withScheme);
  if (!href || [...href].length > MAX_SOCIAL_URL_CHARS) return null;
  return href;
}

export function cleanSocials(raw: unknown): Socials {
  if (!raw || typeof raw !== 'object') return EMPTY_SOCIALS;
  const r = raw as Record<string, unknown>;
  const layout = (SOCIALS_LAYOUTS as readonly unknown[]).includes(r.layout) ? (r.layout as SocialsLayout) : 'row';
  const size = (SOCIALS_SIZES as readonly unknown[]).includes(r.size) ? (r.size as SocialsSize) : 'medium';
  const links: SocialLink[] = [];
  for (const item of Array.isArray(r.links) ? r.links.slice(0, MAX_SOCIALS) : []) {
    if (!item || typeof item !== 'object') continue;
    const l = item as Record<string, unknown>;
    const url = typeof l.url === 'string' && /^https?:\/\//i.test(l.url) ? linkHref(l.url) : null;
    if (!url) continue;
    links.push({
      kind: isSocialKind(l.kind) ? l.kind : 'web',
      url,
      label: typeof l.label === 'string' ? [...l.label.trim()].slice(0, MAX_SOCIAL_LABEL_CHARS).join('') : ''
    });
  }
  return { layout, size, links };
}

export function socialsKey(doc: Socials): string {
  return JSON.stringify({ layout: doc.layout, size: doc.size, links: doc.links.map((l) => ({ kind: l.kind, url: l.url, label: l.label })) });
}
