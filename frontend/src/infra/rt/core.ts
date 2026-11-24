import {
  ANSWER_MS,
  type Answer,
  type Ask,
  compareIds,
  covers,
  type HelloOut,
  isChatTopic,
  isLineId,
  MISMATCH_RESEND_MS,
  normalTopic,
  parseFrame,
  RESYNC_MS,
  restartDelay,
  retryDelay,
  type RtFrame,
  type RtPhase,
  RT_VERSION,
  type SubOut,
  type Subbed,
  TAB_DEAD_MS,
  WATCHDOG_MS
} from './wire.ts';

export const LINGER_MS = 5_000;

export interface Clock {
  now(): number;
  random(): number;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(run: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  random: () => Math.random(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (run, ms) => setInterval(run, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>)
};

export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: ((e: { code: number }) => void) | null;
  onerror: (() => void) | null;
}

const OPEN = 1;

export function openBrowserSocket(url: string): SocketLike {
  return new WebSocket(url) as unknown as SocketLike;
}

export type ToCore =
  | { kind: 'attach'; build: string; nick: string | null }
  | { kind: 'set'; topics: string[]; peek?: string[] }
  | { kind: 'ping' }
  | { kind: 'focus' }
  | { kind: 'bye' }
  | { kind: 'ask'; rid: string; ask: Ask }
  | { kind: 'fill'; since: Record<string, string> }
  | { kind: 'fresh'; topic: string }
  | { kind: 'identify'; nick: string | null };

export type FromCore =
  | { kind: 'phase'; phase: RtPhase }
  | { kind: 'frame'; frame: RtFrame }
  | { kind: 'answer'; rid: string; answer: Answer }
  | { kind: 'stale'; build: string };

export interface Port {
  post(msg: FromCore): void;
  close(): void;
}

export interface CoreOptions {
  url: string;
  build: string;
  open: (url: string) => SocketLike;
  ticket: () => Promise<string>;
  clock?: Clock;
}

interface Tab {
  port: Port;
  topics: Set<string>;
  peek: Set<string>;
  heard: number;
}

interface Pending {
  tab: Tab;
  rid: string;
  timer: unknown;
}

export class RtCore {
  readonly build: string;
  private readonly url: string;
  private readonly open: (url: string) => SocketLike;
  private readonly ticket: () => Promise<string>;
  private readonly clock: Clock;

  private readonly tabs = new Map<Port, Tab>();
  private ws: SocketLike | null = null;
  private ready = false;
  private phase: RtPhase = 'off';
  private failures = 0;
  private retry: unknown = null;
  private watchdog: unknown = null;
  private mismatch: unknown = null;
  private linger: unknown = null;
  private readonly resync: unknown;
  private readonly sweep: unknown;

  private nick: string | null = null;
  private rev = 0;
  private union: string[] = [];
  private peek: string[] = [];
  private subbed: Subbed | null = null;
  private me: RtFrame | null = null;
  private readonly presences = new Map<string, RtFrame>();
  private readonly counts = new Map<string, RtFrame>();
  private readonly latest = new Map<string, string>();
  private readonly fresh = new Set<string>();
  private readonly pending = new Map<string, Pending>();
  private seq = 0;
  private identifying = false;
  private identifyAgain = false;

  constructor(options: CoreOptions) {
    this.url = options.url;
    this.build = options.build;
    this.open = options.open;
    this.ticket = options.ticket;
    this.clock = options.clock ?? realClock;
    this.resync = this.clock.setInterval(() => this.sendSub(false), RESYNC_MS);
    this.sweep = this.clock.setInterval(() => this.dropDead(), TAB_DEAD_MS / 2);
  }

