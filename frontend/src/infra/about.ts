export function linkHref(href: unknown): string | null {
  if (typeof href !== 'string' || href.length === 0 || href.length > 2000) return null;
  let url: URL;
  try {
    url = new URL(href, location.origin);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  return url.href;
}

export function isSameOrigin(href: string): boolean {
  try {
    return new URL(href, location.origin).origin === location.origin;
  } catch {
    return false;
  }
}

