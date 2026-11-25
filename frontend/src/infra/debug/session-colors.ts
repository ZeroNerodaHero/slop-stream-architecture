export const SESSION_COLORS = ['text-primaryBlue', 'text-increase', 'text-violet-400', 'text-caution', 'text-pink-400', 'text-teal-400'] as const;

export const sessionColor = (session: number): string => SESSION_COLORS[((session % SESSION_COLORS.length) + SESSION_COLORS.length) % SESSION_COLORS.length]!;

export function runAt<R extends { from: number; to: number }>(runs: readonly R[], i: number): R | undefined {
  return runs.find((r) => i >= r.from && i < r.to);
}
