const COMPACT = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

export function compactCount(n: number): string {
  return COMPACT.format(n).toLowerCase();
}

export function streamNumbers(followers: number | null, viewers: number | null): string {
  const parts: string[] = [];
  if (followers !== null) parts.push(`${compactCount(followers)} ${followers === 1 ? 'follower' : 'followers'}`);
  if (viewers !== null) parts.push(`${compactCount(viewers)} watching`);
  return parts.join(' · ');
}
