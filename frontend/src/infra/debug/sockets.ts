export type SocketState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed' | 'error';
export type LinkState = 'off' | 'connecting' | 'open' | 'closed';

export interface SocketInfo {
  name: string;
  state: SocketState;
  path: string;
  openedAt: number | null;
  opens: number;
  last: number | null;
}

interface Watched {
  readyState: number;
  addEventListener(type: 'open' | 'message' | 'error' | 'close', fn: () => void): void;
}

export const SOCKET_NAMES = ['rt', 'events', 'chat', 'video', 'preview', 'publish', 'voice'] as const;
export type SocketName = (typeof SOCKET_NAMES)[number];

const all = new Map<string, SocketInfo>();
const current = new Map<string, Watched>();

function info(name: string): SocketInfo {
  let s = all.get(name);
  if (!s) all.set(name, (s = { name, state: 'idle', path: '', openedAt: null, opens: 0, last: null }));
  return s;
}

export function socketState(name: SocketName, state: SocketState, path = '', now = Date.now()): void {
  const s = info(name);
  if (path) s.path = path;
  if (state === 'open' && s.state !== 'open') {
    s.opens++;
    s.openedAt = now;
  }
  s.state = state;
}

export function socketLink(name: SocketName, phase: LinkState, path: string, now = Date.now()): void {
  const ever = info(name).opens > 0;
  socketState(name, phase === 'open' ? 'open' : phase === 'off' ? (ever ? 'closed' : 'idle') : ever ? 'reconnecting' : 'connecting', path, now);
}

export function socketTick(name: SocketName, now = Date.now()): void {
  info(name).last = now;
}

export function trackSocket<T extends Watched>(name: SocketName, ws: T, path: string): T {
  current.set(name, ws);
  const mine = () => current.get(name) === ws;
  socketState(name, ws.readyState === 1 ? 'open' : 'connecting', path);
  ws.addEventListener('open', () => mine() && socketState(name, 'open'));
  ws.addEventListener('message', () => socketTick(name));
  ws.addEventListener('error', () => mine() && socketState(name, 'error'));
  ws.addEventListener('close', () => mine() && info(name).state !== 'error' && socketState(name, 'closed'));
  return ws;
}

export const socketList = (): SocketInfo[] => SOCKET_NAMES.map(info);

export function resetSockets(): void {
  all.clear();
  current.clear();
}
