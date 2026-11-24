import { atom, type Atom, type PrimitiveAtom } from 'jotai';

import { api, messageOf } from '@/infra/api';
import { type ChatVideo, readVideo } from '@/infra/chat-video';
import { compressChatImage } from '@/infra/picture';
import { store } from '@/infra/store';

export const MAX_CHAT_IMAGES = 10;
export const MODERATION_REJECTED = 'image rejected by moderation';
export const MODERATION_UNCHECKED = 'this picture was never checked, send it again';
const MODERATION_WORDS = 'have sex incel?';

export function wordsOf(text: string): string {
  return text === MODERATION_REJECTED ? MODERATION_WORDS : text;
}

export function isPictureRefusal(error: string): boolean {
  return error === MODERATION_REJECTED || error === MODERATION_UNCHECKED;
}

export type AttachStatus = 'uploading' | 'ready' | 'error';

export interface PendingPicture {
  key: string;
  file: File;
  previewUrl: string;
  status: AttachStatus;
  id?: string;
  error?: string;
}

export interface PendingClip {
  key: string;
  file: File;
  previewUrl: string;
  status: AttachStatus;
  video?: ChatVideo;
  error?: string;
  progress: number;
}

export interface Attached {
  pictures: PendingPicture[];
  video: PendingClip | null;
}

export async function uploadVideo(file: File, onProgress: (sent: number) => void): Promise<ChatVideo> {
  await readVideo(file);
  const saved = await api.uploadChatVideo(file, onProgress);
  return { id: saved.id, poster: saved.poster };
}

export function releaseAttached({ pictures, video }: Attached) {
  for (const picture of pictures) URL.revokeObjectURL(picture.previewUrl);
  if (video) URL.revokeObjectURL(video.previewUrl);
}

export class Attachments {
  readonly picturesAtom: PrimitiveAtom<PendingPicture[]> = atom<PendingPicture[]>([]);
  readonly videoAtom: PrimitiveAtom<PendingClip | null> = atom<PendingClip | null>(null);
  readonly readyIdsAtom: Atom<string[]>;
  readonly anyAtom: Atom<boolean>;

  private uploads = new Map<string, Promise<void>>();
  private notice: (text: string) => void;

  constructor(notice: (text: string) => void) {
    this.notice = notice;
    const pictures = this.picturesAtom;
    const video = this.videoAtom;
    this.readyIdsAtom = atom((get) => idsOf(get(pictures)));
    this.anyAtom = atom((get) => get(pictures).length > 0 || get(video) !== null);
  }

  pictures(): PendingPicture[] {
    return store.get(this.picturesAtom);
  }

  video(): PendingClip | null {
    return store.get(this.videoAtom);
  }

  any(): boolean {
    return this.pictures().length > 0 || this.video() !== null;
  }

  addPictures(files: File[]) {
    if (files.length === 0) return;
    const now = this.pictures();
    const left = Math.max(0, MAX_CHAT_IMAGES - now.length);
    if (files.length > left) this.notice(`${MAX_CHAT_IMAGES} pictures at most`);
    const added = files.slice(0, left).map((file): PendingPicture => ({ key: crypto.randomUUID(), file, previewUrl: URL.createObjectURL(file), status: 'uploading' }));
    if (added.length === 0) return;
    store.set(this.picturesAtom, [...now, ...added]);
    for (const picture of added) this.startUpload(picture.key);
  }

  removePicture(key: string) {
    const now = this.pictures();
    const gone = now.find((p) => p.key === key);
    if (!gone) return;
    URL.revokeObjectURL(gone.previewUrl);
    this.uploads.delete(key);
    store.set(
      this.picturesAtom,
      now.filter((p) => p.key !== key)
    );
  }

  addVideo(file: File, many = false) {
    if (this.video() || many) this.notice('one video at a time');
    if (this.video()) return;
    const clip: PendingClip = { key: crypto.randomUUID(), file, previewUrl: URL.createObjectURL(file), status: 'uploading', progress: 0 };
    store.set(this.videoAtom, clip);
    this.startVideo(clip.key);
  }

