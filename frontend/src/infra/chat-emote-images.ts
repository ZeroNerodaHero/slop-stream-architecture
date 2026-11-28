import { emoteUrlOk } from '@/infra/chat-source';

const KEEP = 300;
const cache = new Map<string, HTMLImageElement | 'loading' | 'bad'>();
const listeners = new Set<() => void>();

function readable(img: HTMLImageElement): boolean {
  try {
    const probe = document.createElement('canvas');
    probe.width = 1;
    probe.height = 1;
    const ctx = probe.getContext('2d');
    if (!ctx) return false;
    ctx.drawImage(img, 0, 0, 1, 1);
    ctx.getImageData(0, 0, 1, 1);
    return true;
  } catch {
    return false;
  }
}

function settle(url: string, value: HTMLImageElement | 'bad') {
  cache.set(url, value);
  for (const listener of listeners) listener();
}

export function emoteImage(url: string): HTMLImageElement | null {
  const got = cache.get(url);
  if (got instanceof HTMLImageElement) return got;
  if (got || !emoteUrlOk(url) || typeof Image === 'undefined') return null;
  if (cache.size >= KEEP) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(url, 'loading');
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.referrerPolicy = 'no-referrer';
  img.decoding = 'async';
  img.onload = () => settle(url, img.naturalWidth > 0 && readable(img) ? img : 'bad');
  img.onerror = () => settle(url, 'bad');
  img.src = url;
  return null;
}

export function onEmoteImage(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
