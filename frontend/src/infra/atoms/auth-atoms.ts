import { atom } from 'jotai';

import { api, type MeInfo, messageOf, type OAuthProvider } from '@/infra/api';
import { store } from '@/infra/store';

export const meAtom = atom<string | null | undefined>(undefined);
export const myIdAtom = atom<string | null>(null);
export const renamedAtAtom = atom<string | null>(null);
export const hasPasswordAtom = atom(true);
export const heldNamesAtom = atom<string[]>([]);
export const oauthVerifiedAtom = atom(false);

function setMeInfo(r: MeInfo) {
  store.set(myIdAtom, r.id ?? null);
  store.set(renamedAtAtom, r.renamed_at ?? null);
  store.set(hasPasswordAtom, r.has_password !== false);
  store.set(heldNamesAtom, r.held ?? []);
  store.set(oauthVerifiedAtom, r.oauth_verified === true);
}
export const authBusyAtom = atom(false);
export const authErrorAtom = atom('');

let asked: Promise<void> | null = null;

export function loadMe(): Promise<void> {
  if (!asked) {
    asked = api
      .me()
      .then((r) => {
        setMeInfo(r);
        store.set(meAtom, r.name);
      })
      .catch(() => {
        store.set(meAtom, null);
        asked = null;
      });
  }
  return asked;
}

export function forgetMe() {
  store.set(meAtom, null);
  store.set(myIdAtom, null);
  store.set(renamedAtAtom, null);
  store.set(heldNamesAtom, []);
  store.set(oauthVerifiedAtom, false);
  asked = null;
}

export function reloadMe(): Promise<void> {
  asked = null;
  return loadMe();
}

async function fillMeInfo(): Promise<void> {
  try {
    setMeInfo(await api.me());
  } catch {
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

export function login(name: string, password: string, turnstileToken?: string): Promise<boolean> {
  return attempt(() => api.login(name.trim().toLowerCase(), password, turnstileToken));
}

export function signup(name: string, password: string, turnstileToken?: string): Promise<boolean> {
  return attempt(() => api.signup(name.trim().toLowerCase(), password, turnstileToken));
}

export async function logout(): Promise<void> {
  try {
    await api.logout();
  } catch {
  }
  store.set(meAtom, null);
  store.set(myIdAtom, null);
  store.set(renamedAtAtom, null);
  store.set(heldNamesAtom, []);
  store.set(oauthVerifiedAtom, false);
}

export async function logoutAll(): Promise<void> {
  try {
    await api.logoutAll();
  } catch {
  }
  forgetMe();
}

export function clearAuthError() {
  store.set(authErrorAtom, '');
}

export type AuthMode = 'login' | 'signup';

export const authDialogAtom = atom<AuthMode | null>(null);

export function openAuthDialog(mode: AuthMode) {
  store.set(authErrorAtom, '');
  store.set(authDialogAtom, mode);
}

export function closeAuthDialog() {
  store.set(authDialogAtom, null);
}

export const passwordBusyAtom = atom(false);
export const passwordStatusAtom = atom('');

export async function changePassword(old: string, next: string): Promise<boolean> {
  store.set(passwordBusyAtom, true);
  store.set(passwordStatusAtom, '');
  try {
    await api.changePassword(old, next);
    store.set(hasPasswordAtom, true);
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

export const RENAME_DAYS = 30;

export const renameBusyAtom = atom(false);
export const renameStatusAtom = atom('');

export const renameAgainAtom = atom((get) => {
  const at = get(renamedAtAtom);
  if (!at) return null;
  const again = new Date(at).getTime() + RENAME_DAYS * 86400_000;
  return again > Date.now() ? new Date(again) : null;
});

export async function renameMe(name: string, password: string): Promise<boolean> {
  store.set(renameBusyAtom, true);
  store.set(renameStatusAtom, '');
  try {
    const r = await api.rename(name.trim().toLowerCase(), password);
    store.set(renamedAtAtom, r.renamed_at);
    store.set(meAtom, r.name);
    void fillMeInfo();
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

export const oauthProvidersAtom = atom<OAuthProvider[] | undefined>(undefined);

let providersAsked: Promise<void> | null = null;

export function loadOAuthProviders(): Promise<void> {
  if (!providersAsked) {
    providersAsked = api
      .oauthProviders()
      .then((r) => store.set(oauthProvidersAtom, r.providers))
      .catch(() => {
        store.set(oauthProvidersAtom, []);
        providersAsked = null;
      });
  }
  return providersAsked;
}

export function oauthStartUrl(provider: OAuthProvider, link = false): string {
  return `/api/oauth/${encodeURIComponent(provider)}/start${link ? '?link=1' : ''}`;
}

export function refreshMeInfo(): Promise<void> {
  return fillMeInfo();
}
