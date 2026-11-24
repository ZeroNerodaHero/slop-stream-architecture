export const FLOOR_DB = -50;
const RELEASE_PER_S = 2.5;
const MAX_DT_S = 0.1;
const WINDOW = 1024;

export interface Level {
  read(now: number): number;
}

export interface MicLevel extends Level {
  resume(): void;
  close(): void;
}

export function levelAnalyser(ctx: BaseAudioContext): AnalyserNode {
  const analyser = ctx.createAnalyser();
  analyser.fftSize = WINDOW;
  return analyser;
}

export function levelOf(analyser: AnalyserNode): Level {
  const samples = new Float32Array(WINDOW);
  let shown = 0;
  let at = 0;
  return {
    read(now) {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const s of samples) sum += s * s;
      const rms = Math.sqrt(sum / WINDOW);
      const db = 20 * Math.log10(Math.max(rms, 1e-9));
      const target = Math.min(1, Math.max(0, 1 - db / FLOOR_DB));
      const dt = at ? Math.min(MAX_DT_S, Math.max(0, now - at) / 1000) : 0;
      at = now;
      shown = target >= shown ? target : Math.max(target, shown - RELEASE_PER_S * dt);
      return shown;
    }
  };
}

export function openMicLevel(track: MediaStreamTrack): MicLevel | null {
  if (typeof AudioContext === 'undefined') return null;
  const ctx = new AudioContext();
  const analyser = levelAnalyser(ctx);
  const source = ctx.createMediaStreamSource(new MediaStream([track]));
  source.connect(analyser);
  if (ctx.state === 'suspended') ctx.resume().catch(() => undefined);
  const level = levelOf(analyser);
  let closed = false;
  return {
    read(now) {
      return closed ? 0 : level.read(now);
    },
    resume() {
      if (!closed && ctx.state === 'suspended') ctx.resume().catch(() => undefined);
    },
    close() {
      closed = true;
      source.disconnect();
      ctx.close().catch(() => undefined);
    }
  };
}
