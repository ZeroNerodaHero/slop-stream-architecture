import { atom } from 'jotai';

import { api, messageOf, type OAuthProvider } from '@/infra/api';
import { oauthStartUrl, reloadMe } from '@/infra/atoms/auth-atoms';
import { identityChanged } from '@/infra/atoms/profile-atoms';
import { rememberReturn, takeReturn } from '@/infra/oauth';
import { store } from '@/infra/store';
import { inTauri } from '@/infra/update-check';

const KEY = 'oauth.desktop';
const WAIT_MS = 5 * 60 * 1000;

export const DESKTOP_TOKEN = /^[0-9a-f]{64}$/;

export const desktopLoginAtom = atom<{ waiting: OAuthProvider | null; error: string }>({ waiting: null, error: '' });

interface Pending {
  state: string;
  at: number;
  provider: OAuthProvider;
}

let pending: Pending | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let navigateTo: (path: string) => void = () => {};
let installed = false;

function randomHex(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');
}

function readPending(): Pending | null {
  if (pending) return pending;
  try {
    const v: unknown = JSON.parse(sessionStorage.getItem(KEY) ?? 'null');
    if (
      v &&
      typeof v === 'object' &&
      'state' in v &&
      typeof v.state === 'string' &&
      'at' in v &&
      typeof v.at === 'number' &&
      'provider' in v &&
      typeof v.provider === 'string'
    ) {
      return { state: v.state, at: v.at, provider: v.provider };
    }
  } catch {}
  return null;
}

function forgetPending() {
  pending = null;
  try {
    sessionStorage.removeItem(KEY);
  } catch {}
}

function settle(error: string) {
  clearTimeout(timer);
  timer = undefined;
  forgetPending();
  store.set(desktopLoginAtom, { waiting: null, error });
}

function wait(p: Pending) {
  clearTimeout(timer);
  store.set(desktopLoginAtom, { waiting: p.provider, error: '' });
  timer = setTimeout(() => settle('that took too long. try again'), Math.max(0, p.at + WAIT_MS - Date.now()));
}

export async function startDesktopLogin(provider: OAuthProvider): Promise<void> {
  rememberReturn(false);
  const p: Pending = { state: randomHex(), at: Date.now(), provider };
  pending = p;
  try {
    sessionStorage.setItem(KEY, JSON.stringify(p));
  } catch {}
  wait(p);
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('open_login', { url: `${location.origin}/api/oauth/${encodeURIComponent(provider)}/start?desktop=${p.state}` });
  } catch {
    if (pending !== p) return;
    settle('');
    location.assign(oauthStartUrl(provider));
  }
}

export function cancelDesktopLogin() {
  settle('');
}

async function receive(raw: string | null | undefined): Promise<void> {
  if (!raw) return;
  let code: string | null;
  let state: string | null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'nodentity:' || url.host !== 'auth') return;
    code = url.searchParams.get('code');
    state = url.searchParams.get('state');
  } catch {
    return;
  }
  const p = readPending();
  if (!code || !state || !DESKTOP_TOKEN.test(code) || !DESKTOP_TOKEN.test(state) || !p || p.state !== state) return;
  forgetPending();
  try {
    const r = await api.oauthHandoff(code, state);
    settle('');
    if (r.next === 'pick') {
      navigateTo(`/oauth?pick=${encodeURIComponent(r.provider ?? p.provider)}`);
      return;
    }
    await reloadMe();
    identityChanged('login');
    navigateTo(takeReturn().path);
  } catch (err) {
    settle(messageOf(err));
  }
}

export function installDesktopLogin(navigate: (path: string) => void) {
  if (installed || !inTauri()) return;
  installed = true;
  navigateTo = navigate;
  const p = readPending();
  if (p) {
    if (p.at + WAIT_MS > Date.now()) wait(p);
    else forgetPending();
  }
  void (async () => {
    try {
      const [{ invoke }, { listen }] = await Promise.all([import('@tauri-apps/api/core'), import('@tauri-apps/api/event')]);
      const take = async (sent?: string) => receive((await invoke<string | null>('take_desktop_auth')) ?? sent);
      await listen<string>('desktop-auth', (e) => void take(e.payload));
      await take();
    } catch {}
  })();
}
