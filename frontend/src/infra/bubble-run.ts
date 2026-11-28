export function bubbleCorners(first: boolean, last: boolean, mine: boolean): string {
  const top = mine ? 'bubble:rounded-tr-bubble-join' : 'bubble:rounded-tl-bubble-join';
  const bottom = mine ? 'bubble:rounded-br-bubble-join' : 'bubble:rounded-bl-bubble-join';
  return ['bubble:rounded-bubble-outer', !first && top, !last && bottom].filter(Boolean).join(' ');
}

export interface Nook {
  left?: number;
  right?: number;
  top: number;
}

export interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export const NOOK_GAP = 4;

export function nookOf(line: Rect, lane: Rect, reach: Rect, bubble: Rect, width: number, mine: boolean): Nook | null {
  const top = (bubble.top + bubble.bottom) / 2 - line.top;
  if (mine) return reach.left - lane.left - NOOK_GAP >= width ? { right: line.right - reach.left + NOOK_GAP, top } : null;
  return lane.right - reach.right - NOOK_GAP >= width ? { left: reach.right - line.left + NOOK_GAP, top } : null;
}
