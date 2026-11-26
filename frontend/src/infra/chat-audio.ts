export interface ChatAudio {
  id: string;
  duration_ms: number;
}

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
  const { id, duration_ms } = raw as { id?: unknown; duration_ms?: unknown };
  if (typeof id !== 'string' || !id) return undefined;
  const ms = typeof duration_ms === 'number' && Number.isFinite(duration_ms) && duration_ms > 0 ? Math.round(duration_ms) : 0;
  return { id, duration_ms: ms };
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
