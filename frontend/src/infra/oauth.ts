import type { OAuthProvider } from '@/infra/api';

export const PROVIDER_LABEL: Record<string, string> = { google: 'Google', discord: 'Discord' };

export function providerLabel(p: OAuthProvider | null | undefined): string {
  if (!p) return 'that account';
  return PROVIDER_LABEL[p] ?? p.charAt(0).toUpperCase() + p.slice(1);
}

export function providerList(ps: readonly OAuthProvider[]): string {
  const names = ps.map(providerLabel);
  if (names.length <= 1) return names[0] ?? 'another account';
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}

const RETURN_KEY = 'oauth.return';

export function rememberReturn(settings: boolean) {
  try {
    sessionStorage.setItem(RETURN_KEY, JSON.stringify({ path: location.pathname + location.search, settings }));
  } catch {
  }
}

export function takeReturn(): { path: string; settings: boolean } {
  try {
    const raw = sessionStorage.getItem(RETURN_KEY);
    sessionStorage.removeItem(RETURN_KEY);
    const v: unknown = raw ? JSON.parse(raw) : null;
    if (v && typeof v === 'object' && 'path' in v && typeof v.path === 'string' && v.path.startsWith('/') && !v.path.startsWith('//') && !v.path.startsWith('/oauth')) {
      return { path: v.path, settings: 'settings' in v && v.settings === true };
    }
  } catch {
  }
  return { path: '/', settings: false };
}
