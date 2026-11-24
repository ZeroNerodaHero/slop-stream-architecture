import { atom } from 'jotai';

import { record } from '@/infra/atoms/inspector-atoms';
import { report } from '@/infra/report';
import { type FromCore, openBrowserSocket, type Port, RtCore, type ToCore } from '@/infra/rt/core';
import { type Release, TopicRefs } from '@/infra/rt/refs';
import {
  type Answer,
  type Ask,
  covers,
  fetchTicket,
  normalTopic,
  type RtFrame,
  type RtPhase,
  rtSocketUrl,
  rtWanted,
  TAB_PING_MS,
  wildcardOf,
  WORKER_WAIT_MS
} from '@/infra/rt/wire';
import { store } from '@/infra/store';

const SOURCE = '/rt';

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export const rtOn = typeof window !== 'undefined' && rtWanted(window.location.href, storage());

export const rtPhaseAtom = atom<RtPhase>('off');
export const rtTransportAtom = atom<'worker' | 'tab' | 'none'>('none');

export type RtListener = (frame: RtFrame) => void;

const byTopic = new Map<string, Set<RtListener>>();
const everyFrame = new Set<RtListener>();
const phaseListeners = new Set<(phase: RtPhase) => void>();
const answers = new Map<string, (answer: Answer) => void>();
let rids = 0;
let send: ((msg: ToCore) => void) | null = null;
let started = false;
let nickOf: () => string | null = () => null;
let held = new Set<string>();

const refs = new TopicRefs((topics) => send?.({ kind: 'set', topics }));

function deliver(msg: FromCore) {
  switch (msg.kind) {
    case 'phase':
      if (msg.phase !== 'open') held = new Set();
      store.set(rtPhaseAtom, msg.phase);
      for (const l of phaseListeners) l(msg.phase);
      return;
    case 'frame': {
      const frame = msg.frame;
      record(SOURCE, 'in', frame);
      if (frame.type === 'subbed' && Array.isArray(frame.topics)) held = new Set(frame.topics.filter((t): t is string => typeof t === 'string'));
      const topic = typeof frame.topic === 'string' ? frame.topic : null;
      if (topic !== null) {
        for (const l of byTopic.get(topic) ?? []) l(frame);
        const every = wildcardOf(topic);
        if (every) for (const l of byTopic.get(every) ?? []) l(frame);
      }
      for (const l of everyFrame) l(frame);
      return;
    }
    case 'answer': {
      const done = answers.get(msg.rid);
      answers.delete(msg.rid);
      done?.(msg.answer);
      return;
    }
    case 'stale':
      return;
  }
}

function attachTab(why: string) {
  report('soft', `rt: ${why}. a socket for this tab instead`, { phase: 'rt' });
  const core = new RtCore({ url: rtSocketUrl(location.href), build: __BUILD__, open: openBrowserSocket, ticket: () => fetchTicket(location.href) });
  const port: Port = { post: (msg) => deliver(msg), close: () => undefined };
  const handle = core.connect(port);
  send = handle;
  store.set(rtTransportAtom, 'tab');
  handle({ kind: 'attach', build: __BUILD__, nick: nickOf() });
  handle({ kind: 'set', topics: refs.topics() });
}

function attachWorker(): boolean {
  if (typeof SharedWorker === 'undefined') return false;
  let worker: SharedWorker;
  try {
    worker = new SharedWorker(new URL('../rt.worker.ts', import.meta.url), { type: 'module', name: `rt-${__BUILD__}` });
  } catch {
    return false;
  }
  const port = worker.port;
  let heard = false;
  let fellBack = false;
  const fallBack = (why: string) => {
    if (fellBack) return;
    fellBack = true;
    clearInterval(ping);
    window.removeEventListener('pagehide', bye);
    try {
      port.postMessage({ kind: 'bye' } satisfies ToCore);
      port.close();
    } catch {
      report('soft', 'rt: the worker port would not close', { phase: 'rt' });
    }
    attachTab(why);
  };
  port.onmessage = (e: MessageEvent<FromCore>) => {
    heard = true;
    if (fellBack) return;
    if (e.data.kind === 'stale') {
      fallBack(`the rt worker is build ${e.data.build}, this page is ${__BUILD__}`);
      return;
    }
    deliver(e.data);
  };
  worker.onerror = () => fallBack('the rt worker errored');
  port.start();
  const post = (msg: ToCore) => {
    if (!fellBack) port.postMessage(msg);
  };
  send = post;
  store.set(rtTransportAtom, 'worker');
  const ping = setInterval(() => post({ kind: 'ping' }), TAB_PING_MS);
  const bye = () => post({ kind: 'bye' });
  window.addEventListener('pagehide', bye);
  post({ kind: 'attach', build: __BUILD__, nick: nickOf() });
  post({ kind: 'set', topics: refs.topics() });
  setTimeout(() => {
    if (!heard) fallBack(`the rt worker did not answer in ${WORKER_WAIT_MS}ms`);
  }, WORKER_WAIT_MS);
  return true;
}

export function startRt(nick: () => string | null): void {
  if (started) return;
  started = true;
  nickOf = nick;
  if (!attachWorker()) attachTab('no SharedWorker here');
  const focus = () => {
    if (document.visibilityState !== 'visible') return;
    send?.({ kind: 'set', topics: refs.topics() });
    send?.({ kind: 'focus' });
  };
  window.addEventListener('focus', focus);
  document.addEventListener('visibilitychange', focus);
}

export function acquireTopic(topic: string): Release {
  return refs.acquire(topic);
}

export function rtHolds(topic: string): boolean {
  return store.get(rtPhaseAtom) === 'open' && covers(held, normalTopic(topic));
}

export function listenTopic(raw: string, listener: RtListener): () => void {
  const topic = normalTopic(raw);
  let set = byTopic.get(topic);
  if (!set) {
    set = new Set();
    byTopic.set(topic, set);
  }
  set.add(listener);
  return () => {
    const have = byTopic.get(topic);
    if (!have) return;
    have.delete(listener);
    if (have.size === 0) byTopic.delete(topic);
  };
}

export function onRtFrame(listener: RtListener): () => void {
  everyFrame.add(listener);
  return () => everyFrame.delete(listener);
}

export function onRtPhase(listener: (phase: RtPhase) => void): () => void {
  phaseListeners.add(listener);
  return () => phaseListeners.delete(listener);
}

export function rtAsk(ask: Ask): Promise<Answer> {
  rids += 1;
  const rid = `t${rids}`;
  record(SOURCE, 'out', { ...ask, rid });
  return new Promise((resolve) => {
    answers.set(rid, resolve);
    if (!send) {
      answers.delete(rid);
      resolve({ type: 'nack', rid, error: 'chat is down' });
      return;
    }
    send({ kind: 'ask', rid, ask });
  });
}

export function rtFill(since: Record<string, string>): void {
  if (Object.keys(since).length > 0) send?.({ kind: 'fill', since });
}

export function rtFresh(topic: string): void {
  send?.({ kind: 'fresh', topic });
}

let identifyQueued = false;

export function rtIdentify(): void {
  if (identifyQueued) return;
  identifyQueued = true;
  queueMicrotask(() => {
    identifyQueued = false;
    send?.({ kind: 'identify', nick: nickOf() });
  });
}
