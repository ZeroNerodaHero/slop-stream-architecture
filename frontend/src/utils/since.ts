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

export function ago(iso: string, now: number): string {
  const mins = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

const LONG_MONTH = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

export function monthOf(iso: string): string {
  const d = new Date(iso);
  return `${LONG_MONTH[d.getMonth()]} ${d.getFullYear()}`;
}
