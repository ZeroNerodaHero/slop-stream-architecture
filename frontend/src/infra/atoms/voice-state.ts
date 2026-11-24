import { atom } from 'jotai';
import { atomWithStorage } from 'jotai/utils';

import { store } from '@/infra/store';

export interface VoiceCall {
  phase: 'idle' | 'joining' | 'connected' | 'failed';
  server: string;
  channel: string;
  linked: boolean;
  error: string;
  retry: number;
}

export const IDLE: VoiceCall = { phase: 'idle', server: '', channel: '', linked: false, error: '', retry: 0 };

export const voiceCallAtom = atom<VoiceCall>(IDLE);

export interface HeardLevel {
  volume: number;
  muted: boolean;
}

export const HEARD_DEFAULT: HeardLevel = { volume: 100, muted: false };
export const HEARD_MAX = 200;

const storedHeardAtom = atomWithStorage<unknown>('voice.heard', {}, undefined, { getOnInit: true });

export const voiceHeardAtom = atom((get) => {
  const kept = get(storedHeardAtom);
  const levels: Record<string, HeardLevel> = {};
  if (!kept || typeof kept !== 'object') return levels;
  for (const [uid, level] of Object.entries(kept as Record<string, unknown>)) {
    if (!level || typeof level !== 'object') continue;
    const { volume, muted } = level as Partial<HeardLevel>;
    levels[uid] = { volume: typeof volume === 'number' && Number.isFinite(volume) ? Math.min(HEARD_MAX, Math.max(0, volume)) : 100, muted: muted === true };
  }
  return levels;
});

export const voiceUidsAtom = atom<ReadonlyMap<string, string>>(new Map<string, string>());

export function heardLevelOf(levels: Record<string, HeardLevel>, uid: string): HeardLevel {
  return levels[uid] ?? HEARD_DEFAULT;
}

export function setHeardLevel(uid: string, next: Partial<HeardLevel>): void {
  const levels = { ...store.get(voiceHeardAtom) };
  const level = { ...heardLevelOf(levels, uid), ...next };
  level.volume = Math.round(Math.min(HEARD_MAX, Math.max(0, level.volume)));
  if (level.volume === HEARD_DEFAULT.volume && level.muted === HEARD_DEFAULT.muted) delete levels[uid];
  else levels[uid] = level;
  store.set(storedHeardAtom, levels);
}
