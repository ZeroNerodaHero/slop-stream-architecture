/**
 * The events socket, from a tab's side (docs/status.md, docs/transition.md). One `/events`
 * socket per browser, held in the events worker (events.worker.ts) and reached over a
 * MessagePort; where there is no SharedWorker (chrome on android, samsung internet, the
 * android webview) a plain socket for this tab, same frames, same atoms. Either way this
 * module is the one place the pages touch it: `startEvents()` once per page load, the verbs
 * (`watchPresence`, `unwatchPresence`, `reconnectEvents`), and `onEvents` for a module that
 * wants the frames (watch-atoms for `live`). The frames themselves land in presence-atoms.
 */

import { atom } from 'jotai';

import { meAtom } from '@/infra/atoms/auth-atoms';
import { nickAtom } from '@/infra/atoms/chat-atoms';
import { bindInspectorToWorker, keep, record, replaceEntries, unbindInspector } from '@/infra/atoms/inspector-atoms';
import { identifiedAs, presenceChanged, presenceLost } from '@/infra/atoms/presence-atoms';
import { inspectorEnabledAtom } from '@/infra/atoms/settings-atoms';
// the worker as vite builds it: one hashed classic worker under /assets (the default `iife` format,
// the widest support), named so every tab of the origin shares the same one. the lint strips the
// query and finds no default export in the worker file; vite's own typing says there is one
// oxlint-disable-next-line import/default
import EventsWorker from '@/infra/events.worker?sharedworker';
import { type ClientFrame, type FrameEntry, type FromWorker, type LinkPhase, parseServerFrame, type ServerFrame, TAB_PING_MS, type ToWorker } from '@/infra/frames';
import { relayUrl } from '@/infra/relay';
import { report } from '@/infra/report';
import { store } from '@/infra/store';

const SOURCE = '/events';
const RECONNECT_MS = 3000;
const BACKOFF_MAX_MS = 60_000;
/** The worker has this long to answer the attach before this tab opens a socket of its own. */
const WORKER_WAIT_MS = 2000;

/** The socket as this tab knows it: `off` before `startEvents`, `open` when frames can flow. */
export const eventsPhaseAtom = atom<LinkPhase>('off');
/** Which link this tab ended up on. For the tests, and for a human wondering. */
export const eventsTransportAtom = atom<'worker' | 'tab' | 'none'>('none');

/** A frame, or the link changing phase, for modules that react to either (watch-atoms). */
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
  /** The inspector setting flipped: the worker records (and hands over its ring) or stops. */
  inspector(on: boolean): void;
  close(): void;
}

let link: Link | null = null;
/**
 * Names this tab watches, so a new link (a fallback, a re-hello) asks for them again. A page's
 * subject (`watchPresence`: the stream on the watch page, home's `*`, a room's topic) is in the
 * set once however often the page asks. A list's names (`holdPresence`: a room's roster) are
 * counted, one hold per list, so the roster letting go of a name does not take it from the
 * corner player, nor the other way round.
 */
const watching = new Set<string>();
const held = new Map<string, number>();

/** Whether anything in this tab wants `name` on the socket. */
function wanted(name: string): boolean {
  return watching.has(name) || held.has(name);
}

/** Every name this tab wants, for a link that has to ask again. */
function allWanted(): Set<string> {
  return new Set([...watching, ...held.keys()]);
}

/** The nick for the hello: a login needs none (the cookie goes with the handshake); a guest's name box. */
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
      // the server refused who we said we were (somebody's name): the worker re-hellos nameless;
      // the profile tab already says why the name is not ours
      break;
    default:
      break;
  }
  for (const l of listeners) l(frame);
}

// ---- the worker link -----------------------------------------------------------------------

/** One port into the events worker. The worker does the rest; this relays and keeps the port alive. */
class WorkerLink implements Link {
  private readonly port: MessagePort;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly onHide = () => this.post({ kind: 'bye' });
  /** Resolved by the first message from the worker: it is alive. */
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
    // the ring so far, when this tab keeps the messages: a tab opened late sees what came before it
    if (inspector) this.post({ kind: 'snapshot' });
    for (const name of allWanted()) this.post({ kind: 'watch', name });
    // a port has no close event a worker can rely on: the tab says bye, and pings meanwhile
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

// ---- the fallback: a socket for this tab -------------------------------------------------------

/** A browser with no SharedWorker. The worker's logic in miniature, for one tab. */
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
      // rule 2 of docs/transition.md: a dropped socket is back in 3s; one that never opened backs off
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
    // the ring is this tab's and `record` reads the setting itself; off empties it
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

// ---- the verbs -------------------------------------------------------------------------------

let started = false;

/**
 * Once per page load (main.tsx). The worker where the browser has one and it answers within
 * WORKER_WAIT_MS; a socket of this tab's own otherwise. Idempotent: the Shell may remount after
 * a crash, the socket must not.
 */
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

/** Who this browser is changed (a log in, a log out, a new nick): hello again as the new one. */
export function reconnectEvents(): void {
  link?.hello();
}

/** From now on, `name`'s word as it changes, and `live` / `ended` as they happen. */
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

/** One of a list's names (a room's roster), on the socket while any list holds it. Every hold is let go with `releasePresence`. */
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

// the inspector setting is this browser's and the worker is the browser's: it follows at once
store.sub(inspectorEnabledAtom, () => link?.inspector(store.get(inspectorEnabledAtom)));

export function stopEvents(): void {
  link?.close();
  link = null;
  started = false;
  store.set(eventsTransportAtom, 'none');
}
