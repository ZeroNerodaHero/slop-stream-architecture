export const MATCH_TEXT = 'text-primaryBlue';
export const PICK_PANEL =
  'absolute bottom-full left-0 right-0 z-30 -mb-px overflow-hidden rounded-card border border-secondaryStroke bg-backgroundSecondary py-0.5 text-sm';
export const PICK_ROW = 'flex h-7 cursor-pointer items-center gap-2 border-l-2 pl-1.5 pr-2';
export const PICK_LIT = 'border-primaryBlue bg-backgroundTertiary/60 text-textPrimary';
export const PICK_DIM = 'border-transparent text-textSecondary';

export function matchParts(text: string, query: string): [string, string, string] {
  const at = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1;
  if (at < 0) return [text, '', ''];
  return [text.slice(0, at), text.slice(at, at + query.length), text.slice(at + query.length)];
}
