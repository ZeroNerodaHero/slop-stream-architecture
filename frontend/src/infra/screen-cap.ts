export type ScreenCap = 'native' | '1440' | '1080' | '720';

export const SCREEN_CAPS: readonly ScreenCap[] = ['native', '1440', '1080', '720'];
export const DEFAULT_SCREEN_CAP: ScreenCap = 'native';
export const SCREEN_FPS = 30;

const HEIGHTS: Record<ScreenCap, number> = { native: 2160, '1440': 1440, '1080': 1080, '720': 720 };
const WIDEST = 21 / 9;
const MOST_WIDTH = 3840;
const BASE_PIXELS = 1920 * 1080;

export const SCREEN_CAP_WORDS: Record<ScreenCap, string> = { native: 'native', '1440': '1440p', '1080': '1080p', '720': '720p' };

export function readScreenCap(raw: unknown): ScreenCap | undefined {
  return typeof raw === 'string' && (SCREEN_CAPS as readonly string[]).includes(raw) ? (raw as ScreenCap) : undefined;
}

export function capOf(cap: ScreenCap | undefined): ScreenCap {
  return cap ?? DEFAULT_SCREEN_CAP;
}

export function capBounds(cap: ScreenCap | undefined): { width: number; height: number } {
  const height = HEIGHTS[capOf(cap)];
  const width = Math.min(MOST_WIDTH, Math.round((height * WIDEST) / 2) * 2);
  return { width, height };
}

export interface ScreenConstraints extends MediaTrackConstraints {
  resizeMode?: 'none' | 'crop-and-scale';
}

export function screenConstraints(cap: ScreenCap | undefined): ScreenConstraints {
  const { width, height } = capBounds(cap);
  return { width: { max: width }, height: { max: height }, frameRate: { max: SCREEN_FPS }, resizeMode: 'crop-and-scale' };
}

export function fitWithin(width: number, height: number, cap: ScreenCap | undefined): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: Math.max(0, width), height: Math.max(0, height) };
  const bounds = capBounds(cap);
  const scale = Math.min(1, bounds.width / width, bounds.height / height);
  const even = (v: number) => Math.max(2, Math.round((v * scale) / 2) * 2);
  return scale === 1 ? { width, height } : { width: even(width), height: even(height) };
}

export function stageScreenBitrate(base: number, width: number | undefined, height: number | undefined, most: number): number {
  const pixels = (width ?? 0) * (height ?? 0);
  if (pixels <= BASE_PIXELS) return base;
  return Math.round(Math.min(most, base * Math.sqrt(pixels / BASE_PIXELS)));
}
