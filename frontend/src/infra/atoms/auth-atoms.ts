/**
 * Who is logged in. The cookie is httponly, so the page never sees it; it asks
 * /api/me once and remembers the answer. Nobody has to log in: without an
 * account you are the name in `nickAtom` (localstorage), see chat-atoms.
 */

import { atom } from 'jotai';

import { api, messageOf } from '@/infra/api';
import { store } from '@/infra/store';

/** `undefined` until /api/me has answered once, `null` for nobody. The name: what every page shows and sends. */
export const meAtom = atom<string | null | undefined>(undefined);
/** The account's id (docs/ids.md), for whoever wants it. No page does; the tests read it off /api/me. */
export const myIdAtom = atom<string | null>(null);
/** When the name last changed (rfc3339), null for never: the profile tab says when it may change again. */
export const renamedAtAtom = atom<string | null>(null);
export const authBusyAtom = atom(false);
export const authErrorAtom = atom('');

let asked: Promise<void> | null = null;

/**
 * Ask once per page load. Every caller after the first gets the same promise. A
 * failed ask (the api mid-deploy, a 502) is not an answer: the page runs as nobody
 * for now, and the next mount asks again, so a login is not lost until a hard reload.
 */
export function loadMe(): Promise<void> {
  if (!asked) {
    asked = api
      .me()
      .then((r) => {
        store.set(myIdAtom, r.id ?? null);
        store.set(renamedAtAtom, r.renamed_at ?? null);
        store.set(meAtom, r.name);
      })
      .catch(() => {
        store.set(meAtom, null);
        asked = null;
      });
  }
  return asked;
}

/** The cookie stopped working elsewhere (logged out of every device, password changed): nobody, and ask again next time. */
export function forgetMe() {
  store.set(meAtom, null);
  store.set(myIdAtom, null);
  store.set(renamedAtAtom, null);
  asked = null;
}

/** The name changed, here or on another device: ask /api/me again, now. The id is the same; the name is not. */
export function reloadMe(): Promise<void> {
  asked = null;
  return loadMe();
}

/**
 * The id and `renamed_at` of whoever just logged in: /api/login answers with the name and
 * id only. Never touches `me`: a failed ask here is not a logout, the next page load asks again.
 */
async function fillMeInfo(): Promise<void> {
  try {
    const r = await api.me();
    store.set(myIdAtom, r.id ?? null);
    store.set(renamedAtAtom, r.renamed_at ?? null);
  } catch {
    // the name is known and shown; the rest comes with the next page load
  }
}

async function attempt(call: () => Promise<{ name: string }>): Promise<boolean> {
  store.set(authBusyAtom, true);
  store.set(authErrorAtom, '');
  try {
    const r = await call();
    store.set(meAtom, r.name);
    void fillMeInfo();
    return true;
  } catch (err) {
    store.set(authErrorAtom, messageOf(err));
    return false;
  } finally {
    store.set(authBusyAtom, false);
  }
}

export function login(name: string, password: string): Promise<boolean> {
  return attempt(() => api.login(name.trim().toLowerCase(), password));
}

export function signup(name: string, password: string): Promise<boolean> {
  return attempt(() => api.signup(name.trim().toLowerCase(), password));
}

export async function logout(): Promise<void> {
  try {
    await api.logout();
  } catch {
    // the cookie is cleared by the response; a failed call still means "treat me as nobody"
  }
  store.set(meAtom, null);
  store.set(myIdAtom, null);
  store.set(renamedAtAtom, null);
}

/** Every device, this one too. The cookie is dead everywhere, so the next ask is a real one. */
export async function logoutAll(): Promise<void> {
  try {
    await api.logoutAll();
  } catch {
    // as above
  }
  forgetMe();
}

export function clearAuthError() {
  store.set(authErrorAtom, '');
}

// ---- the password, from the security tab ------------------------------------------------------

export const passwordBusyAtom = atom(false);
/** What the last try did: `changed. every other login is out`, or `not changed: <why>`. */
export const passwordStatusAtom = atom('');

/**
 * `POST /api/password`. A 204: this login stays, every other one is out, and `me` is untouched.
 * Its own status, not `authErrorAtom`: the login form and this can be on screen together.
 */
export async function changePassword(old: string, next: string): Promise<boolean> {
  store.set(passwordBusyAtom, true);
  store.set(passwordStatusAtom, '');
  try {
    await api.changePassword(old, next);
    store.set(passwordStatusAtom, 'changed. every other login of this account is out');
    return true;
  } catch (err) {
    store.set(passwordStatusAtom, `not changed: ${messageOf(err)}`);
    return false;
  } finally {
    store.set(passwordBusyAtom, false);
  }
}

export function clearPasswordStatus() {
  store.set(passwordStatusAtom, '');
}

// ---- the name, from the profile tab (docs/ids.md) ---------------------------------------------

/** How long after a change the name is fixed again. The api's number; the tab reads it off `renamed_at`. */
export const RENAME_DAYS = 30;

export const renameBusyAtom = atom(false);
/** What the last try did: `changed`, or `not changed: <why>`. */
export const renameStatusAtom = atom('');

/** The day the name may change again, or null when it may now. */
export const renameAgainAtom = atom((get) => {
  const at = get(renamedAtAtom);
  if (!at) return null;
  const again = new Date(at).getTime() + RENAME_DAYS * 86400_000;
  return again > Date.now() ? new Date(again) : null;
});

/**
 * `POST /api/name`. A 200 is the new name: `me` changes under every page, and the caller
 * tells the rest (`identityChanged`). Its own status, like the password's.
 */
export async function renameMe(name: string, password: string): Promise<boolean> {
  store.set(renameBusyAtom, true);
  store.set(renameStatusAtom, '');
  try {
    const r = await api.rename(name.trim().toLowerCase(), password);
    store.set(renamedAtAtom, r.renamed_at);
    store.set(meAtom, r.name);
    store.set(renameStatusAtom, `changed. you are ${r.name} now, everywhere you are logged in`);
    return true;
  } catch (err) {
    store.set(renameStatusAtom, `not changed: ${messageOf(err)}`);
    return false;
  } finally {
    store.set(renameBusyAtom, false);
  }
}

export function clearRenameStatus() {
  store.set(renameStatusAtom, '');
}
