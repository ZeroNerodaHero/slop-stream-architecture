import type { Source } from './scene.ts';

export type InputKind = 'model' | 'camera' | 'screen' | 'image' | 'avatar' | 'sound';
export type InputSection = 'fill' | 'fitCamera' | 'device' | 'model' | 'rigging' | 'playback' | 'look';

const SECTIONS: Record<InputKind, readonly InputSection[]> = {
  model: ['fill', 'model', 'rigging'],
  camera: ['fill', 'device'],
  screen: ['fill'],
  image: ['fitCamera'],
  avatar: ['look'],
  sound: ['playback']
};

export const INPUT_WORDS: Record<InputKind, string> = {
  model: 'model',
  camera: 'camera',
  screen: 'screen',
  image: 'picture',
  avatar: 'avatar',
  sound: 'sound'
};

export function inputKindOf(kind: Source['kind'] | 'sound', worn: boolean): InputKind {
  if (kind === 'camera') return worn ? 'model' : 'camera';
  return kind;
}

export const sectionsOf = (kind: InputKind): readonly InputSection[] => SECTIONS[kind];

export const SOURCE_NAME_MAX = 32;
const NAMES_MAX = 64;
const NAME_KEY = /^(camera|model|avatar|screen\d{1,2}|image\d{1,12})$/;

export function nameKey(source: Pick<Source, 'kind' | 'slot' | 'asset'>, worn: boolean): string {
  if (source.kind === 'camera') return worn ? 'model' : 'camera';
  if (source.kind === 'screen') return `screen${source.slot ?? 0}`;
  if (source.kind === 'image') return `image${source.asset ?? 0}`;
  return 'avatar';
}

export function cleanSourceName(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, SOURCE_NAME_MAX).trim();
}

export function readNames(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const names: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (Object.keys(names).length >= NAMES_MAX) break;
    if (!NAME_KEY.test(key) || typeof value !== 'string') continue;
    const name = cleanSourceName(value);
    if (name) names[key] = name;
  }
  return names;
}

export function renamed(names: Record<string, string>, key: string, raw: string, fallback: string): Record<string, string> {
  const name = cleanSourceName(raw);
  const next = { ...names };
  if (!name || name === fallback) delete next[key];
  else next[key] = name;
  return next;
}

export interface SoundSource {
  id: string;
  name: string;
  loop: boolean;
  volume: number;
  hear: boolean;
}

export const SOUNDS_MAX = 8;
export const SOUND_MAX_BYTES = 20 * 1024 * 1024;
export const SOUND_VOLUME = 0.8;
const SOUND_ID = /^a[a-z0-9]{4,24}$/;
const SOUND_EXT = /\.(mp3|wav|ogg|oga|opus|m4a|aac|flac|webm)$/i;

export const isSoundId = (id: string) => SOUND_ID.test(id);

export function readSounds(raw: unknown): SoundSource[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const sounds: SoundSource[] = [];
  for (const entry of raw) {
    if (sounds.length >= SOUNDS_MAX) break;
    if (!entry || typeof entry !== 'object') continue;
    const s = entry as Record<string, unknown>;
    if (typeof s.id !== 'string' || !SOUND_ID.test(s.id) || seen.has(s.id)) continue;
    seen.add(s.id);
    const name = typeof s.name === 'string' ? cleanSourceName(s.name) : '';
    const volume = typeof s.volume === 'number' && Number.isFinite(s.volume) ? Math.min(1, Math.max(0, s.volume)) : SOUND_VOLUME;
    sounds.push({ id: s.id, name: name || 'sound', loop: s.loop === true, volume, hear: s.hear !== false });
  }
  return sounds;
}

export function soundRefusal(file: { name: string; type: string; size: number }, count: number): string | null {
  if (!file.type.startsWith('audio/') && !SOUND_EXT.test(file.name)) return 'that is not a sound file';
  if (file.size > SOUND_MAX_BYTES) return `too big: ${SOUND_MAX_BYTES / (1024 * 1024)} MB at most`;
  if (count >= SOUNDS_MAX) return `${SOUNDS_MAX} sounds at most`;
  return null;
}

export function soundNameOf(fileName: string): string {
  return cleanSourceName(fileName.replace(/\.[^.]+$/, '')) || 'sound';
}
