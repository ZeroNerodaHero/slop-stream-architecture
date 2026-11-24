import { normalTopic } from './wire.ts';

export type Release = () => void;

export const PEEK_TTL_MS = 5000;

export interface PeekTimers {
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

const realTimers: PeekTimers = {
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>)
};

export class TopicRefs {
  private readonly refs = new Map<string, number>();
  private readonly peeks = new Map<string, unknown>();
  private readonly onChange: (topics: string[], peek: string[]) => void;
  private readonly schedule: (run: () => void) => void;
  private readonly timers: PeekTimers;
  private queued = false;
  private last: string[] = [];
  private lastPeek: string[] = [];

  constructor(
    onChange: (topics: string[], peek: string[]) => void,
    schedule: (run: () => void) => void = (run) => queueMicrotask(run),
    timers: PeekTimers = realTimers
  ) {
    this.onChange = onChange;
    this.schedule = schedule;
    this.timers = timers;
  }

  acquire(raw: string): Release {
    const topic = normalTopic(raw);
    this.refs.set(topic, (this.refs.get(topic) ?? 0) + 1);
    this.unpeek(topic);
    this.changed();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const n = this.refs.get(topic) ?? 0;
      if (n <= 1) this.refs.delete(topic);
      else this.refs.set(topic, n - 1);
      this.changed();
    };
  }

  peek(raw: string, ttl = PEEK_TTL_MS): void {
    const topic = normalTopic(raw);
    if (this.refs.has(topic)) return;
    this.unpeek(topic);
    this.peeks.set(
      topic,
      this.timers.setTimeout(() => {
        if (!this.peeks.has(topic)) return;
        this.peeks.delete(topic);
        this.changed();
      }, ttl)
    );
    this.changed();
  }

  holds(raw: string): boolean {
    const topic = normalTopic(raw);
    return this.refs.has(topic) || this.peeks.has(topic);
  }

  peeking(raw: string): boolean {
    return this.peeks.has(normalTopic(raw));
  }

  count(raw: string): number {
    return this.refs.get(normalTopic(raw)) ?? 0;
  }

  topics(): string[] {
    return [...new Set([...this.refs.keys(), ...this.peeks.keys()])].sort();
  }

  peeked(): string[] {
    return [...this.peeks.keys()].sort();
  }

  private unpeek(topic: string) {
    if (!this.peeks.has(topic)) return;
    this.timers.clearTimeout(this.peeks.get(topic));
    this.peeks.delete(topic);
  }

  private changed() {
    if (this.queued) return;
    this.queued = true;
    this.schedule(() => {
      this.queued = false;
      const now = this.topics();
      const peek = this.peeked();
      if (same(now, this.last) && same(peek, this.lastPeek)) return;
      this.last = now;
      this.lastPeek = peek;
      this.onChange(now, peek);
    });
  }
}

function same(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((t, i) => t === b[i]);
}
