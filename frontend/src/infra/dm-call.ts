export const DM_CALL_PREFIX = 'dm--';
export const DM_CALL_CHANNEL = 'call';
export const RING_MS = 30_000;
export const BRIEF_MS = 2500;

const ROOM = /^dm--[0-9a-f]{28}$/;

export function isDmRoom(server: string): boolean {
  return ROOM.test(server);
}

export function callClock(secs: number): string {
  const whole = Number.isFinite(secs) ? Math.max(0, Math.floor(secs)) : 0;
  const h = Math.floor(whole / 3600);
  const m = Math.floor(whole / 60) % 60;
  const s = String(whole % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export type DmCallPhase = 'calling' | 'live' | 'declined' | 'no answer';

export function briefPhase(phase: DmCallPhase): boolean {
  return phase === 'declined' || phase === 'no answer';
}

export function callStatus(phase: DmCallPhase, peer: string, since: number | null, now: number): string {
  if (phase === 'calling') return `calling ${peer}…`;
  if (briefPhase(phase)) return phase;
  return since === null ? 'connecting…' : callClock((now - since) / 1000);
}

export interface CallMark {
  outcome: 'missed' | 'declined' | 'ended';
  secs: number | null;
}

export function callMarkOf(raw: unknown): CallMark | null {
  if (!raw || typeof raw !== 'object') return null;
  const { outcome, secs } = raw as { outcome?: unknown; secs?: unknown };
  if (outcome !== 'missed' && outcome !== 'declined' && outcome !== 'ended') return null;
  return { outcome, secs: typeof secs === 'number' && Number.isFinite(secs) ? secs : null };
}
