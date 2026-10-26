/**
 * My profile, from anywhere: the bio, the picture, and what my stream's page shows while I am
 * not live (the offline picture and the line under the word), saved under the name I am, which
 * is the login, else the nick lowercased (every valid nick is a valid name). The user modal's
 * profile tab edits it and the corner panel shows its picture. Its own atoms, not the go live
 * page's: those follow the name box there and are reset when that page is left, which would
 * blank a bio being typed in the modal. The one thing the two share is the picture's version,
 * bridged below.
 */

import { atom } from 'jotai';

import { api, messageOf } from '@/infra/api';
import { meAtom, reloadMe } from '@/infra/atoms/auth-atoms';
import { nickAtom, reconnectChat } from '@/infra/atoms/chat-atoms';
import { followIdentityOnLivePage, myAvatarAtom, squareJpeg, streamNameAtom, wideJpeg } from '@/infra/atoms/publish-atoms';
import { onEvents, reconnectEvents } from '@/infra/events';
import { cleanName, isDummyName, isValidName } from '@/infra/names';
import { store } from '@/infra/store';

/** Who I am, as a name: the login, else the nick lowercased. '' for nobody yet. */
export const myNameAtom = atom((get) => get(meAtom) ?? cleanName(get(nickAtom)));

/** The name the bio and picture below belong to. The panel shows the picture only while it is mine. */
export const profileForAtom = atom('');
export const profileBioAtom = atom('');
export const profileBioStatusAtom = atom('');
/** The picture's upload time (the `?v=` of its url). null: none. */
export const profileAvatarAtom = atom<number | null>(null);
export const profileAvatarStatusAtom = atom('');
/** The name has an account. */
export const profileVerifiedAtom = atom(false);
/** The offline picture's upload time (its `?v=`): on my stream's page where the player would be while I am not live. null: none. */
export const profileOfflineAtom = atom<number | null>(null);
export const profileOfflineStatusAtom = atom('');
/** The line under the word while I am not live, as typed in the box. */
export const profileOfflineNoteAtom = atom('');
export const profileOfflineNoteStatusAtom = atom('');

/** The api keeps this many characters of the line, one line. The box stops there too. */
export const MAX_OFFLINE_NOTE_CHARS = 140;
/** The offline picture goes up at this size, the player's shape. */
const OFFLINE_W = 1280;
const OFFLINE_H = 720;
/** The api's ceiling for it. */
const MAX_OFFLINE_BYTES = 512 * 1024;
/** Tried in order until the jpeg fits under the ceiling: a photo at 0.8 can run past it. */
const OFFLINE_QUALITIES = [0.8, 0.7, 0.6, 0.5];

/** The picture to show for me, if it has been loaded for the name I am now. */
export const myAvatarVersionAtom = atom((get) => (get(profileForAtom) === get(myNameAtom) ? get(profileAvatarAtom) : null));
/** The same for the offline picture. */
export const myOfflineVersionAtom = atom((get) => (get(profileForAtom) === get(myNameAtom) ? get(profileOfflineAtom) : null));

/**
 * The api's rule, as the page sees it: a free name is anyone's, a claimed name its login's, a
 * reserved one the fake streams'. Known before a save, so the boxes can say why instead of a 403.
 */
export const canEditProfileAtom = atom((get) => {
  const name = get(myNameAtom);
  if (!isValidName(name) || isDummyName(name)) return false;
  return !get(profileVerifiedAtom) || get(meAtom) === name;
});

let loadedBio = '';
let loadedNote = '';
let generation = 0;

/**
 * The bio, pictures and offline line of the name I am now. Another name than last time starts
 * clean (its saved bio, pictures and line go, so they cannot be saved under the new one; text
 * being typed stays); the same name again keeps what was loaded.
 */
export async function loadMyProfile(): Promise<void> {
  const name = store.get(myNameAtom);
  const mine = ++generation;
  if (store.get(profileForAtom) !== name) {
    if (store.get(profileBioAtom).trim() === loadedBio) store.set(profileBioAtom, '');
    if (store.get(profileOfflineNoteAtom).trim() === loadedNote) store.set(profileOfflineNoteAtom, '');
    store.set(profileBioStatusAtom, '');
    store.set(profileAvatarStatusAtom, '');
    store.set(profileAvatarAtom, null);
    store.set(profileOfflineStatusAtom, '');
    store.set(profileOfflineAtom, null);
    store.set(profileOfflineNoteStatusAtom, '');
    store.set(profileVerifiedAtom, false);
    store.set(profileForAtom, name);
    loadedBio = loadedNote = '';
  }
  if (!isValidName(name)) return;
  try {
    const p = await api.streamer(name);
    if (mine !== generation) return; // the name moved on while the api was answering
    loadedBio = p.bio ?? '';
    if (!store.get(profileBioAtom)) store.set(profileBioAtom, loadedBio);
    loadedNote = p.offline_note ?? '';
    if (!store.get(profileOfflineNoteAtom)) store.set(profileOfflineNoteAtom, loadedNote);
    store.set(profileAvatarAtom, p.avatar ?? null);
    store.set(profileOfflineAtom, p.offline ?? null);
    store.set(profileVerifiedAtom, p.verified === true);
  } catch {
    // nothing saved yet, or the api is away: the boxes stay as they are
  }
}