  connect(port: Port): (msg: ToCore) => void {
    let tab: Tab | null = null;
    return (msg) => {
      if (msg.kind === 'attach') {
        if (msg.build !== this.build) {
          port.post({ kind: 'stale', build: this.build });
          return;
        }
        tab = { port, topics: new Set(), peek: new Set(), heard: this.clock.now() };
        this.tabs.set(port, tab);
        this.nick = msg.nick;
        port.post({ kind: 'phase', phase: this.phase });
        if (this.subbed && this.ready) port.post({ kind: 'frame', frame: this.subbed as unknown as RtFrame });
        if (this.me) port.post({ kind: 'frame', frame: this.me });
        if (this.linger !== null) {
          this.clock.clearTimeout(this.linger);
          this.linger = null;
        }
        if (!this.ws && this.retry === null) this.dial();
        return;
      }
      if (!tab || !this.tabs.has(port)) return;
      tab.heard = this.clock.now();
      switch (msg.kind) {
        case 'set': {
          const before = tab.topics;
          const topics = new Set(msg.topics.map(normalTopic));
          tab.topics = topics;
          tab.peek = new Set((msg.peek ?? []).map(normalTopic).filter((t) => topics.has(t)));
          if (!this.changed() && this.subbed && this.ready) tab.port.post({ kind: 'frame', frame: this.subbed as unknown as RtFrame });
          this.retell(tab, [...topics].filter((t) => !before.has(t)));
          break;
        }
        case 'ping':
          break;
        case 'focus':
          this.sendSub(false);
          break;
        case 'bye':
          this.drop(tab);
          break;
        case 'ask':
          this.ask(tab, msg.rid, msg.ask);
          break;
        case 'fill':
          this.fill(msg.since);
          break;
        case 'fresh':
          this.fresh.add(normalTopic(msg.topic));
          this.sendSub(false);
          break;
        case 'identify':
          this.nick = msg.nick;
          this.identify();
          break;
      }
    };
  }

  tabCount(): number {
    return this.tabs.size;
  }

  topics(): string[] {
    return this.union.slice();
  }

  peeked(): string[] {
    return this.peek.slice();
  }

  sinceFor(topic: string): string | undefined {
    return this.latest.get(topic);
  }

  stop() {
    this.clock.clearInterval(this.resync);
    this.clock.clearInterval(this.sweep);
    for (const tab of this.tabs.values()) this.drop(tab);
    this.hangUp();
    this.setPhase('off');
  }

  private setPhase(next: RtPhase) {
    if (this.phase === next) return;
    this.phase = next;
    for (const tab of this.tabs.values()) tab.port.post({ kind: 'phase', phase: next });
  }

  private computeUnion(): { topics: string[]; peek: string[] } {
    const all = new Set<string>();
    const real = new Set<string>();
    for (const tab of this.tabs.values()) {
      for (const t of tab.topics) {
        all.add(t);
        if (!tab.peek.has(t)) real.add(t);
      }
    }
    const topics = [...all].sort();
    return { topics, peek: topics.filter((t) => !real.has(t)) };
  }

  private changed(): boolean {
    const { topics: next, peek } = this.computeUnion();
    const same = sameList(next, this.union) && sameList(peek, this.peek);
    if (same) return false;
    this.union = next;
    this.peek = peek;
    const held = new Set(next);
    for (const topic of this.latest.keys()) if (!covers(held, topic)) this.latest.delete(topic);
    for (const topic of this.counts.keys()) if (!covers(held, topic)) this.counts.delete(topic);
    for (const name of this.presences.keys()) if (!held.has(`presence:${name}`)) this.presences.delete(name);
    for (const topic of this.fresh) if (!held.has(topic)) this.fresh.delete(topic);
    this.sendSub(false);
    return true;
  }

  private drop(tab: Tab) {
    if (!this.tabs.delete(tab.port)) return;
    for (const [rid, p] of this.pending) {
      if (p.tab !== tab) continue;
      this.clock.clearTimeout(p.timer);
      this.pending.delete(rid);
    }
    try {
      tab.port.close();
    } catch {
      return;
    }
    this.changed();
    if (this.tabs.size === 0 && this.linger === null) {
      this.linger = this.clock.setTimeout(() => {
        this.linger = null;
        if (this.tabs.size > 0) return;
        this.hangUp();
        this.setPhase('off');
      }, LINGER_MS);
    }
  }

  private dropDead() {
    const now = this.clock.now();
    for (const tab of this.tabs.values()) if (now - tab.heard > TAB_DEAD_MS) this.drop(tab);
  }

