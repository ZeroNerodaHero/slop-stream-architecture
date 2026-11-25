import type { StreamStats } from '../stream-stats.ts';

const fixed = (v: number | null, digits: number) => (v === null || !Number.isFinite(v) ? '-' : v.toFixed(digits));

export function liveHeader(stats: StreamStats | null): string | null {
  if (!stats) return null;
  const v = stats.video;
  return [v.width && v.height ? `${v.width}x${v.height}` : '', `dropped ${fixed(v.droppedPerSec, 1)}/s`, stats.path ?? ''].filter(Boolean).join(' · ');
}

export function hoverWords(at: number, stream: string): string {
  return [new Date(at).toLocaleTimeString(), stream].filter(Boolean).join(' · ');
}
