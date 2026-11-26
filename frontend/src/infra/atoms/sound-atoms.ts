import { type Atom, atom } from 'jotai';
import { atomWithStorage } from 'jotai/utils';

import { choiceOf, DEFAULT_CHOICE, DEFAULT_VOLUME, SOUND_EVENTS, type SoundChoice, type SoundEvent, volumeOf } from '@/infra/sound-logic';
import { dropCustomSound, keepCustomSound, readCustomSound } from '@/infra/sound-store';
import { store } from '@/infra/store';

const stored = (key: string, fallback: unknown) => atomWithStorage<unknown>(key, fallback, undefined, { getOnInit: true });

const storedChoiceAtoms = {
  notification: stored('settings.sound.notification', DEFAULT_CHOICE.notification),
  voiceJoin: stored('settings.sound.voiceJoin', DEFAULT_CHOICE.voiceJoin),
  voiceLeave: stored('settings.sound.voiceLeave', DEFAULT_CHOICE.voiceLeave)
};

const storedVolumeAtoms = {
  notification: stored('settings.sound.notificationVolume', DEFAULT_VOLUME),
  voiceJoin: stored('settings.sound.voiceJoinVolume', DEFAULT_VOLUME),
  voiceLeave: stored('settings.sound.voiceLeaveVolume', DEFAULT_VOLUME)
};

export const soundChoiceAtoms: Record<SoundEvent, Atom<SoundChoice>> = {
  notification: atom((get) => choiceOf(get(storedChoiceAtoms.notification), 'notification')),
  voiceJoin: atom((get) => choiceOf(get(storedChoiceAtoms.voiceJoin), 'voiceJoin')),
  voiceLeave: atom((get) => choiceOf(get(storedChoiceAtoms.voiceLeave), 'voiceLeave'))
};

export const soundVolumeAtoms: Record<SoundEvent, Atom<number>> = {
  notification: atom((get) => volumeOf(get(storedVolumeAtoms.notification))),
  voiceJoin: atom((get) => volumeOf(get(storedVolumeAtoms.voiceJoin))),
  voiceLeave: atom((get) => volumeOf(get(storedVolumeAtoms.voiceLeave)))
};

export const customSoundNamesAtom = atom<Partial<Record<SoundEvent, string>>>({});

const customListeners = new Set<(event: SoundEvent) => void>();

export function onCustomSoundChange(listener: (event: SoundEvent) => void): () => void {
  customListeners.add(listener);
  return () => customListeners.delete(listener);
}

function customChanged(event: SoundEvent, name: string | null) {
  const names = { ...store.get(customSoundNamesAtom) };
  if (name === null) delete names[event];
  else names[event] = name;
  store.set(customSoundNamesAtom, names);
  for (const listener of customListeners) listener(event);
}

let loaded: Promise<void> | null = null;

export function loadCustomSoundNames(): Promise<void> {
  loaded ??= Promise.all(SOUND_EVENTS.map(async (e) => [e, (await readCustomSound(e))?.name ?? null] as const)).then((rows) => {
    const names: Partial<Record<SoundEvent, string>> = {};
    for (const [e, name] of rows) if (name !== null) names[e] = name;
    store.set(customSoundNamesAtom, names);
  });
  return loaded;
}

export function setSoundChoice(event: SoundEvent, choice: SoundChoice) {
  store.set(storedChoiceAtoms[event], choice);
}

export function setSoundVolume(event: SoundEvent, volume: number) {
  store.set(storedVolumeAtoms[event], volumeOf(volume));
}

export async function keepCustom(event: SoundEvent, blob: Blob, name: string): Promise<void> {
  await keepCustomSound(event, { blob, name });
  customChanged(event, name);
}

export async function dropCustom(event: SoundEvent): Promise<void> {
  await dropCustomSound(event);
  customChanged(event, null);
}
