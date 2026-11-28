import { atom } from 'jotai';
import { atomWithStorage } from 'jotai/utils';

import { mixerOpenAtom, mixSound, modelAtom, relabelMix, selectedSourceAtom, unmixSound } from '@/infra/atoms/publish-atoms';
import { gainOf } from '@/infra/mixer';
import type { Source } from '@/infra/scene';
import { cleanSourceName, nameKey, readNames, readSounds, renamed, SOUND_VOLUME, type SoundSource, soundNameOf, soundRefusal } from '@/infra/source-settings';
import { store } from '@/infra/store';
import { HERE } from '@/infra/here';

const json = { getOnInit: true } as const;
const storedNamesAtom = atomWithStorage<unknown>('settings.sourceNames', {}, undefined, json);
const storedSoundsAtom = atomWithStorage<unknown>('settings.liveSounds', [], undefined, json);

export const sourceNamesAtom = atom((get) => readNames(get(storedNamesAtom)));
export const soundsAtom = atom((get) => readSounds(get(storedSoundsAtom)));
export const soundPlayingAtom = atom<Readonly<Record<string, boolean>>>({});
export const soundStatusAtom = atom('');

export interface SourceName {
  key: string;
  name: string;
  fallback: string;
}

export function sourceNameOf(source: Source, model: { name: string } | null, names: Readonly<Record<string, string>>): SourceName {
  const worn = source.kind === 'camera' && model !== null;
  const fallback = worn ? model.name : source.label;
  const key = nameKey(source, worn);
  return { key, name: names[key] ?? fallback, fallback };
}

export const nameOfSource = (source: Source): string => sourceNameOf(source, store.get(modelAtom), store.get(sourceNamesAtom)).name;

export function renameSource(name: SourceName, raw: string) {
  store.set(storedNamesAtom, renamed(store.get(sourceNamesAtom), name.key, raw, name.fallback));
}

const DB = 'live-sounds';
const FILES = 'files';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('no indexeddb here'));
      return;
    }
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(FILES)) request.result.createObjectStore(FILES);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('indexeddb would not open'));
    request.onblocked = () => reject(new Error('indexeddb is busy'));
  });
}

async function withFiles<T>(mode: IDBTransactionMode, work: (files: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    const tx = db.transaction(FILES, mode);
    const request = work(tx.objectStore(FILES));
    return await new Promise<T>((resolve, reject) => {
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('indexeddb gave up'));
    });
  } finally {
    db.close();
  }
}

interface Voice {
  audio: HTMLAudioElement;
  url: string;
  node: MediaElementAudioSourceNode;
  gain: GainNode;
  hear: GainNode;
  out: MediaStreamAudioDestinationNode;
}

let ctx: AudioContext | null = null;
const voices = new Map<string, Voice>();
const opening = new Map<string, Promise<Voice | null>>();
const EASE_S = 0.02;

function writeSounds(next: SoundSource[]) {
  store.set(storedSoundsAtom, next);
}

function changeSound(id: string, change: (s: SoundSource) => SoundSource) {
  writeSounds(store.get(soundsAtom).map((s) => (s.id === id ? change(s) : s)));
}

function setPlaying(id: string, on: boolean) {
  const playing = store.get(soundPlayingAtom);
  if ((playing[id] ?? false) === on) return;
  const next = { ...playing };
  if (on) next[id] = true;
  else delete next[id];
  store.set(soundPlayingAtom, next);
}

const trackOf = (voice: Voice) => voice.out.stream.getAudioTracks()[0];

function mixIn(sound: SoundSource, voice: Voice) {
  const track = trackOf(voice);
  if (track && store.get(mixerOpenAtom)) mixSound(sound.id, sound.name, track);
}

async function openVoice(sound: SoundSource): Promise<Voice | null> {
  let blob: Blob | undefined;
  try {
    blob = await withFiles<Blob | undefined>('readonly', (files) => files.get(sound.id) as IDBRequest<Blob | undefined>);
  } catch {
    blob = undefined;
  }
  if (!blob) {
    store.set(soundStatusAtom, `that sound is gone from ${HERE}. remove it and add it again`);
    return null;
  }
  if (typeof AudioContext === 'undefined') {
    store.set(soundStatusAtom, `${HERE} has no web audio`);
    return null;
  }
  const kept = store.get(soundsAtom).find((s) => s.id === sound.id);
  if (!kept) return null;
  ctx ??= new AudioContext({ latencyHint: 'interactive' });
  const url = URL.createObjectURL(blob);
  const audio = new Audio();
  audio.preload = 'auto';
  audio.loop = kept.loop;
  audio.src = url;
  const node = ctx.createMediaElementSource(audio);
  const gain = ctx.createGain();
  const hear = ctx.createGain();
  const out = ctx.createMediaStreamDestination();
  gain.gain.value = gainOf(kept.volume);
  hear.gain.value = kept.hear ? 1 : 0;
  node.connect(gain);
  gain.connect(out);
  gain.connect(hear);
  hear.connect(ctx.destination);
  audio.addEventListener('ended', () => setPlaying(sound.id, false));
  audio.addEventListener('pause', () => setPlaying(sound.id, false));
  audio.addEventListener('playing', () => setPlaying(sound.id, true));
  const voice: Voice = { audio, url, node, gain, hear, out };
  voices.set(sound.id, voice);
  mixIn(kept, voice);
  return voice;
}

