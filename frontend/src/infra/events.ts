import { atom } from 'jotai';

import { meAtom } from '@/infra/atoms/auth-atoms';
import { nickAtom } from '@/infra/atoms/chat-atoms';
import { bindInspectorToWorker, keep, record, replaceEntries, unbindInspector } from '@/infra/atoms/inspector-atoms';
import { identifiedAs, presenceChanged, presenceLost } from '@/infra/atoms/presence-atoms';
import { inspectorEnabledAtom } from '@/infra/atoms/settings-atoms';
import EventsWorker from '@/infra/events.worker?sharedworker';
import { type ClientFrame, type FrameEntry, type FromWorker, type LinkPhase, parseServerFrame, type ServerFrame, TAB_PING_MS, type ToWorker } from '@/infra/frames';
import { relayUrl } from '@/infra/relay';
import { report } from '@/infra/report';
import { store } from '@/infra/store';

const SOURCE = '/events';
const RECONNECT_MS = 3000;
const BACKOFF_MAX_MS = 60_000;
const WORKER_WAIT_MS = 2000;

export const eventsPhaseAtom = atom<LinkPhase>('off');
export const eventsTransportAtom = atom<'worker' | 'tab' | 'none'>('none');

export type EventsListener = (event: ServerFrame | { type: 'link'; phase: LinkPhase }) => void;
const listeners = new Set<EventsListener>();

export function onEvents(listener: EventsListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

interface Link {
  hello(): void;
  watch(name: string): void;
  unwatch(name: string): void;
  inspector(on: boolean): void;
  close(): void;
}

let link: Link | null = null;
const watching = new Set<string>();
const held = new Map<string, number>();

function wanted(name: string): boolean {
  return watching.has(name) || held.has(name);
}

function allWanted(): Set<string> {
  return new Set([...watching, ...held.keys()]);
}

function nickForHello(): string | null {
  if (store.get(meAtom)) return null;
  const nick = store.get(nickAtom).trim();
  return nick || null;
}

function setPhase(phase: LinkPhase) {
  if (store.get(eventsPhaseAtom) === phase) return;
  store.set(eventsPhaseAtom, phase);
  if (phase !== 'open') presenceLost();
  for (const l of listeners) l({ type: 'link', phase });
}

function dispatch(frame: ServerFrame) {
  switch (frame.type) {
    case 'me':
      identifiedAs(frame.name, frame.presence, frame.status);
      break;
    case 'presence':
      presenceChanged(frame.name, frame.presence);
      break;
    case 'error':
      break;
    default:
      break;
  }
  for (const l of listeners) l(frame);
}

class WorkerLink implements Link {
  private readonly port: MessagePort;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly onHide = () => this.post({ kind: 'bye' });
  readonly ready: Promise<void>;

  constructor(worker: SharedWorker) {
    this.port = worker.port;
    let settle: () => void = () => undefined;
    this.ready = new Promise((resolve) => {
      settle = resolve;
    });
    this.port.onmessage = (e: MessageEvent<FromWorker>) => {
      settle();
      const msg = e.data;
      switch (msg.kind) {
        case 'link':
          setPhase(msg.phase);
          break;
        case 'frame':
          dispatch(msg.frame);
          break;
        case 'entry':
          keep(msg.entry);
          break;
        case 'entries':
          replaceEntries(msg.entries);
          break;
        case 'cleared':
          replaceEntries([]);
          break;
      }
    };
    this.port.start();
    const inspector = store.get(inspectorEnabledAtom);
    this.post({ kind: 'attach', nick: nickForHello(), inspector });
    if (inspector) this.post({ kind: 'snapshot' });
    for (const name of allWanted()) this.post({ kind: 'watch', name });
    this.timer = setInterval(() => this.post({ kind: 'ping' }), TAB_PING_MS);
    window.addEventListener('pagehide', this.onHide);
    bindInspectorToWorker(
      (entry: FrameEntry) => this.post({ kind: 'record', entry }),
      () => this.post({ kind: 'clear' })
    );
  }

  private post(msg: ToWorker) {
    this.port.postMessage(msg);
  }

  hello() {
    this.post({ kind: 'hello', nick: nickForHello() });
  }

  watch(name: string) {
    this.post({ kind: 'watch', name });
  }

  unwatch(name: string) {
    this.post({ kind: 'unwatch', name });
  }

  inspector(on: boolean) {
    this.post({ kind: 'inspector', on });
    if (on) this.post({ kind: 'snapshot' });
    else replaceEntries([]);
  }

  close() {
    clearInterval(this.timer);
    window.removeEventListener('pagehide', this.onHide);
    unbindInspector();
    this.post({ kind: 'bye' });
    this.port.close();
  }
}

class TabLink implements Link {
  private ws: WebSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private wasOpen = false;
  private refusedNick: string | null = null;
  private closed = false;

  constructor() {
    this.connect();
  }

  private send(frame: ClientFrame) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    record(SOURCE, 'out', frame);
    this.ws.send(JSON.stringify(frame));
  }

  private connect() {
    if (this.closed) return;
    this.timer = null;
    setPhase('connecting');
    const socket = new WebSocket(relayUrl(SOURCE));
    this.ws = socket;
    socket.onopen = () => {
      if (this.ws !== socket) return;
      this.wasOpen = true;
      this.failures = 0;
      const nick = nickForHello();
      const hello: ClientFrame = { type: 'hello' };
      if (nick && nick !== this.refusedNick) hello.nick = nick;
      this.send(hello);
      for (const name of allWanted()) this.send({ type: 'watch', name });
      setPhase('open');
    };
    socket.onmessage = (e) => {
      if (this.ws !== socket) return;
      const frame = parseServerFrame(e.data);
      if (!frame) return;
      record(SOURCE, 'in', frame);
      if (frame.type === 'error' && /nick|account|fake/.test(frame.error)) this.refusedNick = nickForHello();
      dispatch(frame);
    };
    socket.onclose = () => {
      if (this.ws !== socket) return;
      this.ws = null;
      setPhase('closed');
      let wait = RECONNECT_MS;
      if (!this.wasOpen) {
        this.failures++;
        const base = Math.min(BACKOFF_MAX_MS, RECONNECT_MS * 2 ** (this.failures - 1));
        wait = Math.round(base * (0.75 + Math.random() * 0.5));
      }
      this.wasOpen = false;
      this.timer = setTimeout(() => this.connect(), wait);
    };
  }

  hello() {
    this.refusedNick = null;
    if (this.timer) clearTimeout(this.timer);
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.connect();
  }

  watch(name: string) {
    this.send({ type: 'watch', name });
  }

  unwatch(name: string) {
    this.send({ type: 'unwatch', name });
  }

  inspector(on: boolean) {
    if (!on) replaceEntries([]);
  }

  close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    setPhase('off');
  }
}

