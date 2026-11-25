import type { Codec } from './simulcast.ts';

export interface CodecEntry {
  mimeType: string;
  sdpFmtpLine?: string;
}

export interface EncodeVerdict {
  supported: boolean;
  smooth: boolean;
  powerEfficient: boolean;
}

export interface CodecProbe {
  codecs: readonly CodecEntry[];
  encodingInfo?: (config: MediaEncodingConfiguration) => Promise<EncodeVerdict>;
  cores: number;
}

export const VP9_PROBE: MediaEncodingConfiguration = {
  type: 'webrtc',
  video: { contentType: 'video/VP9', width: 1920, height: 1080, bitrate: 1_750_000, framerate: 30 }
};
export const MIN_SOFTWARE_CORES = 4;

const isVp8 = (c: CodecEntry) => /^video\/vp8$/i.test(c.mimeType);
const isVp9 = (c: CodecEntry) => /^video\/vp9$/i.test(c.mimeType);
const isRtx = (c: CodecEntry) => /^video\/rtx$/i.test(c.mimeType);

export function isVp9Profile0(c: CodecEntry): boolean {
  if (!isVp9(c)) return false;
  const profile = (c.sdpFmtpLine ?? '')
    .split(';')
    .map((p) => p.trim())
    .find((p) => p.startsWith('profile-id='));
  return !profile || profile === 'profile-id=0';
}

export function vp9First<T extends CodecEntry>(codecs: readonly T[]): T[] {
  return [...codecs.filter(isVp9Profile0), ...codecs.filter((c) => !isVp9(c))];
}

export function vp8Only<T extends CodecEntry>(codecs: readonly T[]): T[] {
  return codecs.filter((c) => isVp8(c) || isRtx(c));
}

export async function pickCodec(probe: CodecProbe): Promise<Codec> {
  if (!probe.codecs.some(isVp9Profile0) || !probe.codecs.some(isVp8) || !probe.encodingInfo) return 'vp8';
  try {
    const verdict = await probe.encodingInfo(VP9_PROBE);
    if (!verdict.supported) return 'vp8';
    return verdict.powerEfficient || (verdict.smooth && probe.cores >= MIN_SOFTWARE_CORES) ? 'vp9' : 'vp8';
  } catch {
    return 'vp8';
  }
}

export function canSteerCodecs(): boolean {
  return typeof RTCRtpTransceiver !== 'undefined' && typeof RTCRtpTransceiver.prototype.setCodecPreferences === 'function';
}

function browserProbe(): CodecProbe {
  const capabilities = typeof RTCRtpSender !== 'undefined' && typeof RTCRtpSender.getCapabilities === 'function' ? RTCRtpSender.getCapabilities('video') : null;
  const info = typeof navigator !== 'undefined' ? navigator.mediaCapabilities : undefined;
  return {
    codecs: canSteerCodecs() ? (capabilities?.codecs ?? []) : [],
    encodingInfo: info?.encodingInfo ? (config) => info.encodingInfo(config) : undefined,
    cores: typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 0 : 0
  };
}

let chosen: Promise<Codec> | null = null;

export function cameraCodec(): Promise<Codec> {
  chosen ??= pickCodec(browserProbe());
  return chosen;
}
