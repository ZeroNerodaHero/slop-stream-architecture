export const EMOJIS = [
  '👍',
  '❤️',
  '😂',
  '😮',
  '😢',
  '🔥',
  '🎉',
  '👏',
  '👎',
  '😡',
  '🙏',
  '💯',
  '👀',
  '🤔',
  '😍',
  '😎',
  '🤣',
  '😭',
  '😅',
  '🙌',
  '💀',
  '🤯',
  '🥳',
  '🤝',
  '✅',
  '❌',
  '⭐',
  '🚀',
  '💜',
  '👋',
  '😆',
  '🫶'
];

export const EMOJI_NAMES: Record<string, string> = {
  '👍': 'thumbs up',
  '❤️': 'heart',
  '😂': 'joy',
  '😮': 'wow',
  '😢': 'sad',
  '🔥': 'fire',
  '🎉': 'party',
  '👏': 'clap',
  '👎': 'thumbs down',
  '😡': 'angry',
  '🙏': 'please',
  '💯': 'hundred',
  '👀': 'eyes',
  '🤔': 'thinking',
  '😍': 'heart eyes',
  '😎': 'cool',
  '🤣': 'rolling on the floor',
  '😭': 'sobbing',
  '😅': 'sweat smile',
  '🙌': 'raised hands',
  '💀': 'skull',
  '🤯': 'mind blown',
  '🥳': 'party face',
  '🤝': 'handshake',
  '✅': 'check',
  '❌': 'cross',
  '⭐': 'star',
  '🚀': 'rocket',
  '💜': 'purple heart',
  '👋': 'wave',
  '😆': 'laughing',
  '🫶': 'heart hands'
};

export const QUICK = 6;

export const MAX_KINDS = 20;

export interface Reaction {
  emoji: string;
  count: number;
  who: string[];
  me?: boolean;
}

export function reactionsOf(raw: unknown): Reaction[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((r): Reaction[] => {
    if (!r || typeof r !== 'object') return [];
    const { emoji, count, who, me } = r as Record<string, unknown>;
    if (typeof emoji !== 'string' || typeof count !== 'number' || count < 1) return [];
    const names = Array.isArray(who) ? who.filter((n): n is string => typeof n === 'string') : [];
    return [me === true ? { emoji, count, who: names, me: true } : { emoji, count, who: names }];
  });
}

export function applyReaction(list: readonly Reaction[] | undefined, emoji: string, who: string, on: boolean, me?: string | null): Reaction[] {
  const now = list ?? [];
  const at = now.findIndex((r) => r.emoji === emoji);
  const there = at >= 0 ? now[at] : undefined;
  const self = !!me && who === me;
  const had = there ? there.who.includes(who) || (self && there.me === true) : false;
  if (on) {
    if (had) return now.slice();
    const mine = self ? { me: true } : {};
    if (!there) return [...now, { emoji, count: 1, who: [who], ...mine }];
    return now.map((r, i) => (i === at ? { ...r, count: r.count + 1, who: [...r.who, who], ...mine } : r));
  }
  if (!there) return now.slice();
  if (!had && (self || there.count <= there.who.length)) return now.slice();
  if (there.count <= 1) return now.filter((_, i) => i !== at);
  return now.map((r, i) => {
    if (i !== at) return r;
    const next: Reaction = { emoji: r.emoji, count: r.count - 1, who: r.who.filter((n) => n !== who) };
    return r.me && !self ? { ...next, me: true } : next;
  });
}

export function whoReacted(r: Reaction, me: string | null | undefined, glyph: string = r.emoji): string {
  const mine = reacted(r, me);
  const names = mine ? ['you', ...r.who.filter((n) => n !== me)] : r.who.slice();
  const shown = names.slice(0, 10);
  const rest = r.count - shown.length;
  const list =
    rest > 0
      ? `${shown.join(', ')} and ${rest} ${rest === 1 ? 'other' : 'others'}`
      : shown.length > 1
        ? `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}`
        : (shown[0] ?? '');
  return `${list} reacted with ${glyph}`;
}

export function reacted(r: Reaction, me: string | null | undefined): boolean {
  return !!me && (r.me === true || r.who.includes(me));
}
