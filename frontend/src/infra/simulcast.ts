export type Rid = 'q' | 'h' | 'f';

export interface Layer {
  rid: Rid;
  active: boolean;
  scaleResolutionDownBy: number;
  maxBitrate: number;
  maxFramerate: number;
}

export interface Top {
  height: number;
  maxBitrate: number;
}

export interface Encoding {
  rid?: string;
  active?: boolean;
  scaleResolutionDownBy?: number;
  maxBitrate?: number;
  maxFramerate?: number;
}

export const RIDS: readonly Rid[] = ['q', 'h', 'f'];
export const TOP_HEIGHT = 1080;
export const MAX_FRAMERATE = 30;
export const SINGLE_HEIGHT = 720;
export const SINGLE_BITRATE = 2_500_000;
const UNKNOWN_HEIGHT = 720;
const DIVIDE: Record<Rid, number> = { q: 3, h: 1.5, f: 1 };
const MIN_HEIGHT: Record<Rid, number> = { q: 180, h: 240, f: 0 };
const SHARE_OF_TOP: Record<Rid, number> = { q: 0.15, h: 0.45, f: 1 };
const MIN_LAYER_BITRATE = 60_000;
const RATES: readonly (readonly [number, number])[] = [
  [180, 150_000],
  [360, 500_000],
  [540, 800_000],
  [720, 1_200_000],
  [1080, 2_500_000]
];

export function bitrateFor(height: number): number {
  const first = RATES[0]!;
  const last = RATES[RATES.length - 1]!;
  if (height <= first[0]) return first[1];
  if (height >= last[0]) return last[1];
  for (let i = 1; i < RATES.length; i++) {
    const [h1, r1] = RATES[i]!;
    const [h0, r0] = RATES[i - 1]!;
    if (height <= h1) return Math.round(r0 + ((r1 - r0) * (height - h0)) / (h1 - h0));
  }
  return last[1];
}

function sourceOf(height: number | undefined): number {
  return height && height > 0 ? height : UNKNOWN_HEIGHT;
}

export function cameraLayers(sourceHeight: number | undefined, top?: Top): Layer[] {
  const source = sourceOf(sourceHeight);
  const topHeight = Math.max(1, Math.min(source, top?.height ?? TOP_HEIGHT));
  const topScale = source / topHeight;
  return RIDS.map((rid) => {
    const height = topHeight / DIVIDE[rid];
    const active = rid === 'f' || height >= MIN_HEIGHT[rid];
    let maxBitrate: number;
    if (rid === 'f') maxBitrate = top?.maxBitrate ?? bitrateFor(height);
    else if (top) maxBitrate = Math.max(MIN_LAYER_BITRATE, Math.round(top.maxBitrate * SHARE_OF_TOP[rid]));
    else maxBitrate = bitrateFor(height);
    return { rid, active, scaleResolutionDownBy: topScale * DIVIDE[rid], maxBitrate, maxFramerate: MAX_FRAMERATE };
  });
}

export function singleLayer(sourceHeight: number | undefined, top?: Top): Omit<Layer, 'rid' | 'active'> {
  const source = sourceOf(sourceHeight);
  const height = Math.max(1, Math.min(source, top?.height ?? SINGLE_HEIGHT));
  return { scaleResolutionDownBy: source / height, maxBitrate: top?.maxBitrate ?? SINGLE_BITRATE, maxFramerate: MAX_FRAMERATE };
}

export function sendEncodings(sourceHeight: number | undefined): Encoding[] {
  return cameraLayers(sourceHeight).map(({ rid, active, scaleResolutionDownBy, maxBitrate, maxFramerate }) => ({ rid, active, scaleResolutionDownBy, maxBitrate, maxFramerate }));
}

export function applyLayers(encodings: Encoding[], sourceHeight: number | undefined, top?: Top): number {
  if (encodings.length === 1) {
    const one = singleLayer(sourceHeight, top);
    encodings[0]!.scaleResolutionDownBy = one.scaleResolutionDownBy;
    encodings[0]!.maxBitrate = one.maxBitrate;
    encodings[0]!.maxFramerate = one.maxFramerate;
    return one.maxBitrate;
  }
  const layers = cameraLayers(sourceHeight, top);
  let total = 0;
  for (const encoding of encodings) {
    const layer = layers.find((l) => l.rid === encoding.rid);
    if (!layer) continue;
    encoding.active = layer.active;
    encoding.scaleResolutionDownBy = layer.scaleResolutionDownBy;
    encoding.maxBitrate = layer.maxBitrate;
    encoding.maxFramerate = layer.maxFramerate;
    if (layer.active) total += layer.maxBitrate;
  }
  return total;
}
