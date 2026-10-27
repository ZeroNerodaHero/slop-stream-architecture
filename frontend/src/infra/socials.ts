/**
 * Where else to find them (docs/socials.md): the links under the player, as one document the
 * owner replaces whole, like the bio. How the links sit (`row` or `grid`), how big, and the
 * links themselves: a kind from a fixed list (the icon the page draws), an http(s) url, and
 * words of theirs if they gave any. The api checks every field at the door; the page checks
 * again before it draws, whoever wrote the row (about.md's rule), and reads a kind it does not
 * know as `web`, so a link saved through a newer api still shows. Pure: no atoms, no dom.
 */

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

/** One link: where, the url, and the words on it ('' for the kind's own word). */
export interface SocialLink {
  kind: SocialKind;
  url: string;
  label: string;
}

/** The document the row keeps and the page draws. */
export interface Socials {
  layout: SocialsLayout;
  size: SocialsSize;
  links: SocialLink[];
}

/** The api's caps: the editor stops where the api would refuse. */
export const MAX_SOCIALS = 20;
export const MAX_SOCIAL_URL_CHARS = 500;
export const MAX_SOCIAL_LABEL_CHARS = 40;

export const EMPTY_SOCIALS: Socials = { layout: 'row', size: 'medium', links: [] };

/** An example for each kind: the url box's placeholder once a kind is picked. */
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

/** The hosts each kind is usually at: a `web` row whose url lands on one of these takes the kind. A hint, never a check: the owner's pick stands. */
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

/** The host of a link, without a `www.`, for the words beside the icon. '' when it is not a url. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** The kind a url's host says, or null for a host nobody on the list has. */
export function kindOfUrl(url: string): SocialKind | null {
  const host = hostOf(url);
  if (!host) return null;
  for (const [kind, hosts] of SOCIAL_HOSTS) {
    if (hosts.some((h) => host === h || host.endsWith(`.${h}`))) return kind;
  }
  return null;
}

/**
 * A link as typed, as the api takes it, or null: trimmed, `https://` put in front of a bare
 * `twitch.tv/you`, then about.md's rule (http or https, nothing else, through the browser's
 * own parser), absolute, and under the api's cap. The api does the same again, and writes
 * the url back the parser's way.
 */
export function socialHref(typed: string): string | null {
  const raw = typed.trim();
  if (!raw || [...raw].length > MAX_SOCIAL_URL_CHARS) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  if (!/^https?:\/\//i.test(withScheme)) return null;
  const href = linkHref(withScheme);
  if (!href || [...href].length > MAX_SOCIAL_URL_CHARS) return null;
  return href;
}

/**
 * The document as the page draws it, whatever the api sent (an older or a newer one, a row
 * somebody wrote by hand): a layout or size off the list is the default, a kind off the list
 * is `web`, a link that is not http(s) is left out, the list cut at the cap, a label a string
 * cut at its cap. Never throws.
 */
export function cleanSocials(raw: unknown): Socials {
  if (!raw || typeof raw !== 'object') return EMPTY_SOCIALS;
  const r = raw as Record<string, unknown>;
  const layout = (SOCIALS_LAYOUTS as readonly unknown[]).includes(r.layout) ? (r.layout as SocialsLayout) : 'row';
  const size = (SOCIALS_SIZES as readonly unknown[]).includes(r.size) ? (r.size as SocialsSize) : 'medium';
  const links: SocialLink[] = [];
  for (const item of Array.isArray(r.links) ? r.links.slice(0, MAX_SOCIALS) : []) {
    if (!item || typeof item !== 'object') continue;
    const l = item as Record<string, unknown>;
    // absolute http(s) only: a path would read as this origin's, which the api never keeps either
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

/** The document as one string, field order fixed: two documents that say the same thing make the same key. */
export function socialsKey(doc: Socials): string {
  return JSON.stringify({ layout: doc.layout, size: doc.size, links: doc.links.map((l) => ({ kind: l.kind, url: l.url, label: l.label })) });
}
