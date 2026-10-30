/**
 * My profile, from anywhere: the status (one line beside the name; `bio` on the wire, since
 * `status` is the presence choice's word, docs/status.md), the picture, what my stream's page
 * shows while I am not live (the offline picture and the line under the word), and where
 * else to find me (the links, docs/socials.md), edited on my own page under the player. All saved under the name I am, which is the login, else the nick
 * lowercased (every valid nick is a valid name). The user modal's profile tab edits the
 * first three and the corner panel shows the picture. Its own atoms, not the go live page's:
 * those follow the name box there and are reset when that page is left, which would blank a
 * status being typed in the modal. The one thing the two share is the picture's version,
 * bridged below; the links are bridged to the watch page the same way, so my own page
 * follows a save.
 */

import { atom } from 'jotai';

import { api, messageOf } from '@/infra/api';
import { meAtom, reloadMe } from '@/infra/atoms/auth-atoms';
import { nickAtom, reconnectChat, refaceLines } from '@/infra/atoms/chat-atoms';
import { cropPicture } from '@/infra/atoms/crop-atoms';
import { followIdentityOnLivePage } from '@/infra/atoms/publish-atoms';
import { socialsAtom, watchNameAtom } from '@/infra/atoms/watch-atoms';
import { onEvents, reconnectEvents } from '@/infra/events';
import { cleanName, isDummyName, isValidName } from '@/infra/names';
import { AVATAR_PICTURE, OFFLINE_PICTURE } from '@/infra/picture';
import {
  cleanSocials,
  EMPTY_SOCIALS,
  kindOfUrl,
  MAX_SOCIALS,
  type SocialKind,
  type SocialLink,
  type Socials,
  socialHref,
  socialsKey,
  type SocialsLayout,
  type SocialsSize
} from '@/infra/socials';
import { store } from '@/infra/store';

/** Who I am, as a name: the login, else the nick lowercased. '' for nobody yet. */
export const myNameAtom = atom((get) => get(meAtom) ?? cleanName(get(nickAtom)));

/** The name the status and picture below belong to. The panel shows the picture only while it is mine. */
export const profileForAtom = atom('');
/** The status as typed in the box: one line about me. `bio` on the wire. */
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
/** The links as they are being edited (docs/socials.md): the whole document, the urls as typed. Saved with one press, like the status. */
export const profileSocialsAtom = atom<Socials>(EMPTY_SOCIALS);
export const profileSocialsStatusAtom = atom('');
/** The document as the api last gave or took it, as a key: the draft differs from it while there is something to save. */
const loadedSocialsAtom = atom(socialsKey(EMPTY_SOCIALS));
/** Something in the links changed since the last load or save. */
export const profileSocialsDirtyAtom = atom((get) => socialsKey(get(profileSocialsAtom)) !== get(loadedSocialsAtom));

/** The api keeps this many characters of the line, one line. The box stops there too. */
export const MAX_OFFLINE_NOTE_CHARS = 140;

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

/** Why the boxes are off, in words, for `canEditProfileAtom` false. '' while they are on. The profile tab and the page's editors say it in their status. */
export const whyNotEditAtom = atom((get) => {
  const name = get(myNameAtom);
  if (!isValidName(name)) return 'pick a name first.';
  if (isDummyName(name)) return 'a reserved name: it belongs to the fake streams, nobody writes it.';
  if (get(profileVerifiedAtom) && get(meAtom) !== name) return 'that name has an account. log in as it to change these.';
  return '';
});

let loadedBio = '';
let loadedNote = '';
let generation = 0;

/**
 * The status, pictures, offline line and links of the name I am now. Another name than last
 * time starts clean (its saved status, pictures, line and links go, so they cannot be saved
 * under the new one; text being typed stays); the same name again keeps what was loaded.
 */
