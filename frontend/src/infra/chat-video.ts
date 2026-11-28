import { HERE } from './here.ts';

export interface ChatVideo {
  id: string;
  poster: string;
}

export const MAX_VIDEO_BYTES = 10 * 1024 * 1024;
export const MAX_VIDEO_SECONDS = 30;
const SLACK_SECONDS = 0.5;
const READ_MS = 15_000;

export function videoSrc(id: string): string {
  return `/api/chat-videos/${encodeURIComponent(id)}`;
}

export function posterSrc(id: string): string {
  return `/api/chat-images/${encodeURIComponent(id)}`;
}

export type MediaGone = 'removed' | 'members only' | 'hidden';

export type MediaSensitive = 'sensitive';

export function shownSrc(src: string): string {
  return `${src}?show=1`;
}

export async function whyGone(src: string): Promise<MediaGone | MediaSensitive | null> {
  try {
    const res = await fetch(src, { method: 'HEAD', credentials: 'same-origin' });
    if (res.status === 409) return 'sensitive';
    if (res.status === 410 || res.status === 404) return 'removed';
    if (res.status === 403 && (await errorWord(src)) === 'hidden') return 'hidden';
    if (res.status === 401 || res.status === 403) return 'members only';
  } catch {
    return null;
  }
  return null;
}

async function errorWord(src: string): Promise<string | null> {
  const res = await fetch(src, { credentials: 'same-origin' });
  if (res.ok) return null;
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === 'string' ? body.error : null;
}

export function isVideoFile(file: File): boolean {
  return file.type.startsWith('video/') || /\.(mp4|m4v|webm|mov|mkv|avi)$/i.test(file.name);
}

function containerOf(file: File): 'video/mp4' | 'video/webm' | null {
  if (file.type === 'video/mp4' || file.type === 'video/webm') return file.type;
  if (!file.type && /\.mp4$/i.test(file.name)) return 'video/mp4';
  if (!file.type && /\.webm$/i.test(file.name)) return 'video/webm';
  return null;
}

function once(video: HTMLVideoElement, event: string, ms = READ_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      video.removeEventListener(event, ok);
      video.removeEventListener('error', bad);
    };
    const ok = () => {
      done();
      resolve();
    };
    const bad = () => {
      done();
      reject(new Error(`${HERE} cannot play that video. send an mp4 (H.264) or a webm (VP8, VP9)`));
    };
    const timer = setTimeout(() => {
      done();
      reject(new Error('could not read that video'));
    }, ms);
    video.addEventListener(event, ok);
    video.addEventListener('error', bad);
  });
}

export async function readVideo(file: File): Promise<{ durationMs: number }> {
  if (!containerOf(file)) throw new Error('not an mp4 or webm');
  if (file.size > MAX_VIDEO_BYTES) throw new Error('video too big. 10 mb at most');
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  try {
    const meta = once(video, 'loadedmetadata');
    video.src = url;
    await meta;
    if (!Number.isFinite(video.duration)) {
      const found = once(video, 'durationchange', 5000).catch(() => undefined);
      video.currentTime = 1e101;
      await found;
    }
    const seconds = video.duration;
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('could not tell how long that video is');
    if (seconds > MAX_VIDEO_SECONDS + SLACK_SECONDS) throw new Error(`video too long. ${MAX_VIDEO_SECONDS} seconds at most`);
    if (!video.videoWidth || !video.videoHeight) throw new Error('no picture in that video');
    return { durationMs: Math.round(seconds * 1000) };
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

export function videoOf(raw: unknown): ChatVideo | null {
  if (!raw || typeof raw !== 'object') return null;
  const { id, poster } = raw as { id?: unknown; poster?: unknown };
  return typeof id === 'string' && id && typeof poster === 'string' && poster ? { id, poster } : null;
}