/** The go live page shows the same picture from the same (day-cached) url: keep its version in step. */
function alsoOnLivePage(name: string, version: number | null) {
  if (store.get(streamNameAtom) === name) store.set(myAvatarAtom, version);
}

export async function saveMyBio(): Promise<void> {
  const name = store.get(myNameAtom);
  if (!isValidName(name)) {
    store.set(profileBioStatusAtom, 'pick a name first');
    return;
  }
  store.set(profileBioStatusAtom, 'saving');
  try {
    const saved = await api.saveBio(name, store.get(profileBioAtom).trim());
    if (store.get(profileForAtom) === name) loadedBio = saved.bio;
    store.set(profileBioStatusAtom, 'saved');
  } catch (err) {
    store.set(profileBioStatusAtom, `not saved: ${messageOf(err)}`);
  }
}

export async function saveMyAvatar(file: File): Promise<void> {
  const name = store.get(myNameAtom);
  if (!isValidName(name)) {
    store.set(profileAvatarStatusAtom, 'pick a name first');
    return;
  }
  store.set(profileAvatarStatusAtom, 'saving');
  try {
    const saved = await api.saveAvatar(name, await squareJpeg(file));
    store.set(profileAvatarAtom, saved.avatar);
    store.set(profileAvatarStatusAtom, 'saved');
    alsoOnLivePage(name, saved.avatar);
  } catch (err) {
    store.set(profileAvatarStatusAtom, `not saved: ${messageOf(err)}`);
  }
}

export async function removeMyAvatar(): Promise<void> {
  const name = store.get(myNameAtom);
  if (!isValidName(name)) return;
  try {
    await api.deleteAvatar(name);
    store.set(profileAvatarAtom, null);
    store.set(profileAvatarStatusAtom, 'removed');
    alsoOnLivePage(name, null);
  } catch (err) {
    store.set(profileAvatarStatusAtom, `not removed: ${messageOf(err)}`);
  }
}

/** The offline picture as the api takes it: the middle 16:9 at 1280x720, encoded softer until it is under the ceiling. */
async function offlineJpeg(file: File): Promise<Blob> {
  for (const quality of OFFLINE_QUALITIES) {
    const jpeg = await wideJpeg(file, OFFLINE_W, OFFLINE_H, quality);
    if (jpeg.size <= MAX_OFFLINE_BYTES) return jpeg;
  }
  throw new Error('too much detail for 512 kb. try a plainer picture');
}

export async function saveMyOffline(file: File): Promise<void> {
  const name = store.get(myNameAtom);
  if (!isValidName(name)) {
    store.set(profileOfflineStatusAtom, 'pick a name first');
    return;
  }
  store.set(profileOfflineStatusAtom, 'saving');
  try {
    const saved = await api.saveOffline(name, await offlineJpeg(file));
    store.set(profileOfflineAtom, saved.offline);
    store.set(profileOfflineStatusAtom, 'saved');
  } catch (err) {
    store.set(profileOfflineStatusAtom, `not saved: ${messageOf(err)}`);
  }
}

export async function removeMyOffline(): Promise<void> {
  const name = store.get(myNameAtom);
  if (!isValidName(name)) return;
  try {
    await api.deleteOffline(name);
    store.set(profileOfflineAtom, null);
    store.set(profileOfflineStatusAtom, 'removed');
  } catch (err) {
    store.set(profileOfflineStatusAtom, `not removed: ${messageOf(err)}`);
  }
}

/** The box as typed goes up; the api keeps it as one line, and the box shows that if nothing was typed meanwhile. */
export async function saveMyOfflineNote(): Promise<void> {
  const name = store.get(myNameAtom);
  if (!isValidName(name)) {
    store.set(profileOfflineNoteStatusAtom, 'pick a name first');
    return;
  }
  store.set(profileOfflineNoteStatusAtom, 'saving');
  const typed = store.get(profileOfflineNoteAtom);
  try {
    const saved = await api.saveOfflineNote(name, typed);
    if (store.get(profileForAtom) === name) {
      loadedNote = saved.offline_note;
      if (store.get(profileOfflineNoteAtom) === typed) store.set(profileOfflineNoteAtom, saved.offline_note);
    }
    store.set(profileOfflineNoteStatusAtom, saved.offline_note ? 'saved' : 'cleared');
  } catch (err) {
    store.set(profileOfflineNoteStatusAtom, `not saved: ${messageOf(err)}`);
  }
}

/**
 * I am somebody else now. The profile reloads for the new name and the go live page's name
 * box follows. After a login or a logout that is all: the chat panel reconnects on its own
 * when `me` changes. After a committed new nick (`was` the one before), the chat is told once
 * here, never per keystroke: a reconnect replaces the history and blips the count for the
 * whole room; and the name box follows only if it still held the old nick.
 */
export function identityChanged(change: 'login' | 'nick', was?: string) {
  void loadMyProfile();
  if (change === 'nick') reconnectChat();
  // the events socket is who the browser is: a login or logout changes that too, not only a nick
  reconnectEvents();
  followIdentityOnLivePage(change === 'nick' ? was : undefined);
}

// my name changed on another device, or in another tab of this browser (the tab that did it
// already knows: `renameMe` set `me` first, so the frame names a name that is not mine any
// more and is ignored there). /api/me again, then everything an identity change brings.
// see docs/ids.md
onEvents((event) => {
  if (event.type !== 'renamed' || event.name !== store.get(meAtom)) return;
  void reloadMe().then(() => identityChanged('login'));
});
