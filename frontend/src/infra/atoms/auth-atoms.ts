/**
 * Who is logged in. The cookie is httponly, so the page never sees it; it asks
 * /api/me once and remembers the answer. Nobody has to log in: without an
 * account you are the name in `nickAtom` (localstorage), see chat-atoms.
 */

import { atom } from 'jotai';

import { api, messageOf } from '@/infra/api';
import { store } from '@/infra/store';

/** `undefined` until /api/me has answered once, `null` for nobody. */
export const meAtom = atom<string | null | undefined>(undefined);
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
      .then((r) => store.set(meAtom, r.name))
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
  asked = null;
}

async function attempt(call: () => Promise<{ name: string }>): Promise<boolean> {
  store.set(authBusyAtom, true);
  store.set(authErrorAtom, '');
  try {
    const r = await call();
    store.set(meAtom, r.name);
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
}

export function clearAuthError() {
  store.set(authErrorAtom, '');
}
