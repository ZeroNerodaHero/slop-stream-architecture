/**
 * The sound that leaves the page (docs/audio.md): the mic, and any sound added later, each
 * with a fader, a mute and a meter, summed into one track. That track is what the audio sender
 * holds for the whole stream, so a source coming or going changes the mix without anyone
 * renegotiating and without the sender's track ever changing.
 *
 * One AudioContext for every source (mic-level.ts opens one per reader, right for one meter and
 * wrong for several). Nothing here reaches `ctx.destination`: the streamer hears the tab from
 * the tab and themselves in the room, and every preview on the page is muted. Web audio keeps
 * rendering while the tab is hidden, which is where the streamer is once they share another tab.
 */

import { type Level, levelAnalyser, levelOf } from '@/infra/mic-level';

export interface MixSource {
  readonly id: string;
  /** The fader, 0..1: the slider's place. The gain is its cube, so the bottom half is "music under a voice" and not already silence. */
  setLevel(level: number): void;
  setMuted(muted: boolean): void;
  /** This source's own bar, measured after the fader and before the mute: a muted mic still shows it is picking you up. */
  readonly level: Level;
  /** Out of the mix. Never stops the track: the mic is the camera's to stop. */
  remove(): void;
}

export interface Mixer {
  /** `track` into the mix as `id`, at the fader's `level`. A source already there under that id is replaced. */
  add(id: string, track: MediaStreamTrack, level: number, muted: boolean): MixSource;
  remove(id: string): void;
  has(id: string): boolean;
  readonly source: (id: string) => MixSource | undefined;
  setMaster(level: number, muted: boolean): void;
  /** The master's bar: what everyone hears. */
  readonly master: Level;
  /** Clipped in the last second: the mix was too hot and the limiter is working. */
  clipping(now: number): boolean;
  /** What the audio sender holds. Stable for the mixer's life. */
  readonly outputTrack: MediaStreamTrack;
  /** A context made outside a click, or interrupted (a lid closed), sends silence until it runs: say so, and ask again on the next click. */
  readonly running: boolean;
  resume(): Promise<void>;
  /** Everything disconnected, the output track stopped, the context closed. Source tracks are untouched. */
  close(): void;
}

/** The fader's law: OBS's cubic. 0.5 is -18 dB, 0.8 is -6 dB. */
export const gainOf = (level: number) => Math.min(1, Math.max(0, level)) ** 3;
/** A gain change eases over this long, so a drag does not click. */
const EASE_S = 0.01;
/** The clip light stays on this long after a hot sample. */
const CLIP_MS = 1000;

interface Strip {
  stream: MediaStream;
  input: MediaStreamAudioSourceNode;
  fader: GainNode;
  mute: GainNode;
  analyser: AnalyserNode;
  level: Level;
}

/** `null` where the browser has no web audio: the caller publishes the raw mic, as before the mixer. */
export function openMixer(): Mixer | null {
  if (typeof AudioContext === 'undefined') return null;
  const ctx = new AudioContext({ latencyHint: 'interactive' });
  const masterFader = ctx.createGain();
  const masterMute = ctx.createGain();
  // a safety limiter: a mic at 0 dB plus tab music at 0 dB sums past full scale and clips before opus
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -6;
  limiter.knee.value = 6;
  limiter.ratio.value = 12;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.25;
  const masterAnalyser = levelAnalyser(ctx);
  const out = ctx.createMediaStreamDestination();
  masterFader.connect(masterMute);
  masterMute.connect(limiter);
  limiter.connect(masterAnalyser);
  limiter.connect(out);
  const outputTrack = out.stream.getAudioTracks()[0]!;
  outputTrack.contentHint = 'speech';
  const strips = new Map<string, Strip>();
  const peak = new Float32Array(masterAnalyser.fftSize);
  let clippedAt = -Infinity;
  const ease = (param: AudioParam, value: number) => param.setTargetAtTime(value, ctx.currentTime, EASE_S);
  if (ctx.state === 'suspended') ctx.resume().catch(() => undefined);

  const remove = (id: string) => {
    const strip = strips.get(id);
    if (!strip) return;
    strips.delete(id);
    strip.input.disconnect();
    strip.fader.disconnect();
    strip.mute.disconnect();
  };
  const sourceOf = (id: string, strip: Strip): MixSource => ({
    id,
    setLevel: (level) => ease(strip.fader.gain, gainOf(level)),
    setMuted: (muted) => ease(strip.mute.gain, muted ? 0 : 1),
    level: strip.level,
    remove: () => remove(id)
  });

  return {
    add(id, track, level, muted) {
      remove(id);
      // the stream is kept on the strip: a source node whose stream is collected can go quiet
      const stream = new MediaStream([track]);
      const input = ctx.createMediaStreamSource(stream);
      const fader = ctx.createGain();
      const mute = ctx.createGain();
      const analyser = levelAnalyser(ctx);
      fader.gain.value = gainOf(level);
      mute.gain.value = muted ? 0 : 1;
      input.connect(fader);
      fader.connect(analyser);
      fader.connect(mute);
      mute.connect(masterFader);
      const strip: Strip = { stream, input, fader, mute, analyser, level: levelOf(analyser) };
      strips.set(id, strip);
      if (ctx.state === 'suspended') ctx.resume().catch(() => undefined);
      return sourceOf(id, strip);
    },
    remove,
    has: (id) => strips.has(id),
    source: (id) => {
      const strip = strips.get(id);
      return strip && sourceOf(id, strip);
    },
    setMaster(level, muted) {
      ease(masterFader.gain, gainOf(level));
      ease(masterMute.gain, muted ? 0 : 1);
    },
    master: levelOf(masterAnalyser),
    clipping(now) {
      masterAnalyser.getFloatTimeDomainData(peak);
      for (const s of peak) {
        if (s >= 0.99 || s <= -0.99) {
          clippedAt = now;
          break;
        }
      }
      return now - clippedAt < CLIP_MS;
    },
    outputTrack,
    get running() {
      return ctx.state === 'running';
    },
    resume: () => ctx.resume(),
    close() {
      for (const id of strips.keys()) remove(id);
      outputTrack.stop();
      ctx.close().catch(() => undefined);
    }
  };
}
