/// <reference lib="webworker" />
/**
 * The events worker: one per browser (a SharedWorker), holding the one `/events` socket for
 * every tab of the site. Tabs attach with a MessagePort and talk in the envelope of frames.ts;
 * frames go through unchanged. The worker owns the hello, the reconnect, the watches (counted
 * per tab, so one tab leaving does not unwatch a name another still shows), the last word of
 * every watched name (a tab attaching late gets it at once), and the inspector's ring. See
 * docs/status.md. No store, no react, no dom in here: frames.ts only (a worker has no
 * localStorage, and the atoms would reach for it the moment they load).
 */

import {
  type ClientFrame,
  type FrameEntry,
  type FromWorker,
  type LinkPhase,
  makeEntry,
  parseServerFrame,
  type Presence,
  type PresenceChoice,
  Ring,
  socketUrl,
  TAB_DEAD_MS,
  type ToWorker
} from '@/infra/frames';

const scope = self as unknown as SharedWorkerGlobalScope;
const SOURCE = '/events';
/** A socket that was open and dropped: back in this long, flat. The server is back in seconds (a deploy). */
const RECONNECT_MS = 3000;
/** A socket that never opened (no route yet, a gateway down for an hour): 3s doubling to this, with jitter. */
const BACKOFF_MAX_MS = 60_000;

interface Tab {
  port: MessagePort;
  lastHeard: number;
  watching: Set<string>;
  /** Wants the inspector's entries as they come. */
  inspector: boolean;
}

const tabs = new Set<Tab>();
const ring = new Ring();
let ws: WebSocket | null = null;
let phase: LinkPhase = 'off';
/** The nick the last tab told us; a login needs none (the cookie goes with the handshake). */
let nick: string | null = null;
/** The server refused this nick (somebody's name): the next hello goes without one. */
let refusedNick: string | null = null;
let me: Extract<ServerMe, { type: 'me' }> | null = null;
const presences = new Map<string, Presence>();
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
/** How many times in a row the socket failed to open. The backoff follows it. */
let failures = 0;
/** This socket opened at some point: a drop is a deploy, not a missing route. */
let wasOpen = false;

type ServerMe = { type: 'me'; name: string | null; presence: Presence; status: PresenceChoice };

function post(tab: Tab, msg: FromWorker) {
  tab.port.postMessage(msg);
}

function broadcast(msg: FromWorker) {
  for (const tab of tabs) post(tab, msg);
}

function setPhase(next: LinkPhase) {
  if (phase === next) return;
  phase = next;
  record('link', { type: next });
  broadcast({ kind: 'link', phase: next });
}

/** Into the ring, and to the tabs that have the inspector open. Only while some tab wants it. */
function record(dir: FrameEntry['dir'], frame: unknown) {
  if (![...tabs].some((t) => t.inspector)) return;
  keep(makeEntry(SOURCE, dir, frame));
}

function keep(entry: FrameEntry) {
  ring.push(entry);
  for (const tab of tabs) {
    if (tab.inspector) post(tab, { kind: 'entry', entry });
  }
}

/** Every name some tab watches. */
function watched(): Set<string> {
  const all = new Set<string>();
  for (const tab of tabs) for (const name of tab.watching) all.add(name);
  return all;
}

function send(frame: ClientFrame) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  record('out', frame);
  ws.send(JSON.stringify(frame));
}

