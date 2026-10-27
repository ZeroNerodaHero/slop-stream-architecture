/**
 * How long a stream has been live, in words: "just started", "live for 12 min", "live for 3 hr",
 * "live for 2 days". Whole units, rounded down: "1 hr" means at least an hour, not 31 minutes.
 * `now` is the caller's clock in ms (a render must not read one). Skew clamps to zero.
 */
export function since(iso: string | null, now: number): string {
  if (!iso) return '';
  const mins = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60000));
  if (mins < 1) return 'just started';
  if (mins < 60) return `live for ${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `live for ${hours} hr`;
  const days = Math.floor(hours / 24);
  return `live for ${days} ${days === 1 ? 'day' : 'days'}`;
}

/**
 * How long ago something was, in words: "just now", "12 min ago", "3 hr ago", "2 days ago".
 * The units and the rounding of `since`, and the same `now`. The recently offline cards on
 * home say when the last stream ended with it.
 */
export function ago(iso: string, now: number): string {
  const mins = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}
