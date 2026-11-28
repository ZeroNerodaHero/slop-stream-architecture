export type ScreenAsk = 'picking' | 'blocked';
export type ScreenAsks = Readonly<Partial<Record<number, ScreenAsk>>>;
export type PickOutcome = 'shared' | 'none' | 'dropped';

export function withAsk(asks: ScreenAsks, slot: number, ask: ScreenAsk | null): ScreenAsks {
  const next: Partial<Record<number, ScreenAsk>> = { ...asks };
  if (ask) next[slot] = ask;
  else delete next[slot];
  return next;
}

export const askAfter = (outcome: PickOutcome): ScreenAsk | null => (outcome === 'none' ? 'blocked' : null);
