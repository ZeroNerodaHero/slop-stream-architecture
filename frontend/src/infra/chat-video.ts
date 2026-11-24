/** A video on a chat line (chat_videos.rs, docs/chat.md "videos"): its id and its poster's, a chat picture the api drew from a frame. */
export interface ChatVideo {
  id: string;
  poster: string;
}

/** The api's ceilings (chat_videos.rs `MAX_BYTES`, `MAX_MS`): checked here first, so a refusal costs no upload. The api measures the file itself and has the last word. */
export const MAX_VIDEO_BYTES = 10 * 1024 * 1024;
export const MAX_VIDEO_SECONDS = 30;
/** A container's rounding: a 30s recording reads 30.02. The api allows the same. */
const SLACK_SECONDS = 0.5;
/** How long the browser has to read a file's header. */
const READ_MS = 15_000;

/** Where a chat video is played from, by the id `POST /api/chat-videos` handed back. */
export function videoSrc(id: string): string {
  return `/api/chat-videos/${encodeURIComponent(id)}`;
}

/** The poster, a chat picture like any other (ChatPanel's `pictureSrc`, which this module does not import: the panel imports it). */
export function posterSrc(id: string): string {
  return `/api/chat-images/${encodeURIComponent(id)}`;
}

/** Why a chat picture or video did not load: taken down by an admin (410, or 404 for one long gone), or a group channel's or a direct message's that this viewer may not see (401, 403). Null when it was something else (the network). */
export type MediaGone = 'removed' | 'members only';

export type MediaSensitive = 'sensitive';

export function shownSrc(src: string): string {
  return `${src}?show=1`;
}

/** Asks the api why `src` did not load: an `<img>`'s error does not say. */
export async function whyGone(src: string): Promise<MediaGone | MediaSensitive | null> {
  try {
    const res = await fetch(src, { method: 'HEAD', credentials: 'same-origin' });
    if (res.status === 409) return 'sensitive';
    if (res.status === 410 || res.status === 404) return 'removed';
    if (res.status === 401 || res.status === 403) return 'members only';
  } catch {
    // the network: say nothing
  }
  return null;
}

/** A video the picker, a paste or a drop brought: anything the browser calls one, or a video's file name. */
export function isVideoFile(file: File): boolean {
  return file.type.startsWith('video/') || /\.(mp4|m4v|webm|mov|mkv|avi)$/i.test(file.name);
}

/** The two the chat takes, by the browser's type, or the name when it says none. */
function containerOf(file: File): 'video/mp4' | 'video/webm' | null {
  if (file.type === 'video/mp4' || file.type === 'video/webm') return file.type;
  if (!file.type && /\.mp4$/i.test(file.name)) return 'video/mp4';
  if (!file.type && /\.webm$/i.test(file.name)) return 'video/webm';
  return null;
}

/** Resolves when `video` fires `event`; rejects with the box's words on its error, or after `ms`. */
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
      reject(new Error('this browser cannot play that video. send an mp4 (H.264) or a webm (VP8, VP9)'));
    };
    const timer = setTimeout(() => {
      done();
      reject(new Error('could not read that video'));
    }, ms);
    video.addEventListener(event, ok);
    video.addEventListener('error', bad);
  });
}

/**
 * A video file checked before it goes up: an mp4 or a webm, 10 mb and 30 seconds at most, read
 * by a `<video>` of the page's own, so a file the api would refuse is not sent. The api reads the
 * length again itself and draws the poster (chat_videos.rs). Throws the words the box shows.
 */
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
    // a recorder's webm says Infinity until the end has been seen: seek far past it and the browser finds it
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

/** A line's `video` as the wire has it: both ids, or none (an older api leaves it off). */
export function videoOf(raw: unknown): ChatVideo | null {
  if (!raw || typeof raw !== 'object') return null;
  const { id, poster } = raw as { id?: unknown; poster?: unknown };
  return typeof id === 'string' && id && typeof poster === 'string' && poster ? { id, poster } : null;
}
