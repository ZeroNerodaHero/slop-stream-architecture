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

/**
 * A picture that goes up with a name (a group's emote): the dialog has a name box under the
 * picture, and its `save` sends both itself. A refusal (the name taken, the group full) is said in
 * the dialog, which stays open to fix it; a save that went closes it.
 */
export interface NamedCrop {
  /** The box's first words: from the file's name, made to fit `clean`. */
  initial: string;
  /** The rule under the box, while typing. */
  rule: string;
  /** What the box holds, as typed: lowercased, the characters the rule allows. */
  clean: (raw: string) => string;
  /** What is wrong with the name, or null for nothing. */
  fault: (name: string) => string | null;
  save: (picture: Blob, name: string) => Promise<void>;
}

export interface CropRequest {
  /** Tells one request from the next: the dialog remounts per request, and a late answer to an old one is nothing. */
  id: number;
  file: File;
  spec: PictureSpec;
  named?: NamedCrop;
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

/**
 * The dialog over `file` with a name box (`NamedCrop`): true once `named.save` went, false for
 * closed without.
 */
export function cropNamedPicture(file: File, spec: PictureSpec, named: NamedCrop): Promise<boolean> {
  store.get(cropRequestAtom)?.resolve(null);
  return new Promise((resolve) => store.set(cropRequestAtom, { id: ++count, file, spec, named, resolve: (picture) => resolve(picture !== null) }));
}

/**
 * `pick another image`: the open request `id` again over `file`, under a new id, so the dialog
 * remounts and starts fresh (the box as big as fits, in the middle). The same caller waits on
 * the same answer. An id that is not the open request's is nothing.
 */
export function swapCropFile(id: number, file: File) {
  const request = store.get(cropRequestAtom);
  if (!request || request.id !== id) return;
  store.set(cropRequestAtom, { ...request, id: ++count, file });
}

/** The dialog's answer to request `id`. An id that is not the open request's (answered already) is nothing. */
export function answerCrop(id: number, picture: Blob | null) {
  const request = store.get(cropRequestAtom);
  if (!request || request.id !== id) return;
  store.set(cropRequestAtom, null);
  request.resolve(picture);
}
