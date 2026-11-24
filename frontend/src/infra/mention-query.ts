export const MENTION_SCAN = 33;

function nameChar(c: number): boolean {
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95 || c === 45;
}

export function mentionQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const stop = Math.max(0, caret - MENTION_SCAN);
  for (let i = caret - 1; i >= stop; i--) {
    const c = text.charCodeAt(i);
    if (c === 64) {
      if (i > 0 && (nameChar(text.charCodeAt(i - 1)) || text.charCodeAt(i - 1) === 64)) return null;
      return { start: i, query: text.slice(i + 1, caret).toLowerCase() };
    }
    if (!nameChar(c)) return null;
  }
  return null;
}
