export type ChatPlatform = 'twitch' | 'kick';
export type ChatPick = 'slop' | ChatPlatform;

export interface SourcePart {
  text?: string;
  emote?: string;
  url?: string;
}

export interface ChatSourceLine {
  platform: ChatPlatform;
  id: string;
  user: string;
  color: string | null;
  badges: string[];
  parts: SourcePart[];
}

export const CHAT_PLATFORMS: readonly ChatPlatform[] = ['twitch', 'kick'];

const EMOTE_HOSTS = ['https://static-cdn.jtvnw.net/emoticons/', 'https://files.kick.com/emotes/'];

export const BADGE_WORDS: Record<string, string> = {
  broadcaster: 'broadcaster',
  moderator: 'mod',
  vip: 'vip',
  subscriber: 'sub',
  founder: 'founder',
  staff: 'staff',
  verified: 'verified',
  og: 'og'
};

export function isChatPlatform(raw: unknown): raw is ChatPlatform {
  return raw === 'twitch' || raw === 'kick';
}

export function emoteUrlOk(url: unknown): url is string {
  return typeof url === 'string' && EMOTE_HOSTS.some((host) => url.startsWith(host)) && !/[\s"'<>]/.test(url);
}

function partOf(raw: unknown): SourcePart | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as { text?: unknown; emote?: unknown; url?: unknown };
  if (typeof p.emote === 'string' && p.emote && emoteUrlOk(p.url)) return { emote: p.emote, url: p.url };
  if (typeof p.text === 'string') return { text: p.text };
  return null;
}

export function sourceOf(raw: unknown): ChatSourceLine | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const s = raw as { platform?: unknown; id?: unknown; user?: unknown; color?: unknown; badges?: unknown; parts?: unknown };
  if (!isChatPlatform(s.platform) || typeof s.id !== 'string' || typeof s.user !== 'string') return undefined;
  const color = typeof s.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(s.color) ? s.color : null;
  const badges = Array.isArray(s.badges) ? s.badges.filter((b): b is string => typeof b === 'string' && b in BADGE_WORDS) : [];
  const parts = Array.isArray(s.parts) ? s.parts.map(partOf).filter((p): p is SourcePart => p !== null) : [];
  return { platform: s.platform, id: s.id, user: s.user, color, badges, parts: parts.some((p) => p.emote) ? parts : [] };
}

export function platformsOf(raw: unknown): ChatPlatform[] {
  if (!Array.isArray(raw)) return [];
  return CHAT_PLATFORMS.filter((p) => raw.includes(p));
}

export function pickOf(stored: unknown, sources: readonly ChatPlatform[]): ChatPick {
  return isChatPlatform(stored) && sources.includes(stored) ? stored : 'slop';
}

export function bySource<T extends { source?: ChatSourceLine }>(lines: readonly T[], pick: ChatPick, sources: readonly ChatPlatform[]): readonly T[] {
  if (sources.length === 0) return lines;
  const want = pickOf(pick, sources);
  const kept = lines.filter((line) => (want === 'slop' ? !line.source : line.source?.platform === want));
  return kept.length === lines.length ? lines : kept;
}

export const PLATFORM_WORDS: Record<ChatPick, string> = {
  slop: 'this site',
  twitch: 'twitch',
  kick: 'kick'
};
