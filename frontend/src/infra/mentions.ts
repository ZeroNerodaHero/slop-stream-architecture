import type { Mention } from '@/infra/api';

export const MENTION_LIMIT = 6;
export const MENTION_CACHE = 20;

export interface MentionLine {
  from: string;
  verified: boolean;
  streamer?: boolean;
  avatar: number | null;
  oauth_verified?: boolean;
  groups?: readonly { name: string }[];
}

const starts = (name: string, query: string) => name.toLowerCase().startsWith(query);

export function localMentions(
  lines: readonly MentionLine[],
  query: string,
  { first = null, me = null, hide }: { first?: Mention | string | null; me?: string | null; hide?: string } = {}
): Mention[] {
  const seen = new Set<string>();
  const out: Mention[] = [];
  let lead: Mention | null = typeof first === 'string' ? { name: first, verified: true, avatar: null } : first;
  if (lead) seen.add(lead.name.toLowerCase());
  if (me) seen.add(me.toLowerCase());
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    const key = line.from.toLowerCase();
    if (lead && key === lead.name.toLowerCase() && lead.avatar === null && line.avatar !== null) {
      lead = { name: lead.name, verified: lead.verified || line.verified, oauth_verified: line.oauth_verified, avatar: line.avatar };
    }
    if (seen.has(key) || !(line.verified || line.streamer) || (hide !== undefined && line.groups?.some((g) => g.name === hide))) continue;
    seen.add(key);
    if (starts(line.from, query)) out.push({ name: line.from, verified: line.verified, oauth_verified: line.oauth_verified, avatar: line.avatar });
  }
  return lead && starts(lead.name, query) ? [lead, ...out] : out;
}

export function mergeMentions(local: readonly Mention[], server: readonly Mention[], limit = MENTION_LIMIT): Mention[] {
  const seen = new Set<string>();
  const out: Mention[] = [];
  for (const m of [...local, ...server]) {
    const key = m.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
    if (out.length >= limit) break;
  }
  return out;
}

export function cachedMentions(cache: Map<string, Mention[]>, query: string, limit = MENTION_LIMIT): Mention[] | undefined {
  const hit = cache.get(query);
  if (hit) {
    cache.delete(query);
    cache.set(query, hit);
    return hit;
  }
  for (let n = query.length - 1; n > 0; n--) {
    const shorter = cache.get(query.slice(0, n));
    if (shorter && shorter.length < limit) return shorter.filter((m) => starts(m.name, query));
  }
  return undefined;
}

export function nearMentions(cache: Map<string, Mention[]>, query: string): Mention[] {
  for (let n = query.length - 1; n > 0; n--) {
    const shorter = cache.get(query.slice(0, n));
    if (shorter) return shorter.filter((m) => starts(m.name, query));
  }
  return [];
}

export function cacheMentions(cache: Map<string, Mention[]>, query: string, found: Mention[], size = MENTION_CACHE): void {
  cache.delete(query);
  cache.set(query, found);
  for (const old of cache.keys()) {
    if (cache.size <= size) break;
    cache.delete(old);
  }
}

export function moveMention(at: number, key: 'ArrowUp' | 'ArrowDown', count: number): number {
  if (count <= 0) return 0;
  return key === 'ArrowUp' ? (at + 1) % count : (at - 1 + count) % count;
}

export function mentionRows(count: number): number[] {
  return Array.from({ length: count }, (_, i) => count - 1 - i);
}
