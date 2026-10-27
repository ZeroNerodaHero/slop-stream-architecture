/**
 * How loud the mic is, many times a second, for a bar that moves with the voice. An
 * `AnalyserNode` on the camera's audio track: the samples are read off it and never played
 * (nothing is wired to the speakers), and the peer connection sending that same track is none
 * the wiser. The once-a-second level in `stream-stats.ts` is for the numbers; this is for the eye.
 */

/** Below this the bar is empty: room noise, a mic left open in a quiet room. 0 dB, a full-scale signal, is the top. */
const FLOOR_DB = -50;
/** The bar falls at most this much of its height per second, so a word leaves a trail instead of a flicker. It rises at once. */
const RELEASE_PER_S = 2.5;
/** A frame this long after the last one was a hidden tab: the fall is bounded, not caught up on in one jump. */
const MAX_DT_S = 0.1;
/** Samples per read: 21ms at 48kHz, about a frame of the screen. */
const WINDOW = 1024;

export interface MicLevel {
  /** The bar's height, 0..1, as of `now` (a `performance.now()` time): the loudness over the last few milliseconds, with the fall slowed. */
  read(now: number): number;
  /** Releases the audio context. Reading after this is 0. */
  close(): void;
}

/**
 * A reader of `track`'s loudness. `null` where the browser has no web audio. One
 * `AudioContext` for the reader's life; `close` releases it.
 */
export function openMicLevel(track: MediaStreamTrack): MicLevel | null {
  if (typeof AudioContext === 'undefined') return null;
  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = WINDOW;
  const source = ctx.createMediaStreamSource(new MediaStream([track]));
  source.connect(analyser);
  // a context made with no click behind it starts suspended. the start button was one, but asking costs nothing
  if (ctx.state === 'suspended') ctx.resume().catch(() => undefined);
  const samples = new Float32Array(WINDOW);
  let shown = 0;
  let at = 0;
  let closed = false;
  return {
    read(now) {
      if (closed) return 0;
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const s of samples) sum += s * s;
      const rms = Math.sqrt(sum / WINDOW);
      // -50 dB and under is 0, 0 dB is 1, a straight line between: the ear hears in decibels
      const db = 20 * Math.log10(Math.max(rms, 1e-9));
      const target = Math.min(1, Math.max(0, 1 - db / FLOOR_DB));
      const dt = at ? Math.min(MAX_DT_S, Math.max(0, now - at) / 1000) : 0;
      at = now;
      shown = target >= shown ? target : Math.max(target, shown - RELEASE_PER_S * dt);
      return shown;
    },
    close() {
      closed = true;
      source.disconnect();
      ctx.close().catch(() => undefined);
    }
  };
}
