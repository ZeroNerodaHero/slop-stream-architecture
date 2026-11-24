import { atom } from 'jotai';

import { api, messageOf } from '@/infra/api';
import { meAtom, reloadMe } from '@/infra/atoms/auth-atoms';
import { nickAtom, reconnectChat, refaceLines } from '@/infra/atoms/chat-atoms';
import { cropPicture } from '@/infra/atoms/crop-atoms';
import { socialsAtom, watchNameAtom, watchWelcomeAtom } from '@/infra/atoms/watch-state';
import { type Welcome, welcomeOf } from '@/infra/atoms/welcome-atoms';
import { onEvents, reconnectEvents } from '@/infra/events';
import { cleanName, isValidName } from '@/infra/names';
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

export const myNameAtom = atom((get) => get(meAtom) ?? cleanName(get(nickAtom)));

export const profileForAtom = atom('');
export const profileBioAtom = atom('');
export const profileBioStatusAtom = atom('');
export const profileAvatarAtom = atom<number | null>(null);
export const profileAvatarStatusAtom = atom('');
export const profileVerifiedAtom = atom(false);
export const profileOfflineAtom = atom<number | null>(null);
export const profileOfflineStatusAtom = atom('');
export const profileOfflineNoteAtom = atom('');
export const profileOfflineNoteStatusAtom = atom('');
export const profileSocialsAtom = atom<Socials>(EMPTY_SOCIALS);
export const profileSocialsStatusAtom = atom('');
const loadedSocialsAtom = atom(socialsKey(EMPTY_SOCIALS));
export const profileSocialsDirtyAtom = atom((get) => socialsKey(get(profileSocialsAtom)) !== get(loadedSocialsAtom));

export const MAX_OFFLINE_NOTE_CHARS = 140;

export const profileWelcomeAtom = atom<Welcome | null>(null);
export const profileWelcomeDraftAtom = atom('');
export const profileWelcomeStatusAtom = atom('');

export const myAvatarVersionAtom = atom((get) => (get(profileForAtom) === get(myNameAtom) ? get(profileAvatarAtom) : null));
export const myOfflineVersionAtom = atom((get) => (get(profileForAtom) === get(myNameAtom) ? get(profileOfflineAtom) : null));

export const canEditProfileAtom = atom((get) => {
  const name = get(myNameAtom);
  if (!isValidName(name)) return false;
  return !get(profileVerifiedAtom) || get(meAtom) === name;
});

export const whyNotEditAtom = atom((get) => {
  const name = get(myNameAtom);
  if (!isValidName(name)) return 'pick a name first.';
  if (get(profileVerifiedAtom) && get(meAtom) !== name) return 'that name has an account. log in as it to change these.';
  return '';
});

let loadedBio = '';
let loadedNote = '';
let loadedWelcome = '';
let generation = 0;

export async function loadMyProfile(): Promise<void> {
  const name = store.get(myNameAtom);
  const mine = ++generation;
  if (store.get(profileForAtom) !== name) {
    if (store.get(profileBioAtom).trim() === loadedBio) store.set(profileBioAtom, '');
    if (store.get(profileOfflineNoteAtom).trim() === loadedNote) store.set(profileOfflineNoteAtom, '');
    if (store.get(profileWelcomeDraftAtom) === loadedWelcome) store.set(profileWelcomeDraftAtom, '');
    store.set(profileWelcomeAtom, null);
    store.set(profileWelcomeStatusAtom, '');
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
    loadedBio = loadedNote = loadedWelcome = '';
  }
  if (!isValidName(name)) return;
  try {
    const p = await api.streamer(name);
    if (mine !== generation) return;
    loadedBio = p.bio ?? '';
    if (!store.get(profileBioAtom)) store.set(profileBioAtom, loadedBio);
    loadedNote = p.offline_note ?? '';
    if (!store.get(profileOfflineNoteAtom)) store.set(profileOfflineNoteAtom, loadedNote);
    const welcome = welcomeOf(p);
    store.set(profileWelcomeAtom, welcome);
    loadedWelcome = welcome?.message ?? '';
    if (!store.get(profileWelcomeDraftAtom)) store.set(profileWelcomeDraftAtom, loadedWelcome);
    const socials = cleanSocials(p.socials);
    store.set(loadedSocialsAtom, socialsKey(socials));
    if (socialsKey(store.get(profileSocialsAtom)) === socialsKey(EMPTY_SOCIALS)) store.set(profileSocialsAtom, socials);
    store.set(profileAvatarAtom, p.avatar ?? null);
    store.set(profileOfflineAtom, p.offline ?? null);
    store.set(profileVerifiedAtom, p.verified === true);
  } catch {
  }
}