let started = false;

export function startEvents(): void {
  if (started) return;
  started = true;
  if (typeof SharedWorker === 'undefined') {
    useTabLink('no SharedWorker here');
    return;
  }
  let worker: SharedWorker;
  try {
    worker = new EventsWorker({ name: 'events' });
  } catch (err) {
    useTabLink(`SharedWorker refused: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  const viaWorker = new WorkerLink(worker);
  link = viaWorker;
  store.set(eventsTransportAtom, 'worker');
  let fellBack = false;
  const fallBack = (why: string) => {
    if (fellBack || link !== viaWorker) return;
    fellBack = true;
    viaWorker.close();
    useTabLink(why);
  };
  worker.onerror = () => fallBack('the events worker errored');
  const wait = setTimeout(() => fallBack(`the events worker did not answer in ${WORKER_WAIT_MS}ms`), WORKER_WAIT_MS);
  void viaWorker.ready.then(() => clearTimeout(wait));
}

function useTabLink(why: string) {
  report('soft', `events: ${why}. a socket for this tab instead`, { phase: 'events' });
  link = new TabLink();
  store.set(eventsTransportAtom, 'tab');
}

export function reconnectEvents(): void {
  link?.hello();
}

export function watchPresence(name: string): void {
  if (watching.has(name)) return;
  const before = wanted(name);
  watching.add(name);
  if (!before) link?.watch(name);
}

export function unwatchPresence(name: string): void {
  if (!watching.delete(name)) return;
  if (!wanted(name)) link?.unwatch(name);
}

export function holdPresence(name: string): void {
  const before = wanted(name);
  held.set(name, (held.get(name) ?? 0) + 1);
  if (!before) link?.watch(name);
}

export function releasePresence(name: string): void {
  const count = held.get(name) ?? 0;
  if (count === 0) return;
  if (count === 1) held.delete(name);
  else held.set(name, count - 1);
  if (!wanted(name)) link?.unwatch(name);
}

export function wantsPresence(name: string): boolean {
  return wanted(name);
}

store.sub(inspectorEnabledAtom, () => link?.inspector(store.get(inspectorEnabledAtom)));

export function stopEvents(): void {
  link?.close();
  link = null;
  started = false;
  store.set(eventsTransportAtom, 'none');
}
