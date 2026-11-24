import { type Level, levelAnalyser, levelOf } from '@/infra/mic-level';

export interface MixSource {
  readonly id: string;
  setLevel(level: number): void;
  setMuted(muted: boolean): void;
  readonly level: Level;
  remove(): void;
}

export interface Mixer {
  add(id: string, track: MediaStreamTrack, level: number, muted: boolean): MixSource;
  remove(id: string): void;
  has(id: string): boolean;
  readonly source: (id: string) => MixSource | undefined;
  setMaster(level: number, muted: boolean): void;
  readonly master: Level;
  clipping(now: number): boolean;
  readonly outputTrack: MediaStreamTrack;
  readonly running: boolean;
  resume(): Promise<void>;
  close(): void;
}

export const gainOf = (level: number) => Math.min(1, Math.max(0, level)) ** 3;
const EASE_S = 0.01;
const CLIP_MS = 1000;

interface Strip {
  stream: MediaStream;
  input: MediaStreamAudioSourceNode;
  fader: GainNode;
  mute: GainNode;
  analyser: AnalyserNode;
  level: Level;
}

export function openMixer(): Mixer | null {
  if (typeof AudioContext === 'undefined') return null;
  const ctx = new AudioContext({ latencyHint: 'interactive' });
  const masterFader = ctx.createGain();
  const masterMute = ctx.createGain();
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
