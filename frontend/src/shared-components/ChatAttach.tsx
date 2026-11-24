import { RiCloseLine, RiErrorWarningFill, RiLoader4Line, RiPlayFill } from '@remixicon/react';
import { type ClipboardEvent, type DragEvent } from 'react';

import type { PendingClip, PendingPicture } from '@/infra/chat-attach';
import { isVideoFile } from '@/infra/chat-video';
import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

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

function Busy() {
  return (
    <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
      <RiLoader4Line aria-hidden size={18} className="text-white motion-safe:animate-spin" />
      <span className="sr-only">uploading</span>
    </span>
  );
}

function Failed({ error }: { error: string }) {
  return (
    <span className="absolute bottom-0.5 left-0.5 flex">
      <Tooltip content={error}>
        <span role="img" aria-label={error} className="flex h-5 w-5 items-center justify-center bg-decrease text-white">
          <RiErrorWarningFill aria-hidden size={14} />
        </span>
      </Tooltip>
    </span>
  );
}

function Remove({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <Tooltip content="remove">
      <button type="button" aria-label={label} className="absolute right-0.5 top-0.5 flex h-5 w-5 items-center justify-center bg-black/70 text-white" onClick={onRemove}>
        <RiCloseLine aria-hidden size={14} />
      </button>
    </Tooltip>
  );
}

export function PendingThumb({ picture, sending, onRemove, size = 'h-20 w-20' }: { picture: PendingPicture; sending: boolean; onRemove: () => void; size?: string }) {
  const failed = picture.status === 'error';
  const busy = !failed && (picture.status === 'uploading' || sending);
  return (
    <span data-status={picture.status} data-picture={picture.id} className={cn('relative', size, failed && 'outline outline-1 outline-decrease')}>
      <img src={picture.previewUrl} alt="" className={cn('h-full w-full object-cover', busy && 'opacity-60')} />
      {busy && <Busy />}
      {failed && <Failed error={picture.error ?? 'that picture did not go up'} />}
      <Remove label="remove picture" onRemove={onRemove} />
    </span>
  );
}

export function PendingVideo({
  clip,
  sending,
  onRemove,
  idPrefix = 'chat',
  size = 'h-20 w-20'
}: {
  clip: PendingClip;
  sending: boolean;
  onRemove: () => void;
  idPrefix?: string;
  size?: string;
}) {
  const failed = clip.status === 'error';
  const uploading = clip.status === 'uploading';
  const busy = !failed && (uploading || sending);
  const percent = Math.round(clip.progress * 100);
  return (
    <span
      id={`${idPrefix}-video-preview`}
      data-status={clip.status}
      data-video={clip.video?.id}
      className={cn('relative', size, failed && 'outline outline-1 outline-decrease')}
    >
      <video src={clip.previewUrl} muted playsInline preload="metadata" className={cn('h-full w-full object-cover', busy && 'opacity-60')} />
      {busy ? (
        <Busy />
      ) : (
        <span aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="flex h-7 w-7 items-center justify-center bg-black/70 text-white">
            <RiPlayFill size={16} />
          </span>
        </span>
      )}
      {uploading && (
        <span
          id={`${idPrefix}-video-progress`}
          data-progress={percent}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-label="video sent"
          className="absolute inset-x-0 bottom-0 h-0.5"
        >
          <span className="absolute inset-y-0 left-0 bg-primaryBlue transition-[width] duration-150" style={{ width: `${percent}%` }} />
        </span>
      )}
      {failed && <Failed error={clip.error ?? 'that video did not go up'} />}
      <Remove label="remove video" onRemove={onRemove} />
    </span>
  );
}
