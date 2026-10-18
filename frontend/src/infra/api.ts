/** The json api behind /api. Same origin, so the dev server and caddy both forward it. */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

export interface LiveStream {
  name: string;
  bio: string;
  since: string | null;
}

export interface Grant {
  url: string;
  session: number;
  token: number;
}

export interface WatchGrant {
  url: string;
  bio: string;
  live: boolean;
}

/** Proof that this page is the one that went live. Heartbeat and stop carry it. */
export interface Owner {
  name: string;
  session: number;
  token: number;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const message = data && typeof data === 'object' && 'error' in data ? String((data as { error: unknown }).error) : `http ${res.status}`;
    throw new ApiError(message, res.status);
  }
  return data as T;
}

function ownerQuery(owner: Owner): string {
  return `session=${owner.session}&token=${owner.token}`;
}

export const api = {
  streams: () => request<LiveStream[]>('GET', '/api/streams'),
  streamer: (name: string) => request<{ name: string; bio: string }>('GET', `/api/streamers/${name}`),
  saveBio: (name: string, bio: string) => request<{ name: string; bio: string }>('PUT', `/api/streamers/${name}`, { bio }),
  goLive: (name: string) => request<Grant>('POST', `/api/streams/${name}/go-live`),
  heartbeat: (owner: Owner) => request<{ ok: boolean }>('POST', `/api/streams/${owner.name}/heartbeat?${ownerQuery(owner)}`),
  stop: (owner: Owner) => request<{ ok: boolean }>('POST', `/api/streams/${owner.name}/stop?${ownerQuery(owner)}`),
  /** Survives page teardown, unlike fetch. */
  stopBeacon: (owner: Owner) => navigator.sendBeacon(`/api/streams/${owner.name}/stop?${ownerQuery(owner)}`),
  watch: (name: string) => request<WatchGrant>('POST', `/api/streams/${name}/watch`),
  /** The picture of a stream, made on the video machine. `bucket` changes every few seconds so the browser re-fetches. */
  thumbUrl: (name: string, bucket: number) => `/thumb/${encodeURIComponent(name)}.jpg?t=${bucket}`
};

export function statusOf(err: unknown): number | undefined {
  return err instanceof ApiError ? err.status : undefined;
}

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
