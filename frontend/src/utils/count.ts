const COMPACT = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

/** A count short enough for a phone's title row: `34`, `1.2k`, `3m`. */
export function compactCount(n: number): string {
  return COMPACT.format(n).toLowerCase();
}

/** A stream's numbers under its name on a phone: `1.2k followers · 34 watching`, either part left out while it is not known. */
export function streamNumbers(followers: number | null, viewers: number | null): string {
  const parts: string[] = [];
  if (followers !== null) parts.push(`${compactCount(followers)} ${followers === 1 ? 'follower' : 'followers'}`);
  if (viewers !== null) parts.push(`${compactCount(viewers)} watching`);
  return parts.join(' · ');
}
