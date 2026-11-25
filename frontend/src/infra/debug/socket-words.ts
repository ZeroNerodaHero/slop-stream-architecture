import type { SocketInfo, SocketState } from './sockets.ts';

export const reconnects = (s: SocketInfo): number => Math.max(0, s.opens - 1);

export function age(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`;
}

export const SQUARE: Record<SocketState, string> = {
  open: 'bg-increase',
  connecting: 'bg-caution',
  reconnecting: 'bg-caution',
  closed: 'bg-textTertiary',
  idle: 'border border-textTertiary',
  error: 'bg-decrease'
};

export function socketLine(s: SocketInfo, now: number): string {
  const bits: string[] = [s.state];
  if (s.state === 'open' && s.last !== null) bits.push(age(now - s.last));
  const r = reconnects(s);
  if (r > 0) bits.push(`↻${r}`);
  return bits.join(' · ');
}

export function socketDetails(s: SocketInfo, now: number): string[] {
  if (s.state === 'idle' && s.opens === 0) return ['not in use'];
  return [
    s.path || '-',
    s.openedAt === null ? 'never opened' : `opened ${new Date(s.openedAt).toLocaleTimeString()}`,
    `reconnects ${reconnects(s)}`,
    s.last === null ? 'no message yet' : `last message ${age(now - s.last)} ago`
  ];
}
