import { type Clock, type FromCore, type Port, RtCore, type SocketLike, type ToCore } from '../src/infra/rt/core.ts';

interface Timer {
  at: number;
  run: () => void;
  every: number | null;
  id: number;
}

export class FakeClock implements Clock {
  time = 0;
  rolls: number[] = [];
  private timers = new Map<number, Timer>();
  private next = 1;

  now() {
    return this.time;
  }

  random() {
    return this.rolls.length ? this.rolls.shift()! : 0;
  }

  setTimeout(run: () => void, ms: number) {
    const id = this.next++;
    this.timers.set(id, { at: this.time + ms, run, every: null, id });
    return id;
  }

  clearTimeout(handle: unknown) {
    this.timers.delete(handle as number);
  }

  setInterval(run: () => void, ms: number) {
    const id = this.next++;
    this.timers.set(id, { at: this.time + ms, run, every: ms, id });
    return id;
  }

  clearInterval(handle: unknown) {
    this.timers.delete(handle as number);
  }

  advance(ms: number) {
    const end = this.time + ms;
    for (;;) {
      const due = [...this.timers.values()].filter((t) => t.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.time = due.at;
      if (due.every === null) this.timers.delete(due.id);
      else due.at += due.every;
      due.run();
    }
    this.time = end;
  }
}

export class FakeSocket implements SocketLike {
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  closedBy: number | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }

  close(code = 1000) {
    this.closedBy = code;
    this.readyState = 3;
  }

  opened() {
    this.readyState = 1;
    this.onopen?.();
  }

  hear(frame: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  serverClose(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }

  subs() {
    return this.sent.filter((f) => f.type === 'sub') as { type: 'sub'; rev: number; topics: string[]; since?: Record<string, string>; fresh?: string[] }[];
  }

  lastSub() {
    const all = this.subs();
    return all[all.length - 1];
  }
}

export class FakePort implements Port {
  got: FromCore[] = [];
  closed = false;
  send: (msg: ToCore) => void = () => undefined;

  post(msg: FromCore) {
    this.got.push(msg);
  }

  close() {
    this.closed = true;
  }

  frames(type?: string) {
    return this.got.flatMap((m) => (m.kind === 'frame' && (!type || m.frame.type === type) ? [m.frame] : []));
  }

  answers() {
    return this.got.flatMap((m) => (m.kind === 'answer' ? [m.answer] : []));
  }

  phases() {
    return this.got.flatMap((m) => (m.kind === 'phase' ? [m.phase] : []));
  }
}

export function rig(ticket: () => Promise<string> = () => Promise.resolve('t'.repeat(32))) {
  const clock = new FakeClock();
  const sockets: FakeSocket[] = [];
  const core = new RtCore({
    url: 'ws://x/rt',
    build: 'b1',
    clock,
    ticket,
    open: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    }
  });
  const tab = (nick: string | null = null, build = 'b1') => {
    const port = new FakePort();
    port.send = core.connect(port);
    port.send({ kind: 'attach', build, nick });
    return port;
  };
  const socket = () => sockets[sockets.length - 1]!;
  const up = () => {
    const s = socket();
    s.opened();
    s.hear({ type: 'ready', v: 1, beat: 20000 });
    return s;
  };
  return { clock, core, sockets, socket, tab, up };
}
