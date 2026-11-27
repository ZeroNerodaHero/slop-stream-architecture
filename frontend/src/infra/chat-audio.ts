export interface ChatAudio {
  id: string;
  duration_ms: number;
  peaks?: number[];
}

export const PEAK_COUNT = 40;
export const MAX_PEAKS = 64;
const FLAT_PEAK = 0.35;
const PLAYED_KEY = 'chat.audioPlayed';
const PLAYED_KEEP = 500;

export const MAX_AUDIO_BYTES = 2 * 1024 * 1024;
export const MAX_AUDIO_MS = 120_000;
export const AUDIO_BITS_PER_SECOND = 32_000;

export const RECORDER_TYPES = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'] as const;

export const VOICE_CONSTRAINTS: MediaStreamConstraints = {
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
};

export function audioSrc(id: string): string {
  return `/api/chat-audio/${encodeURIComponent(id)}`;
}

export function audioOf(raw: unknown): ChatAudio | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const { id, duration_ms, peaks } = raw as { id?: unknown; duration_ms?: unknown; peaks?: unknown };
  if (typeof id !== 'string' || !id) return undefined;
  const ms = typeof duration_ms === 'number' && Number.isFinite(duration_ms) && duration_ms > 0 ? Math.round(duration_ms) : 0;
  const shape = peaksOf(peaks);
  return shape ? { id, duration_ms: ms, peaks: shape } : { id, duration_ms: ms };
}

export function peaksOf(raw: unknown): number[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_PEAKS) return undefined;
  for (const v of raw) if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) return undefined;
  return raw as number[];
}

export function peaksFrom(levels: readonly number[], count = PEAK_COUNT): number[] | undefined {
  const heard = levels.filter((v) => Number.isFinite(v) && v >= 0);
  if (heard.length === 0) return undefined;
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const from = Math.floor((i * heard.length) / count);
    const to = Math.max(from + 1, Math.floor(((i + 1) * heard.length) / count));
    let top = 0;
    for (const v of heard.slice(from, to)) top = Math.max(top, v);
    out.push(top);
  }
  const loudest = Math.max(...out);
  if (loudest <= 0) return out.map(() => 0);
  return out.map((v) => Math.round(Math.min(1, v / loudest) * 100) / 100);
}

export function barsOf(peaks: readonly number[] | undefined, count = PEAK_COUNT): number[] {
  if (!peaks || peaks.length === 0) return Array.from({ length: count }, () => FLAT_PEAK);
  return Array.from({ length: count }, (_, i) => peaks[Math.min(peaks.length - 1, Math.floor((i * peaks.length) / count))] ?? FLAT_PEAK);
}

export function peaksQuery(peaks: readonly number[] | undefined): string {
  const shape = peaksOf(peaks ? [...peaks] : undefined);
  return shape ? `?peaks=${shape.map((v) => Math.round(v * 100) / 100).join(',')}` : '';
}

function playedIds(): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(PLAYED_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export function wasPlayed(id: string): boolean {
  return playedIds().includes(id);
}

export function markPlayed(id: string) {
  const ids = playedIds().filter((v) => v !== id);
  ids.push(id);
  try {
    localStorage.setItem(PLAYED_KEY, JSON.stringify(ids.slice(-PLAYED_KEEP)));
  } catch {
    return;
  }
}

export function pickRecorderType(supported: ((type: string) => boolean) | undefined): string {
  if (!supported) return '';
  for (const type of RECORDER_TYPES) {
    try {
      if (supported(type)) return type;
    } catch {
      continue;
    }
  }
  return '';
}

export function clockOf(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function micRefusal(err: unknown): string {
  const name = err && typeof err === 'object' && 'name' in err ? String((err as { name: unknown }).name) : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'microphone blocked. allow it to record';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'no microphone found';
  if (name === 'NotReadableError') return 'the microphone is busy';
  return 'could not open the microphone';
}