  removeVideo() {
    const clip = this.video();
    if (!clip) return;
    URL.revokeObjectURL(clip.previewUrl);
    this.uploads.delete(clip.key);
    store.set(this.videoAtom, null);
  }

  async settle() {
    for (;;) {
      const waits = [...this.pictures().map((p) => p.key), this.video()?.key]
        .map((key) => (key ? this.uploads.get(key) : undefined))
        .filter((p): p is Promise<void> => p !== undefined);
      if (waits.length === 0) return;
      await Promise.allSettled(waits);
    }
  }

  errorOf(): string | null {
    const bad = this.pictures().find((p) => p.status === 'error');
    if (bad) return bad.error ?? 'that picture did not go up';
    const clip = this.video();
    if (clip?.status === 'error') return clip.error ?? 'that video did not go up';
    return null;
  }

  take(): Attached {
    const taken = { pictures: this.pictures(), video: this.video() };
    store.set(this.picturesAtom, []);
    store.set(this.videoAtom, null);
    return taken;
  }

  drop(taken: Attached) {
    const keys = new Set(taken.pictures.map((p) => p.key));
    const left = this.pictures().filter((p) => !keys.has(p.key));
    if (left.length !== this.pictures().length) store.set(this.picturesAtom, left);
    if (taken.video && this.video()?.key === taken.video.key) store.set(this.videoAtom, null);
    releaseAttached(taken);
  }

  restore(lost: Attached, error: string | null = null) {
    const marked = error ? lost.pictures.map((p): PendingPicture => ({ ...p, status: 'error', error: wordsOf(error) })) : lost.pictures;
    if (lost.pictures.length > 0 && this.pictures().length === 0) store.set(this.picturesAtom, marked);
    else for (const picture of lost.pictures) URL.revokeObjectURL(picture.previewUrl);
    if (lost.video && !this.video()) store.set(this.videoAtom, lost.video);
    else if (lost.video) URL.revokeObjectURL(lost.video.previewUrl);
  }

  markPictures(error: string) {
    const words = wordsOf(error);
    store.set(
      this.picturesAtom,
      this.pictures().map((p): PendingPicture => ({ ...p, status: 'error', error: words }))
    );
  }

  clear() {
    releaseAttached(this.take());
    this.uploads.clear();
  }

  private startUpload(key: string) {
    const picture = this.pictures().find((p) => p.key === key);
    if (!picture) return;
    const run: Promise<void> = compressChatImage(picture.file)
      .then((blob) => api.uploadChatImage(blob))
      .then(
        (saved) => this.patchPicture(key, { status: 'ready', id: saved.id, error: undefined }),
        (err: unknown) => this.patchPicture(key, { status: 'error', error: wordsOf(messageOf(err)) })
      )
      .finally(() => {
        if (this.uploads.get(key) === run) this.uploads.delete(key);
      });
    this.uploads.set(key, run);
  }

  private startVideo(key: string) {
    const clip = this.video();
    if (!clip || clip.key !== key) return;
    const run: Promise<void> = uploadVideo(clip.file, (progress) => this.patchVideo(key, { progress }))
      .then(
        (video) => this.patchVideo(key, { status: 'ready', video, progress: 1, error: undefined }),
        (err: unknown) => this.patchVideo(key, { status: 'error', error: wordsOf(messageOf(err)) })
      )
      .finally(() => {
        if (this.uploads.get(key) === run) this.uploads.delete(key);
      });
    this.uploads.set(key, run);
  }

  private patchPicture(key: string, patch: Partial<PendingPicture>) {
    const now = this.pictures();
    if (!now.some((p) => p.key === key)) return;
    store.set(
      this.picturesAtom,
      now.map((p) => (p.key === key ? { ...p, ...patch } : p))
    );
  }

  private patchVideo(key: string, patch: Partial<PendingClip>) {
    const clip = this.video();
    if (!clip || clip.key !== key) return;
    store.set(this.videoAtom, { ...clip, ...patch });
  }
}

export function idsOf(pictures: PendingPicture[]): string[] {
  return pictures.flatMap((p) => (p.status === 'ready' && p.id ? [p.id] : []));
}