function voiceOf(sound: SoundSource): Promise<Voice | null> {
  const have = voices.get(sound.id);
  if (have) return Promise.resolve(have);
  const pending = opening.get(sound.id);
  if (pending) return pending;
  const next = openVoice(sound).finally(() => opening.delete(sound.id));
  opening.set(sound.id, next);
  return next;
}

export async function addSound(file: File): Promise<void> {
  const refusal = soundRefusal(file, store.get(soundsAtom).length);
  if (refusal) {
    store.set(soundStatusAtom, refusal);
    return;
  }
  const id = `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  try {
    await withFiles('readwrite', (files) => files.put(file, id));
  } catch {
    store.set(soundStatusAtom, `${HERE} would not keep the sound`);
    return;
  }
  writeSounds([...store.get(soundsAtom), { id, name: soundNameOf(file.name), loop: false, volume: SOUND_VOLUME, hear: true }]);
  store.set(soundStatusAtom, '');
  store.set(selectedSourceAtom, id);
}

export async function playSound(id: string): Promise<void> {
  const sound = store.get(soundsAtom).find((s) => s.id === id);
  if (!sound) return;
  const voice = await voiceOf(sound);
  if (!voice || !ctx) return;
  if (ctx.state === 'suspended') await ctx.resume().catch(() => undefined);
  voice.audio.currentTime = 0;
  try {
    await voice.audio.play();
    store.set(soundStatusAtom, '');
  } catch {
    store.set(soundStatusAtom, 'that sound would not play');
  }
}

export function stopSound(id: string) {
  const voice = voices.get(id);
  if (voice) {
    voice.audio.pause();
    voice.audio.currentTime = 0;
  }
  setPlaying(id, false);
}

export function stopSounds() {
  for (const id of voices.keys()) stopSound(id);
}

export function setSoundLoop(id: string, loop: boolean) {
  changeSound(id, (s) => ({ ...s, loop }));
  const voice = voices.get(id);
  if (voice) voice.audio.loop = loop;
}

export function setSoundVolume(id: string, volume: number) {
  const level = Math.min(1, Math.max(0, volume));
  changeSound(id, (s) => ({ ...s, volume: level }));
  const voice = voices.get(id);
  if (voice && ctx) voice.gain.gain.setTargetAtTime(gainOf(level), ctx.currentTime, EASE_S);
}

export function setSoundHear(id: string, hear: boolean) {
  changeSound(id, (s) => ({ ...s, hear }));
  const voice = voices.get(id);
  if (voice && ctx) voice.hear.gain.setTargetAtTime(hear ? 1 : 0, ctx.currentTime, EASE_S);
}

export function renameSound(id: string, raw: string) {
  const name = cleanSourceName(raw);
  if (!name) return;
  changeSound(id, (s) => ({ ...s, name }));
  relabelMix(id, name);
}

export async function removeSound(id: string): Promise<void> {
  const voice = voices.get(id);
  if (voice) {
    voice.audio.pause();
    voice.audio.removeAttribute('src');
    voice.audio.load();
    voice.node.disconnect();
    voice.gain.disconnect();
    voice.hear.disconnect();
    URL.revokeObjectURL(voice.url);
    voices.delete(id);
  }
  unmixSound(id);
  setPlaying(id, false);
  writeSounds(store.get(soundsAtom).filter((s) => s.id !== id));
  if (store.get(selectedSourceAtom) === id) store.set(selectedSourceAtom, null);
  await withFiles('readwrite', (files) => files.delete(id)).catch(() => undefined);
}

let watching = false;

export function watchSources() {
  if (watching) return;
  watching = true;
  let worn = store.get(modelAtom) !== null;
  store.sub(modelAtom, () => {
    const now = store.get(modelAtom) !== null;
    if (now && !worn) store.set(selectedSourceAtom, 'cam');
    worn = now;
  });
  let open = store.get(mixerOpenAtom);
  store.sub(mixerOpenAtom, () => {
    const now = store.get(mixerOpenAtom);
    if (now && !open)
      queueMicrotask(() => {
        for (const sound of store.get(soundsAtom)) {
          const voice = voices.get(sound.id);
          if (voice) mixIn(sound, voice);
        }
      });
    if (!now && open) stopSounds();
    open = now;
  });
}
