/**
 * The watch page's beat for the streamer's stats (docs/analytics.md): while the video plays, a
 * `POST /api/streams/<name>/watching` at once and then every minute, and one more with
 * `leave=1` when it stops (the page left, the stream ended, the tab closed). The api turns them
 * into one stretch of watching per viewer. A login is counted by its cookie; anyone else by a
 * random id this browser keeps (`ANON_KEY`), sent every time, so a guest is one viewer however
 * many streams and visits. The viewer counts are not this: those are video's own.
 */

import { api } from '@/infra/api';

const BEAT_MS = 60_000;
/** Versioned, like the settings keys. A random uuid, made the first time it is asked for. */
const ANON_KEY = 'analytics.anonId.v1';

let beating: string | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

function makeId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // an older browser, or a page not on https: the same shape by hand (version 4, variant 10)
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** This browser's anonymous id. Storage refused (a private window's): one for this page's life. */
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

/** The watch page's phase moved: `playing` for frames on screen (a blip included), the name it is of. */
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

// a closed tab says so too; a bfcache'd one starts again from its next phase
if (typeof window !== 'undefined') window.addEventListener('pagehide', stop);