  private dial() {
    this.retry = null;
    if (this.tabs.size === 0) return;
    this.hangUp();
    this.setPhase('connecting');
    let socket: SocketLike;
    try {
      socket = this.open(this.url);
    } catch {
      this.closed(1006);
      return;
    }
    this.ws = socket;
    this.armWatchdog();
    socket.onopen = () => {
      if (this.ws !== socket) return;
      const hello: HelloOut = { type: 'hello', v: RT_VERSION };
      if (this.nick) hello.nick = this.nick;
      socket.send(JSON.stringify(hello));
    };
    socket.onmessage = (e) => {
      if (this.ws !== socket) return;
      this.armWatchdog();
      const frame = parseFrame(e.data);
      if (frame) this.onFrame(frame);
    };
    socket.onclose = (e) => {
      if (this.ws !== socket) return;
      this.closed(e.code);
    };
    socket.onerror = () => undefined;
  }

  private hangUp() {
    const socket = this.ws;
    this.ws = null;
    this.ready = false;
    this.subbed = null;
    this.presences.clear();
    this.counts.clear();
    if (this.watchdog !== null) this.clock.clearTimeout(this.watchdog);
    this.watchdog = null;
    if (this.mismatch !== null) this.clock.clearTimeout(this.mismatch);
    this.mismatch = null;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      try {
        socket.close();
      } catch {
        return;
      }
    }
  }

  private closed(code: number) {
    this.hangUp();
    this.failAll('chat is down');
    this.setPhase(this.tabs.size > 0 ? 'closed' : 'off');
    if (this.tabs.size === 0 || this.retry !== null) return;
    let wait: number;
    if (code === 1001) {
      this.failures = 0;
      wait = restartDelay(() => this.clock.random());
    } else {
      this.failures += 1;
      wait = retryDelay(this.failures, () => this.clock.random());
    }
    this.retry = this.clock.setTimeout(() => this.dial(), wait);
  }

  private armWatchdog() {
    if (this.watchdog !== null) this.clock.clearTimeout(this.watchdog);
    this.watchdog = this.clock.setTimeout(() => {
      this.watchdog = null;
      this.closed(4000);
    }, WATCHDOG_MS);
  }

  private onFrame(frame: RtFrame) {
    switch (frame.type) {
      case 'ready':
        this.ready = true;
        this.failures = 0;
        this.setPhase('open');
        this.sendSub(true);
        return;
      case 'subbed':
        this.onSubbed(frame as unknown as Subbed);
        this.toAll(frame);
        return;
      case 'ack':
      case 'nack':
        this.answer(frame as unknown as Answer);
        return;
      case 'behind':
        this.sendSub(true);
        return;
      case 'beat':
        return;
      case 'authed':
        this.toAll(frame);
        if (frame.ok !== true && this.ws) this.closed(1001);
        return;
    }
    const topic = typeof frame.topic === 'string' ? frame.topic : null;
    if (topic === null) {
      this.remember(frame);
      this.toAll(frame);
      return;
    }
    if (frame.type === 'message' && isLineId(frame.id)) this.saw(topic, frame.id);
    if (frame.type === 'count') this.counts.set(normalTopic(topic), frame);
    for (const tab of this.tabs.values()) if (covers(tab.topics, topic)) tab.port.post({ kind: 'frame', frame });
  }

  private remember(frame: RtFrame) {
    const name = typeof frame.name === 'string' ? frame.name.toLowerCase() : null;
    if (frame.type === 'me') this.me = frame;
    else if (frame.type === 'presence' && name !== null) this.presences.set(name, frame);
    else if (frame.type === 'renamed' && name !== null) {
      this.presences.delete(name);
      if (this.me && typeof this.me.name === 'string' && this.me.name.toLowerCase() === name) this.me = { ...this.me, name: frame.to };
    }
  }

  private retell(tab: Tab, added: string[]) {
    if (!this.ready || added.length === 0) return;
    for (const topic of added) {
      if (topic.startsWith('presence:')) {
        const said = this.presences.get(topic.slice('presence:'.length));
        if (said) tab.port.post({ kind: 'frame', frame: said });
      }
      const one = new Set([topic]);
      for (const [counted, frame] of this.counts) if (covers(one, counted)) tab.port.post({ kind: 'frame', frame });
    }
  }

  private toAll(frame: RtFrame) {
    for (const tab of this.tabs.values()) tab.port.post({ kind: 'frame', frame });
  }

