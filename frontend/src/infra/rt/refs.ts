import { normalTopic } from './wire.ts';

export type Release = () => void;

export class TopicRefs {
  private readonly refs = new Map<string, number>();
  private readonly onChange: (topics: string[]) => void;
  private readonly schedule: (run: () => void) => void;
  private queued = false;
  private last: string[] = [];

  constructor(onChange: (topics: string[]) => void, schedule: (run: () => void) => void = (run) => queueMicrotask(run)) {
    this.onChange = onChange;
    this.schedule = schedule;
  }

  acquire(raw: string): Release {
    const topic = normalTopic(raw);
    this.refs.set(topic, (this.refs.get(topic) ?? 0) + 1);
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

  holds(raw: string): boolean {
    return this.refs.has(normalTopic(raw));
  }

  count(raw: string): number {
    return this.refs.get(normalTopic(raw)) ?? 0;
  }

  topics(): string[] {
    return [...this.refs.keys()].sort();
  }

  private changed() {
    if (this.queued) return;
    this.queued = true;
    this.schedule(() => {
      this.queued = false;
      const now = this.topics();
      if (now.length === this.last.length && now.every((t, i) => t === this.last[i])) return;
      this.last = now;
      this.onChange(now);
    });
  }
}