function connect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (ws) {
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    ws.close();
    ws = null;
  }
  if (tabs.size === 0) {
    setPhase('off');
    return;
  }
  setPhase('connecting');
  const socket = new WebSocket(socketUrl(SOURCE, self.location.href));
  ws = socket;
  socket.onopen = () => {
    if (ws !== socket) return;
    wasOpen = true;
    failures = 0;
    const hello: ClientFrame = { type: 'hello' };
    if (nick && nick !== refusedNick) hello.nick = nick;
    send(hello);
    for (const name of watched()) send({ type: 'watch', name });
    setPhase('open');
  };
  socket.onmessage = (e) => {
    if (ws !== socket) return;
    const frame = parseServerFrame(e.data);
    if (!frame) return;
    record('in', frame);
    if (frame.type === 'me') me = frame;
    else if (frame.type === 'presence') presences.set(frame.name, frame.presence);
    else if (frame.type === 'renamed') {
      // the cached `me` and word of the old name are stale now; the server's next `me` says the new one
      if (me?.name === frame.name) me = { ...me, name: frame.to };
      presences.delete(frame.name);
    } else if (frame.type === 'error' && /nick|account|fake/.test(frame.error)) refusedNick = nick;
    broadcast({ kind: 'frame', frame });
  };
  socket.onclose = () => {
    if (ws !== socket) return;
    ws = null;
    setPhase('closed');
    scheduleReconnect();
  };
  socket.onerror = () => {
    // the close that follows does the work
  };
}

/** Rule 2 of docs/transition.md: a dropped socket is back in 3s, a socket that never opened backs off. */
function scheduleReconnect() {
  if (reconnectTimer || tabs.size === 0) return;
  let wait = RECONNECT_MS;
  if (!wasOpen) {
    failures++;
    const base = Math.min(BACKOFF_MAX_MS, RECONNECT_MS * 2 ** (failures - 1));
    wait = Math.round(base * (0.75 + Math.random() * 0.5));
  }
  wasOpen = false;
  reconnectTimer = setTimeout(connect, wait);
}

function watch(tab: Tab, name: string) {
  const first = !watched().has(name);
  tab.watching.add(name);
  if (first) send({ type: 'watch', name });
  else {
    // the word as the worker last heard it, at once; the server's next change follows
    const presence = presences.get(name);
    if (presence) post(tab, { kind: 'frame', frame: { type: 'presence', name, presence } });
  }
}

function unwatch(tab: Tab, name: string) {
  if (!tab.watching.delete(name)) return;
  if (!watched().has(name)) {
    presences.delete(name);
    send({ type: 'unwatch', name });
  }
}

function drop(tab: Tab) {
  if (!tabs.delete(tab)) return;
  // a copy: unwatch takes the name out of the set being walked
  const names = Array.from(tab.watching);
  for (const name of names) unwatch(tab, name);
  tab.port.close();
  if (tabs.size === 0) connect(); // which closes the socket: the last tab is gone
}

scope.onconnect = (e: MessageEvent) => {
  const port = e.ports[0];
  if (!port) return;
  const tab: Tab = { port, lastHeard: Date.now(), watching: new Set(), inspector: false };
  tabs.add(tab);
  port.onmessage = (m: MessageEvent<ToWorker>) => {
    const msg = m.data;
    tab.lastHeard = Date.now();
    switch (msg.kind) {
      case 'attach':
        nick = msg.nick;
        tab.inspector = msg.inspector;
        post(tab, { kind: 'link', phase });
        if (me) post(tab, { kind: 'frame', frame: me });
        if (!ws) connect();
        break;
      case 'hello':
        // who the browser is changed (a log in or out, a new nick): the identity is bound at the
        // handshake (the cookie) and the hello, so the socket is made again
        nick = msg.nick;
        refusedNick = null;
        me = null;
        connect();
        break;
      case 'watch':
        watch(tab, msg.name);
        break;
      case 'unwatch':
        unwatch(tab, msg.name);
        break;
      case 'ping':
        break;
      case 'bye':
        drop(tab);
        break;
      case 'inspector':
        tab.inspector = msg.on;
        break;
      case 'record':
        keep(msg.entry);
        break;
      case 'snapshot':
        post(tab, { kind: 'entries', entries: ring.toArray() });
        break;
      case 'clear':
        ring.clear();
        broadcast({ kind: 'cleared' });
        break;
    }
  };
  port.start();
};

// a tab that died without its bye (a crash, a killed process) stops pinging: its port goes,
// and the names only it watched are unwatched
setInterval(() => {
  const now = Date.now();
  const gone = Array.from(tabs).filter((tab) => now - tab.lastHeard > TAB_DEAD_MS);
  for (const tab of gone) drop(tab);
}, TAB_DEAD_MS / 2);