function alsoOnWatchPage(name: string, saved: { socials?: Socials; welcome?: Welcome }) {
  if (store.get(watchNameAtom) !== name) return;
  if (saved.socials) store.set(socialsAtom, saved.socials);
  if (saved.welcome) store.set(watchWelcomeAtom, saved.welcome);
}

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

export async function saveMyWelcome(on: boolean, message: string): Promise<void> {
  const name = store.get(myNameAtom);
  if (!isValidName(name)) {
    store.set(profileWelcomeStatusAtom, 'pick a name first');
    return;
  }
  store.set(profileWelcomeStatusAtom, 'saving');
  try {
    const saved = await api.saveWelcome(name, { on, message });
    const welcome = welcomeOf(saved);
    if (store.get(profileForAtom) === name && welcome) {
      store.set(profileWelcomeAtom, welcome);
      if (store.get(profileWelcomeDraftAtom) === message) store.set(profileWelcomeDraftAtom, welcome.message);
      loadedWelcome = welcome.message;
    }
    store.set(profileWelcomeStatusAtom, saved.welcome_on ? 'saved' : 'saved · off');
    if (welcome) alsoOnWatchPage(name, { welcome });
  } catch (err) {
    store.set(profileWelcomeStatusAtom, `not saved: ${messageOf(err)}`);
  }
}

function editSocials(change: (doc: Socials) => Socials) {
  store.set(profileSocialsAtom, change(store.get(profileSocialsAtom)));
  if (store.get(profileSocialsStatusAtom)) store.set(profileSocialsStatusAtom, '');
}

export function addSocial(kind: SocialKind): number {
  const at = store.get(profileSocialsAtom).links.length;
  if (at >= MAX_SOCIALS) return -1;
  editSocials((doc) => ({ ...doc, links: [...doc.links, { kind, url: '', label: '' }] }));
  return at;
}

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

export function moveSocial(from: number, to: number) {
  editSocials((doc) => {
    const link = doc.links[from];
    if (!link || to < 0 || to >= doc.links.length || to === from) return doc;
    const links = doc.links.filter((_, i) => i !== from);
    links.splice(to, 0, link);
    return { ...doc, links };
  });
}

export function setSocialsLayout(layout: SocialsLayout) {
  editSocials((doc) => ({ ...doc, layout }));
}

export function setSocialsSize(size: SocialsSize) {
  editSocials((doc) => ({ ...doc, size }));
}

export async function saveMySocials(): Promise<boolean> {
  const name = store.get(myNameAtom);
  if (!isValidName(name)) {
    store.set(profileSocialsStatusAtom, 'pick a name first');
    return false;
  }
  const draft = store.get(profileSocialsAtom);
  const links: SocialLink[] = [];
  for (const [i, link] of draft.links.entries()) {
    const url = socialHref(link.url);
    if (!url) {
      store.set(profileSocialsStatusAtom, `not saved: link ${i + 1} is not a web address`);
      return false;
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
    return true;
  } catch (err) {
    store.set(profileSocialsStatusAtom, `not saved: ${messageOf(err)}`);
    return false;
  }
}

export function identityChanged(change: 'login' | 'nick') {
  void loadMyProfile();
  if (change === 'nick') reconnectChat();
  reconnectEvents();
  if (location.pathname.replace(/\/$/, '') === '/live') void import('@/infra/atoms/publish-atoms').then((m) => m.followIdentityOnLivePage());
}

onEvents((event) => {
  if (event.type !== 'renamed' || event.name !== store.get(meAtom)) return;
  void reloadMe().then(() => identityChanged('login'));
});