export async function loadMyProfile(): Promise<void> {
  const name = store.get(myNameAtom);
  const mine = ++generation;
  if (store.get(profileForAtom) !== name) {
    if (store.get(profileBioAtom).trim() === loadedBio) store.set(profileBioAtom, '');
    if (store.get(profileOfflineNoteAtom).trim() === loadedNote) store.set(profileOfflineNoteAtom, '');
    if (socialsKey(store.get(profileSocialsAtom)) === store.get(loadedSocialsAtom)) store.set(profileSocialsAtom, EMPTY_SOCIALS);
    store.set(profileBioStatusAtom, '');
    store.set(profileAvatarStatusAtom, '');
    store.set(profileAvatarAtom, null);
    store.set(profileOfflineStatusAtom, '');
    store.set(profileOfflineAtom, null);
    store.set(profileOfflineNoteStatusAtom, '');
    store.set(profileSocialsStatusAtom, '');
    store.set(loadedSocialsAtom, socialsKey(EMPTY_SOCIALS));
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
    // the links: the api's, unless a row was added while it was answering (an untouched draft is the empty document)
    const socials = cleanSocials(p.socials);
    store.set(loadedSocialsAtom, socialsKey(socials));
    if (socialsKey(store.get(profileSocialsAtom)) === socialsKey(EMPTY_SOCIALS)) store.set(profileSocialsAtom, socials);
    store.set(profileAvatarAtom, p.avatar ?? null);
    store.set(profileOfflineAtom, p.offline ?? null);
    store.set(profileVerifiedAtom, p.verified === true);
  } catch {
    // nothing saved yet, or the api is away: the boxes stay as they are
  }
}

/** My own page open in this tab shows the links from its grant: a save shows there at once, no reload. */
function alsoOnWatchPage(name: string, saved: { socials?: Socials }) {
  if (store.get(watchNameAtom) !== name) return;
  if (saved.socials) store.set(socialsAtom, saved.socials);
}

/** The status, as typed; the api keeps it as one line, and the box shows that if nothing was typed meanwhile. */
export async function saveMyBio(): Promise<void> {
  const name = store.get(myNameAtom);
  if (!isValidName(name)) {
    store.set(profileBioStatusAtom, 'pick a name first');
    return;
  }
  store.set(profileBioStatusAtom, 'saving');
  const typed = store.get(profileBioAtom);
  try {
    const saved = await api.saveBio(name, typed.trim());
    if (store.get(profileForAtom) === name) {
      loadedBio = saved.bio;
      if (store.get(profileBioAtom) === typed) store.set(profileBioAtom, saved.bio);
    }
    store.set(profileBioStatusAtom, saved.bio ? 'saved' : 'cleared');
  } catch (err) {
    store.set(profileBioStatusAtom, `not saved: ${messageOf(err)}`);
  }
}

/** The picture: the square of the file picked in the crop dialog, as a 256x256 jpeg (infra/picture.ts). Closed without, nothing happens. */
export async function saveMyAvatar(file: File): Promise<void> {
  const name = store.get(myNameAtom);
  if (!isValidName(name)) {
    store.set(profileAvatarStatusAtom, 'pick a name first');
    return;
  }
  const jpeg = await cropPicture(file, AVATAR_PICTURE);
  if (!jpeg || store.get(myNameAtom) !== name) return;
  store.set(profileAvatarStatusAtom, 'saving');
  try {
    const saved = await api.saveAvatar(name, jpeg);
    store.set(profileAvatarAtom, saved.avatar);
    store.set(profileAvatarStatusAtom, 'saved');
    refaceLines(name, saved.avatar);
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
    refaceLines(name, null);
  } catch (err) {
    store.set(profileAvatarStatusAtom, `not removed: ${messageOf(err)}`);
  }
}

