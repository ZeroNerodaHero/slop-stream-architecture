import { atom, type WritableAtom } from 'jotai';
import { atomWithStorage, RESET } from 'jotai/utils';

import { type VoiceCall, voiceCallAtom } from '@/infra/atoms/voice-state';
import { store } from '@/infra/store';
import { raiseWindow } from '@/infra/window-stack';

export const pipCallKey = (call: Pick<VoiceCall, 'server' | 'channel'>) => `${call.server}\n${call.channel}`;

export const voicePipHiddenAtom = atom<string | null>(null);

export const voicePipCollapsedAtom = atomWithStorage<boolean>('voice.pipCollapsed', false, undefined, { getOnInit: true });

type StoredAt = WritableAtom<unknown, [unknown | typeof RESET], void>;
const places = new Map<string, StoredAt>();

export function voicePipAtAtom(user: string): StoredAt {
  let kept = places.get(user);
  if (!kept) {
    kept = atomWithStorage<unknown>(`voice.pipAt.${user}`, null, undefined, { getOnInit: true });
    places.set(user, kept);
  }
  return kept;
}

export function hideVoicePip(): void {
  store.set(voicePipHiddenAtom, pipCallKey(store.get(voiceCallAtom)));
}

export function showVoicePip(): void {
  store.set(voicePipHiddenAtom, null);
  raiseWindow('voice');
}

store.sub(voiceCallAtom, () => {
  if (store.get(voiceCallAtom).phase === 'idle' && store.get(voicePipHiddenAtom) !== null) store.set(voicePipHiddenAtom, null);
});
