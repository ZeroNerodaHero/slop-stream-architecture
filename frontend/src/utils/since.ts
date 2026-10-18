/** "just started", "12 min", "3 h". Clock skew clamps to zero. */
export function since(iso: string | null, now = Date.now()): string {
  if (!iso) return '';
  const mins = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60000));
  if (mins < 1) return 'just started';
  if (mins < 60) return `${mins} min`;
  return `${Math.round(mins / 60)} h`;
}
