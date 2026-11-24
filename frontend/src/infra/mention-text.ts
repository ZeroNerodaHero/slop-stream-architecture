export type MentionPart = string | { mention: string; text: string };

const NAME_CHARS = 32;

function nameChar(c: string | undefined): boolean {
  return c !== undefined && /[A-Za-z0-9_-]/.test(c);
}

export function splitMentions(text: string, mentions: readonly string[] | undefined): MentionPart[] {
  if (!mentions || mentions.length === 0 || !text.includes('@')) return [text];
  const known = new Set(mentions);
  const parts: MentionPart[] = [];
  let at = 0;
  let i = text.indexOf('@');
  while (i !== -1) {
    let end = i + 1;
    while (nameChar(text[end])) end += 1;
    const run = end - i - 1;
    const name = text.slice(i + 1, end).toLowerCase();
    if (!nameChar(text[i - 1]) && run >= 1 && run <= NAME_CHARS && known.has(name)) {
      if (i > at) parts.push(text.slice(at, i));
      parts.push({ mention: name, text: text.slice(i, end) });
      at = end;
    }
    i = text.indexOf('@', Math.max(end, i + 1));
  }
  if (at === 0) return [text];
  if (at < text.length) parts.push(text.slice(at));
  return parts;
}