  private saw(topic: string, id: string) {
    const have = this.latest.get(topic);
    if (!have || compareIds(id, have) > 0) this.latest.set(topic, id);
  }

  private fill(since: Record<string, string>) {
    const held = new Set(this.union);
    const asked: Record<string, string> = {};
    for (const [raw, id] of Object.entries(since)) {
      const topic = normalTopic(raw);
      if (!isLineId(id) || !covers(held, topic)) continue;
      this.saw(topic, id);
      asked[topic] = id;
    }
    if (Object.keys(asked).length > 0) this.sendSub(false, asked);
  }

  private onSubbed(frame: Subbed) {
    if (frame.rev !== this.rev) return;
    this.subbed = frame;
    const held = new Set(frame.topics ?? []);
    const told = new Set([...(frame.refused ?? []).map((r) => r.topic), ...(frame.evicted ?? [])]);
    const wanted = new Set(this.union);
    const missing = this.union.some((t) => !held.has(t) && !told.has(t));
    const extra = [...held].some((t) => !wanted.has(t));
    if (!missing && !extra) return;
    if (this.mismatch !== null) return;
    this.mismatch = this.clock.setTimeout(() => {
      this.mismatch = null;
      this.sendSub(false);
    }, MISMATCH_RESEND_MS);
  }

  private sendSub(allSince: boolean, asked: Record<string, string> = {}) {
    const socket = this.ws;
    if (!socket || !this.ready || socket.readyState !== OPEN) return;
    this.rev += 1;
    const frame: SubOut = { type: 'sub', rev: this.rev, topics: this.union.slice() };
    if (this.peek.length > 0) frame.peek = this.peek.slice();
    const since: Record<string, string> = allSince ? Object.fromEntries(this.latest) : {};
    Object.assign(since, asked);
    if (Object.keys(since).length > 0) frame.since = since;
    if (this.fresh.size > 0) {
      frame.fresh = [...this.fresh];
      this.fresh.clear();
    }
    socket.send(JSON.stringify(frame));
  }

  private ask(tab: Tab, rid: string, ask: Ask) {
    const socket = this.ws;
    const topic = normalTopic(ask.topic);
    if (!socket || !this.ready || socket.readyState !== OPEN || !isChatTopic(topic)) {
      tab.port.post({ kind: 'answer', rid, answer: { type: 'nack', rid, error: 'chat is down' } });
      return;
    }
    this.seq += 1;
    const wire = `r${this.seq}`;
    const timer = this.clock.setTimeout(() => {
      if (!this.pending.delete(wire)) return;
      tab.port.post({ kind: 'answer', rid, answer: { type: 'nack', rid, error: 'no answer' } });
    }, ANSWER_MS);
    this.pending.set(wire, { tab, rid, timer });
    socket.send(JSON.stringify({ ...ask, topic, rid: wire }));
  }

  private answer(frame: Answer) {
    const p = this.pending.get(frame.rid);
    if (!p) return;
    this.pending.delete(frame.rid);
    this.clock.clearTimeout(p.timer);
    p.tab.port.post({ kind: 'answer', rid: p.rid, answer: { ...frame, rid: p.rid } });
  }

  private failAll(error: string) {
    for (const [wire, p] of this.pending) {
      this.pending.delete(wire);
      this.clock.clearTimeout(p.timer);
      p.tab.port.post({ kind: 'answer', rid: p.rid, answer: { type: 'nack', rid: p.rid, error } });
    }
  }

  private identify() {
    if (!this.ws || !this.ready) return;
    if (this.identifying) {
      this.identifyAgain = true;
      return;
    }
    this.identifying = true;
    const socket = this.ws;
    this.ticket().then(
      (ticket) => {
        this.identifying = false;
        if (this.ws !== socket || !this.ready || socket.readyState !== OPEN) return;
        const auth: Record<string, unknown> = { type: 'auth', ticket };
        if (this.nick) auth.nick = this.nick;
        socket.send(JSON.stringify(auth));
        if (this.identifyAgain) {
          this.identifyAgain = false;
          this.identify();
        }
      },
      () => {
        this.identifying = false;
        this.identifyAgain = false;
        if (this.ws === socket) this.closed(1001);
      }
    );
  }
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((t, i) => t === b[i]);
}
