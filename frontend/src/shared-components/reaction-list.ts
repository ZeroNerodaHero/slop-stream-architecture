/**
 * Reactions (docs/chat.md "reactions"): the emoji a line may wear, and what the pages do with the
 * frames that change them. The api allows these and no others, in this order (api/src/reactions.rs
 * `EMOJIS`; a test there reads this list), so the picker never offers one it would refuse.
 */

/** The picker's grid, the first `QUICK` of them its quick row. */
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

/** Each emoji's name: its button's label and tooltip, and the words a chip's reader hears. */
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

/** How many of `EMOJIS` stand in the picker's quick row. */
export const QUICK = 6;

/** Different emoji on one line, at most (reactions.rs `MAX_KINDS`): the picker says so past it. */
export const MAX_KINDS = 20;

/** One emoji on a line: how many put it there, and the first of them by name (25 at most, reactions.rs `NAMES_SHOWN`), in the order they came. */
export interface Reaction {
  emoji: string;
  count: number;
  who: string[];
  /** The login reading is one of `count`, named in `who` or not (reactions.rs `Reaction::me`): past the first 25 only this says so. Absent for no. */
  me?: boolean;
}

/** A line's reactions as the wire had them: only well-formed ones, none for an older api. */
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

/**
 * `who` put `emoji` on a line, or took it off (`on`): the line's reactions after it. Said twice, the
 * second is no change (a reaction between a history and its socket's first frame comes in both). A
 * name past the first 25 is not in `who`; its count still moves. `me` is the login reading: their
 * own change sets the reaction's `me`, and their own twice is known by it even past the 25.
 */
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
  // our own off of one we do not have is no change; a name we cannot see in the first 25 may still be one of the count: it moves, once
  if (!had && (self || there.count <= there.who.length)) return now.slice();
  if (there.count <= 1) return now.filter((_, i) => i !== at);
  return now.map((r, i) => {
    if (i !== at) return r;
    const next: Reaction = { emoji: r.emoji, count: r.count - 1, who: r.who.filter((n) => n !== who) };
    return r.me && !self ? { ...next, me: true } : next;
  });
}

/**
 * Who put `r` there, in words, for its chip's tooltip: `you, bob and 3 others reacted with 🔥`.
 * You first when you are one, then the names in the order they came, then how many past those.
 */
export function whoReacted(r: Reaction, me: string | null | undefined): string {
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
  return `${list} reacted with ${r.emoji}`;
}

/** Whether `me` is among those who put `r` there: the api's word for it, or their name among the shown. */
export function reacted(r: Reaction, me: string | null | undefined): boolean {
  return !!me && (r.me === true || r.who.includes(me));
}
