import { atom } from 'jotai';

import type { PictureSpec } from '@/infra/picture';
import { store } from '@/infra/store';

export interface NamedCrop {
  initial: string;
  rule: string;
  clean: (raw: string) => string;
  fault: (name: string) => string | null;
  save: (picture: Blob, name: string) => Promise<void>;
}

export interface CropRequest {
  id: number;
  file: File;
  spec: PictureSpec;
  named?: NamedCrop;
  resolve: (picture: Blob | null) => void;
}

export const cropRequestAtom = atom<CropRequest | null>(null);
let count = 0;

export function cropPicture(file: File, spec: PictureSpec): Promise<Blob | null> {
  store.get(cropRequestAtom)?.resolve(null);
  return new Promise((resolve) => store.set(cropRequestAtom, { id: ++count, file, spec, resolve }));
}

export function cropNamedPicture(file: File, spec: PictureSpec, named: NamedCrop): Promise<boolean> {
  store.get(cropRequestAtom)?.resolve(null);
  return new Promise((resolve) => store.set(cropRequestAtom, { id: ++count, file, spec, named, resolve: (picture) => resolve(picture !== null) }));
}

export function swapCropFile(id: number, file: File) {
  const request = store.get(cropRequestAtom);
  if (!request || request.id !== id) return;
  store.set(cropRequestAtom, { ...request, id: ++count, file });
}

export function answerCrop(id: number, picture: Blob | null) {
  const request = store.get(cropRequestAtom);
  if (!request || request.id !== id) return;
  store.set(cropRequestAtom, null);
  request.resolve(picture);
}
