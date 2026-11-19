/**
 * The login providers the pages know by name (docs/accounts.md). The api's list
 * (api/src/oauth.rs `PROVIDERS`) is the one that counts: `GET /api/oauth/providers` says which
 * are turned on, and a slug missing here still gets a button, with its slug for a label and a
 * plain icon (OAuthButtons.tsx `ProviderIcon`). A new provider: its entry in the api's list,
 * then a label here and an icon there.
 */

import type { OAuthProvider } from '@/infra/api';

export const PROVIDER_LABEL: Record<string, string> = { google: 'Google', discord: 'Discord' };

/** A person's word for the provider: its label, or the slug with a capital for one this build does not know. */
export function providerLabel(p: OAuthProvider | null | undefined): string {
  if (!p) return 'that account';
  return PROVIDER_LABEL[p] ?? p.charAt(0).toUpperCase() + p.slice(1);
}

/** The labels of the providers on, joined for a sentence: `Google or Discord`. */
export function providerList(ps: readonly OAuthProvider[]): string {
  const names = ps.map(providerLabel);
  if (names.length <= 1) return names[0] ?? 'another account';
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}

/** Where a trip to a provider started, so the way back lands there (OAuthPage.tsx). This tab only. */
const RETURN_KEY = 'oauth.return';

export function rememberReturn(settings: boolean) {
  try {
    sessionStorage.setItem(RETURN_KEY, JSON.stringify({ path: location.pathname + location.search, settings }));
  } catch {
    // storage off: the way back is home
  }
}

/** Where to go back to, once: the path the trip started on, and whether the settings were open on security. */
export function takeReturn(): { path: string; settings: boolean } {
  try {
    const raw = sessionStorage.getItem(RETURN_KEY);
    sessionStorage.removeItem(RETURN_KEY);
    const v: unknown = raw ? JSON.parse(raw) : null;
    if (v && typeof v === 'object' && 'path' in v && typeof v.path === 'string' && v.path.startsWith('/') && !v.path.startsWith('//') && !v.path.startsWith('/oauth')) {
      return { path: v.path, settings: 'settings' in v && v.settings === true };
    }
  } catch {
    // nothing kept, or nothing readable
  }
  return { path: '/', settings: false };
}
