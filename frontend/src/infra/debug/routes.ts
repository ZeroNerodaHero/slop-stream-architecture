type Slot = ':id' | ':name';

const NEXT: Record<string, { as: Slot; keep?: readonly string[] }> = {
  groups: { as: ':name' },
  channels: { as: ':name' },
  voice: { as: ':name' },
  members: { as: ':name' },
  bans: { as: ':name' },
  owners: { as: ':name' },
  timeout: { as: ':name' },
  timeouts: { as: ':name' },
  jannies: { as: ':name' },
  dm: { as: ':name' },
  streams: { as: ':name' },
  streamers: { as: ':name' },
  oauth: { as: ':name', keep: ['identities', 'providers', 'signup'] },
  emotes: { as: ':id', keep: ['mine'] },
  notifications: { as: ':id', keep: ['read', 'settings'] },
  roles: { as: ':id' },
  pins: { as: ':id' },
  messages: { as: ':id' },
  chat: { as: ':id' },
  thumbs: { as: ':id' },
  assets: { as: ':id' },
  models: { as: ':id' },
  'chat-images': { as: ':id' },
  'chat-videos': { as: ':id' }
};

const ID = /^(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{8,}|(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{16,})$/i;

export function normalizeRoute(path: string): string {
  const cut = path.search(/[?#]/);
  const parts = (cut < 0 ? path : path.slice(0, cut)).split('/');
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i]!;
    const rule = i > 2 ? NEXT[out[i - 1]!] : undefined;
    if (seg === '') out.push(seg);
    else if (ID.test(seg)) out.push(':id');
    else if (rule && !rule.keep?.includes(seg)) out.push(rule.as);
    else out.push(seg);
  }
  return out.join('/');
}

export function apiKey(input: RequestInfo | URL, init: RequestInit | undefined, origin: string): string | null {
  let url: URL;
  try {
    url = new URL(typeof input === 'string' ? input : 'href' in input ? input.href : input.url, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin || !url.pathname.startsWith('/api/')) return null;
  const method = (init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase();
  return `${method} ${normalizeRoute(url.pathname)}`;
}
