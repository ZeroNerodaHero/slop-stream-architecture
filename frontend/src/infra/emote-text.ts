export interface Emote {
  id: string;
  name: string;
  group: string;
}

export interface GroupEmote {
  id: string;
  name: string;
  by: string | null;
  at: number;
}

export const EMOTE_NAME = /^[a-z0-9_]{2,32}$/;
export const EMOTE_NAME_RULE = '2 to 32 of a-z 0-9 _';
export const MAX_EMOTES = 50;
export const MAX_ONLY_EMOTES = 27;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /<:([a-z0-9_]{2,32}):([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})>/g;

export function isEmoteId(s: string): boolean {
  return s.length === 36 && UUID.test(s);
}

export function emoteSrc(id: string): string {
  return `/api/emotes/${encodeURIComponent(id.toLowerCase())}`;
}

export type EmotePart = string | { name: string; id: string };

export function splitEmotes(text: string): EmotePart[] {
  const parts: EmotePart[] = [];
  let at = 0;
  for (const m of text.matchAll(TOKEN)) {
    if (m.index > at) parts.push(text.slice(at, m.index));
    parts.push({ name: m[1] ?? '', id: (m[2] ?? '').toLowerCase() });
    at = m.index + m[0].length;
  }
  if (at < text.length) parts.push(text.slice(at));
  return parts;
}

export function emoteIds(text: string): string[] {
  return splitEmotes(text).flatMap((p) => (typeof p === 'string' ? [] : [p.id]));
}

export function plainEmotesBy(text: string, nameOf: (id: string) => string | undefined): string {
  if (!text.includes('<:')) return text;
  return splitEmotes(text)
    .map((p) => (typeof p === 'string' ? p : `:${nameOf(p.id) ?? p.name}:`))
    .join('');
}

export function tokensAsTyped(text: string): string {
  return text.includes('<:') ? text.replace(TOKEN, (_whole: string, name: string) => `:${name}:`) : text;
}

export function onlyEmotesBy(parts: readonly EmotePart[], gone: (id: string) => boolean): boolean {
  let n = 0;
  for (const p of parts) {
    if (typeof p === 'string') {
      if (p.trim()) return false;
    } else {
      if (gone(p.id)) return false;
      n += 1;
    }
  }
  return n > 0 && n <= MAX_ONLY_EMOTES;
}

export function encodeEmotesBy(text: string, mine: readonly Emote[], picked: ReadonlyMap<string, string>): string {
  if (mine.length === 0 || !text.includes(':')) return text;
  const byName = new Map<string, string>();
  for (const e of mine) if (!byName.has(e.name)) byName.set(e.name, e.id);
  for (const [name, id] of picked) if (mine.some((e) => e.id === id)) byName.set(name, id);
  return text.replace(/(<?):([a-z0-9_]{2,32}):/g, (whole: string, lt: string, name: string) => {
    if (lt) return whole;
    const id = byName.get(name);
    return id ? `<:${name}:${id}>` : whole;
  });
}

export function emoteQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const m = /(^|[^a-z0-9_:<]):([a-z0-9_]{2,32})$/i.exec(before);
  if (!m) return null;
  const query = m[2] ?? '';
  return { start: caret - query.length - 1, query: query.toLowerCase() };
}

export function matchEmotes(mine: readonly Emote[], query: string, limit = 8): Emote[] {
  const starts = mine.filter((e) => e.name.startsWith(query));
  const holds = mine.filter((e) => !e.name.startsWith(query) && e.name.includes(query));
  return [...starts, ...holds].slice(0, limit);
}
