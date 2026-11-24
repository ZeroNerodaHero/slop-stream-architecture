import { api } from '@/infra/api';

const BEAT_MS = 60_000;
const ANON_KEY = 'analytics.anonId.v1';

let beating: string | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

function makeId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

let fallback: string | null = null;
export function anonId(): string {
  try {
    const kept = localStorage.getItem(ANON_KEY);
    if (kept && /^[0-9a-f-]{36}$/i.test(kept)) return kept;
    const made = makeId();
    localStorage.setItem(ANON_KEY, made);
    return made;
  } catch {
    fallback ??= makeId();
    return fallback;
  }
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  if (beating) api.watchingBeacon(beating, anonId());
  beating = null;
}

export function watchBeat(name: string, playing: boolean) {
  if (playing && name && beating === name) return;
  stop();
  if (!playing || !name) return;
  beating = name;
  const beat = () => {
    if (beating === name) void api.watching(name, anonId()).catch(() => {});
  };
  beat();
  timer = setInterval(beat, BEAT_MS);
}

if (typeof window !== 'undefined') window.addEventListener('pagehide', stop);