/** The offline picture: the 16:9 of the file picked in the crop dialog, as a 1280x720 jpeg, softer until it is under the api's ceiling. */
export async function saveMyOffline(file: File): Promise<void> {
  const name = store.get(myNameAtom);
  if (!isValidName(name)) {
    store.set(profileOfflineStatusAtom, 'pick a name first');
    return;
  }
  const jpeg = await cropPicture(file, OFFLINE_PICTURE);
  if (!jpeg || store.get(myNameAtom) !== name) return;
  store.set(profileOfflineStatusAtom, 'saving');
  try {
    const saved = await api.saveOffline(name, jpeg);
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

// ---- the links (docs/socials.md) ----------------------------------------------------------

/** Every edit of the draft comes through here: the document changes, and a stale `saved` goes, the status box's onChange in one place. */
function editSocials(change: (doc: Socials) => Socials) {
  store.set(profileSocialsAtom, change(store.get(profileSocialsAtom)));
  if (store.get(profileSocialsStatusAtom)) store.set(profileSocialsStatusAtom, '');
}

/** A row of that kind, with an empty url box, at the end. Nothing past the cap. Returns the row's index, for the box to take focus. */
export function addSocial(kind: SocialKind): number {
  const at = store.get(profileSocialsAtom).links.length;
  if (at >= MAX_SOCIALS) return -1;
  editSocials((doc) => ({ ...doc, links: [...doc.links, { kind, url: '', label: '' }] }));
  return at;
}

/**
 * The url or the words of row `i`, as typed. A `web` row whose url lands on a host from the
 * list takes that kind (a hint, the way the name box lowercases); a kind the owner picked stands.
 */
export function editSocial(i: number, patch: Partial<Pick<SocialLink, 'url' | 'label'>>) {
  editSocials((doc) => ({
    ...doc,
    links: doc.links.map((link, n) => {
      if (n !== i) return link;
      const next = { ...link, ...patch };
      if (patch.url !== undefined && link.kind === 'web') next.kind = kindOfUrl(socialHref(patch.url) ?? '') ?? 'web';
      return next;
    })
  }));
}

export function removeSocial(i: number) {
  editSocials((doc) => ({ ...doc, links: doc.links.filter((_, n) => n !== i) }));
}

/** The row's arrows: towards the first, or the last. Display order, so `up` is i − 1. At an end, nothing. */
export function moveSocial(i: number, dir: 'up' | 'down') {
  editSocials((doc) => {
    const links = [...doc.links];
    const j = dir === 'up' ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= links.length) return doc;
    [links[i], links[j]] = [links[j]!, links[i]!];
    return { ...doc, links };
  });
}

export function setSocialsLayout(layout: SocialsLayout) {
  editSocials((doc) => ({ ...doc, layout }));
}

export function setSocialsSize(size: SocialsSize) {
  editSocials((doc) => ({ ...doc, size }));
}

/**
 * The draft goes up whole, every url as the api takes it (`https://` put in front of a bare
 * host, the rest of about.md's rule): a row that is not a link stops the save here, named, so
 * the owner fixes that one instead of reading a 400. What comes back is what the api kept (a
 * url written the parser's way, a label cut) and the boxes show that, unless something was
 * typed meanwhile. My own page open in this tab follows at once.
 */
export async function saveMySocials(): Promise<void> {
  const name = store.get(myNameAtom);
  if (!isValidName(name)) {
    store.set(profileSocialsStatusAtom, 'pick a name first');
    return;
  }
  const draft = store.get(profileSocialsAtom);
  const links: SocialLink[] = [];
  for (const [i, link] of draft.links.entries()) {
    const url = socialHref(link.url);
    if (!url) {
      store.set(profileSocialsStatusAtom, `not saved: link ${i + 1} is not a web address`);
      return;
    }
    links.push({ kind: link.kind, url, label: link.label.trim() });
  }
  store.set(profileSocialsStatusAtom, 'saving');
  try {
    const saved = await api.saveSocials(name, { layout: draft.layout, size: draft.size, links });
    const kept = cleanSocials(saved.socials);
    if (store.get(profileForAtom) === name) {
      store.set(loadedSocialsAtom, socialsKey(kept));
      if (store.get(profileSocialsAtom) === draft) store.set(profileSocialsAtom, kept);
    }
    store.set(profileSocialsStatusAtom, kept.links.length > 0 ? 'saved' : 'cleared');
    alsoOnWatchPage(name, { socials: kept });
  } catch (err) {
    store.set(profileSocialsStatusAtom, `not saved: ${messageOf(err)}`);
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
