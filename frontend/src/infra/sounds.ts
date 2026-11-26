import { customSoundNamesAtom, onCustomSoundChange, soundChoiceAtoms, soundVolumeAtoms } from '@/infra/atoms/sound-atoms';
import { DEFAULT_DEVICE, voiceDeafAtom, voiceOutputAtom } from '@/infra/atoms/voice-atoms';
import { type BellId, bellUrl, CUSTOM_MAX_BYTES, customRefusal, isBell, type SoundEvent } from '@/infra/sound-logic';
import { readCustomSound } from '@/infra/sound-store';
import { store } from '@/infra/store';

type SinkContext = AudioContext & { setSinkId?: (id: string) => Promise<void> };

const RESUME_MS = 300;

let ctx: SinkContext | null = null;
let sunk = DEFAULT_DEVICE;
const bells = new Map<BellId, Promise<AudioBuffer | null>>();
const customs = new Map<SoundEvent, Promise<AudioBuffer | null>>();

onCustomSoundChange((event) => customs.delete(event));

function context(): SinkContext | null {
  if (ctx) return ctx;
  if (typeof AudioContext === 'undefined') return null;
  try {
    ctx = new AudioContext();
  } catch {
    return null;
  }
  return ctx;
}

function sink(c: SinkContext) {
  const want = store.get(voiceOutputAtom);
  if (want === sunk || !c.setSinkId) return;
  sunk = want;
  void c.setSinkId(want === DEFAULT_DEVICE ? '' : want).catch(() => c.setSinkId?.('').catch(() => undefined));
}

async function decode(bytes: ArrayBuffer): Promise<AudioBuffer | null> {
  const c = context();
  if (!c) return null;
  try {
    return await c.decodeAudioData(bytes);
  } catch {
    return null;
  }
}

function bell(id: BellId): Promise<AudioBuffer | null> {
  let got = bells.get(id);
  if (!got) {
    got = fetch(bellUrl(id))
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .then((bytes) => (bytes ? decode(bytes) : null))
      .catch(() => null);
    void got.then((buffer) => buffer || bells.delete(id));
    bells.set(id, got);
  }
  return got;
}

function custom(event: SoundEvent): Promise<AudioBuffer | null> {
  let got = customs.get(event);
  if (!got) {
    got = readCustomSound(event)
      .then((kept) => (kept ? kept.blob.arrayBuffer() : null))
      .then((bytes) => (bytes ? decode(bytes) : null))
      .catch(() => null);
    customs.set(event, got);
  }
  return got;
}

function bufferOf(event: SoundEvent): Promise<AudioBuffer | null> {
  const choice = store.get(soundChoiceAtoms[event]);
  if (choice === 'none') return Promise.resolve(null);
  if (choice === 'custom') return store.get(customSoundNamesAtom)[event] ? custom(event) : Promise.resolve(null);
  return bell(choice);
}

async function play(buffer: Promise<AudioBuffer | null>, volume: number): Promise<void> {
  try {
    const c = context();
    if (!c || volume <= 0) return;
    if (c.state !== 'running') await Promise.race([c.resume().catch(() => undefined), new Promise((done) => setTimeout(done, RESUME_MS))]);
    const got = await buffer;
    if (!got || c.state !== 'running') return;
    sink(c);
    const gain = c.createGain();
    gain.gain.value = volume / 100;
    const source = c.createBufferSource();
    source.buffer = got;
    source.connect(gain).connect(c.destination);
    source.onended = () => gain.disconnect();
    source.start();
  } catch {
    return;
  }
}

export function playSound(event: SoundEvent): void {
  if (event !== 'notification' && store.get(voiceDeafAtom)) return;
  if (store.get(soundChoiceAtoms[event]) === 'none') return;
  void play(bufferOf(event), store.get(soundVolumeAtoms[event]));
}

export function previewSound(what: SoundEvent | BellId, volume: number): void {
  void play(isBell(what) ? bell(what) : bufferOf(what), volume);
}

export async function checkCustomFile(file: Blob): Promise<string> {
  if (file.size > CUSTOM_MAX_BYTES) return customRefusal(file.size, 0);
  let seconds: number | null = null;
  try {
    seconds = (await decode(await file.arrayBuffer()))?.duration ?? null;
  } catch {
    seconds = null;
  }
  return customRefusal(file.size, seconds);
}

let unlocking = false;

export function installSoundUnlock(): void {
  if (unlocking || typeof window === 'undefined') return;
  unlocking = true;
  const unlock = () => {
    window.removeEventListener('pointerdown', unlock, true);
    window.removeEventListener('keydown', unlock, true);
    const c = context();
    if (c && c.state !== 'running') void c.resume().catch(() => undefined);
  };
  window.addEventListener('pointerdown', unlock, true);
  window.addEventListener('keydown', unlock, true);
}
