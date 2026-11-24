import { RiCloseLine, RiPlayFill } from '@remixicon/react';
import { type ClipboardEvent, type DragEvent, useState } from 'react';

import { api, messageOf } from '@/infra/api';
import { type ChatVideo, isVideoFile, posterSrc, readVideo } from '@/infra/chat-video';
import { Tooltip } from '@/shared-components/Tooltip';

export const ATTACH_ACCEPT = 'image/*,video/mp4,video/webm,video/*';

export const STREAM_CHAT_VIDEO = false;
export const STREAM_VIDEO_OFF = 'videos are off in stream chat for now';
export const PICTURE_ACCEPT = 'image/*';

export function filesOf(data: DataTransfer | null): File[] {
  return data ? [...data.files] : [];
}

export function splitFiles(files: File[]): { pictures: File[]; videos: File[] } {
  return { pictures: files.filter((f) => !isVideoFile(f)), videos: files.filter(isVideoFile) };
}

export function dragFiles(e: DragEvent) {
  if (![...e.dataTransfer.types].includes('Files')) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
}

export function dropFiles(e: DragEvent, take: (files: File[]) => void) {
  const files = filesOf(e.dataTransfer);
  if (files.length === 0) return;
  e.preventDefault();
  take(files);
}

export function pasteFiles(e: ClipboardEvent, take: (files: File[]) => void) {
  const files = filesOf(e.clipboardData);
  if (files.length === 0) return;
  e.preventDefault();
  take(files);
}

export function useVideoUpload() {
  const [progress, setProgress] = useState<number | null>(null);
  async function upload(file: File, done: (video: ChatVideo) => void, fail: (words: string) => void) {
    if (progress !== null) return;
    setProgress(0);
    try {
      await readVideo(file);
      const saved = await api.uploadChatVideo(file, setProgress);
      done({ id: saved.id, poster: saved.poster });
    } catch (err) {
      fail(messageOf(err));
    } finally {
      setProgress(null);
    }
  }
  return { progress, upload };
}

export function VideoProgress({ progress, idPrefix = 'chat' }: { progress: number; idPrefix?: string }) {
  const percent = Math.round(progress * 100);
  return (
    <div id={`${idPrefix}-video-progress`} data-progress={percent} className="mb-2 flex items-center gap-2 text-xs text-textSecondary" aria-live="polite">
      <span className="shrink-0">{percent === 0 ? 'reading the video…' : `sending the video ${percent}%`}</span>
      <span
        className="relative h-1.5 min-w-0 flex-1 overflow-hidden bg-backgroundTertiary"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-label="video sent"
      >
        <span className="absolute inset-y-0 left-0 bg-primaryBlue transition-[width] duration-150" style={{ width: `${percent}%` }} />
      </span>
    </div>
  );
}

export function PendingVideo({ video, onRemove, idPrefix = 'chat' }: { video: ChatVideo; onRemove: () => void; idPrefix?: string }) {
  return (
    <span id={`${idPrefix}-video-preview`} data-video={video.id} className="relative">
      <img src={posterSrc(video.poster)} alt="" className="h-20 w-20 object-cover" />
      <span aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <span className="flex h-7 w-7 items-center justify-center bg-black/70 text-white">
          <RiPlayFill size={16} />
        </span>
      </span>
      <Tooltip content="remove">
        <button
          type="button"
          aria-label="remove video"
          className="absolute right-0.5 top-0.5 flex h-5 w-5 items-center justify-center bg-black/70 text-white"
          onClick={onRemove}
        >
          <RiCloseLine aria-hidden size={14} />
        </button>
      </Tooltip>
    </span>
  );
}
