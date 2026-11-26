export const QUIET = 0.2;
export const LOUD = 0.7;
export const SPEAKING = 0.1;
export const PULSE_GROW = 0.25;
export const PULSE_ATTACK_MS = 60;
export const PULSE_RELEASE_MS = 200;
const MAX_DT_MS = 100;
const SNAP = 0.002;

export function voiceOf(level: number): number {
  return Math.min(1, Math.max(0, (level - QUIET) / (LOUD - QUIET)));
}

export function isSpeaking(voice: number): boolean {
  return voice > SPEAKING;
}

export function pulseTarget(voice: number): number {
  return isSpeaking(voice) ? 1 + PULSE_GROW * Math.min(1, voice) : 1;
}

export function pulseStep(scale: number, target: number, dtMs: number): number {
  const dt = Math.min(MAX_DT_MS, Math.max(0, dtMs));
  const tau = target > scale ? PULSE_ATTACK_MS : PULSE_RELEASE_MS;
  const next = scale + (target - scale) * (1 - Math.exp(-dt / tau));
  const capped = Math.min(1 + PULSE_GROW, Math.max(1, next));
  return Math.abs(capped - target) < SNAP ? target : capped;
}
