/// <reference lib="webworker" />

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
const RECONNECT_MS = 3000;
const BACKOFF_MAX_MS = 60_000;

interface Tab {
  port: MessagePort;
  lastHeard: number;
  watching: Set<string>;
  inspector: boolean;
}

const tabs = new Set<Tab>();
const ring = new Ring();
let ws: WebSocket | null = null;
let phase: LinkPhase = 'off';
let nick: string | null = null;
let refusedNick: string | null = null;
let me: Extract<ServerMe, { type: 'me' }> | null = null;
const presences = new Map<string, Presence>();
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let failures = 0;
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

function inspected(): boolean {
  for (const tab of tabs) if (tab.inspector) return true;
  return false;
}

function forgetIfUnwatched() {
  if (!inspected()) ring.clear();
}

function record(dir: FrameEntry['dir'], frame: unknown) {
  if (!inspected()) return;
  keep(makeEntry(SOURCE, dir, frame));
}

function keep(entry: FrameEntry) {
  ring.push(entry);
  for (const tab of tabs) {
    if (tab.inspector) post(tab, { kind: 'entry', entry });
  }
}

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
  };
}

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
  const names = Array.from(tab.watching);
  for (const name of names) unwatch(tab, name);
  tab.port.close();
  forgetIfUnwatched();
  if (tabs.size === 0) connect();
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
        forgetIfUnwatched();
        break;
      case 'record':
        if (tab.inspector) keep(msg.entry);
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

setInterval(() => {
  const now = Date.now();
  const gone = Array.from(tabs).filter((tab) => now - tab.lastHeard > TAB_DEAD_MS);
  for (const tab of gone) drop(tab);
}, TAB_DEAD_MS / 2);
