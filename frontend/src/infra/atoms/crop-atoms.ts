/**
 * The crop dialog's one request: the file somebody picked and what the upload wants of it.
 * `cropPicture` is the whole exchange for the actions that save a picture: it opens the dialog
 * (CropDialog.tsx, mounted by the Shell) and answers with the bytes to send, or null when the
 * dialog was closed without. The action sets its own `saving` after that, so the status line
 * stays quiet while the dialog is open.
 */

import { atom } from 'jotai';

import type { PictureSpec } from '@/infra/picture';
import { store } from '@/infra/store';

export interface CropRequest {
  /** Tells one request from the next: the dialog remounts per request, and a late answer to an old one is nothing. */
  id: number;
  file: File;
  spec: PictureSpec;
  resolve: (picture: Blob | null) => void;
}

export const cropRequestAtom = atom<CropRequest | null>(null);
let count = 0;

/**
 * The dialog over `file`: what is inside the rectangle, made the way `spec` says, or null for
 * closed without. One at a time: a request on top of an unanswered one closes that one as a no.
 */
export function cropPicture(file: File, spec: PictureSpec): Promise<Blob | null> {
  store.get(cropRequestAtom)?.resolve(null);
  return new Promise((resolve) => store.set(cropRequestAtom, { id: ++count, file, spec, resolve }));
}

/** The dialog's answer to request `id`. An id that is not the open request's (answered already) is nothing. */
export function answerCrop(id: number, picture: Blob | null) {
  const request = store.get(cropRequestAtom);
  if (!request || request.id !== id) return;
  store.set(cropRequestAtom, null);
  request.resolve(picture);
}
