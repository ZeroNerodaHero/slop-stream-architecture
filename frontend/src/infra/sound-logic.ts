import { HERE } from './here.ts';

export type SoundEvent = 'notification' | 'voiceJoin' | 'voiceLeave';

export const SOUND_EVENTS: readonly SoundEvent[] = ['notification', 'voiceJoin', 'voiceLeave'];

export type BellId = 'soft-chime' | 'bright-ding' | 'double-ding' | 'glass' | 'low-bell' | 'temple' | 'tiny-bell' | 'rise' | 'fall';

export const BELLS: readonly { id: BellId; label: string }[] = [
  { id: 'soft-chime', label: 'soft chime' },
  { id: 'bright-ding', label: 'bright ding' },
  { id: 'double-ding', label: 'double ding' },
  { id: 'glass', label: 'glass' },
  { id: 'low-bell', label: 'low bell' },
  { id: 'temple', label: 'temple bell' },
  { id: 'tiny-bell', label: 'tiny bell' },
  { id: 'rise', label: 'rise' },
  { id: 'fall', label: 'fall' }
];

export type SoundChoice = BellId | 'none' | 'custom';

export const DEFAULT_CHOICE: Record<SoundEvent, BellId> = {
  notification: 'soft-chime',
  voiceJoin: 'rise',
  voiceLeave: 'fall'
};

export const DEFAULT_VOLUME = 70;

export const CUSTOM_MAX_BYTES = 1024 * 1024;
export const CUSTOM_MAX_SECONDS = 5;
export const NOTIFY_GAP_MS = 1500;

export function isBell(id: unknown): id is BellId {
  return typeof id === 'string' && BELLS.some((b) => b.id === id);
}

export function choiceOf(kept: unknown, event: SoundEvent): SoundChoice {
  if (kept === 'none' || kept === 'custom' || isBell(kept)) return kept;
  return DEFAULT_CHOICE[event];
}

export function volumeOf(kept: unknown): number {
  if (typeof kept !== 'number' || !Number.isFinite(kept)) return DEFAULT_VOLUME;
  return Math.round(Math.min(100, Math.max(0, kept)));
}

export function bellUrl(id: BellId): string {
  return `/sounds/${id}.mp3`;
}

export function customRefusal(bytes: number, seconds: number | null): string {
  if (bytes > CUSTOM_MAX_BYTES) return 'too big: 1 MB at most';
  if (seconds === null || !Number.isFinite(seconds)) return `not a sound ${HERE} can play`;
  if (seconds > CUSTOM_MAX_SECONDS) return 'too long: 5 seconds at most';
  return '';
}

export interface RosterState {
  key: string;
  users: ReadonlySet<string> | null;
}

export const NO_ROSTER: RosterState = { key: '', users: null };

export interface RosterStep {
  state: RosterState;
  joined: string[];
  left: string[];
}

export function stepRoster(state: RosterState, key: string, settled: boolean, users: readonly string[] | null, me: string): RosterStep {
  if (!key) return { state: NO_ROSTER, joined: [], left: [] };
  const base: RosterState = key === state.key ? state : { key, users: null };
  if (users === null) return { state: base, joined: [], left: [] };
  const now = new Set(users.filter((u) => u && u !== me));
  if (!settled || base.users === null) return { state: { key, users: now }, joined: [], left: [] };
  const was = base.users;
  const joined = [...now].filter((u) => !was.has(u));
  const left = [...was].filter((u) => !now.has(u));
  return { state: { key, users: now }, joined, left };
}

export type CallPhase = 'idle' | 'joining' | 'connected' | 'failed';

export interface OwnCallStep {
  inCall: boolean;
  sound: 'voiceJoin' | 'voiceLeave' | null;
}

export function stepOwnCall(wasIn: boolean, phase: CallPhase): OwnCallStep {
  const inCall = phase === 'connected' || (wasIn && phase === 'joining');
  if (inCall && !wasIn) return { inCall, sound: 'voiceJoin' };
  if (!inCall && wasIn) return { inCall, sound: 'voiceLeave' };
  return { inCall, sound: null };
}

export function throttle(gapMs: number): (now: number) => boolean {
  let last = -Infinity;
  return (now) => {
    if (now - last < gapMs) return false;
    last = now;
    return true;
  };
}
