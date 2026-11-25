export interface Session {
  id: number;
  name: string;
  avatar: number | null;
  start: number;
  end: number | null;
}

export interface Run {
  session: number;
  name: string;
  avatar: number | null;
  from: number;
  to: number;
  x: number;
}

export interface Gap {
  x: number;
  name: string;
  from: number;
  to: number | null;
}

export interface Layout {
  xs: number[];
  span: number;
  runs: Run[];
  gaps: Gap[];
}

export const MAX_SESSIONS = 50;

export class SessionLog {
  readonly list: Session[] = [];
  private next = 0;

  get current(): Session | null {
    const last = this.list[this.list.length - 1];
    return last && last.end === null ? last : null;
  }

  begin(name: string, at: number, avatar: number | null = null): Session {
    this.end(at);
    const session: Session = { id: this.next++, name, avatar, start: at, end: null };
    this.list.push(session);
    if (this.list.length > MAX_SESSIONS) this.list.splice(0, this.list.length - MAX_SESSIONS);
    return session;
  }

  end(at: number): void {
    const current = this.current;
    if (current) current.end = at;
  }

  clear(): void {
    this.list.length = 0;
    this.next = 0;
  }
}

export function layout(t: ArrayLike<number>, session: ArrayLike<number>, sessions: readonly Session[], capacity = t.length, stepMs = 1000): Layout {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const xs: number[] = [];
  const runs: Run[] = [];
  const gaps: Gap[] = [];
  let x = 0;
  for (let i = 0; i < t.length; i++) {
    const id = session[i]!;
    const run = runs[runs.length - 1];
    if (!run || run.session !== id) {
      if (run) {
        const ended = byId.get(run.session);
        const next = byId.get(id);
        gaps.push({ x, name: run.name, from: ended?.end ?? t[i - 1]!, to: next?.start ?? t[i]! });
        run.to = i;
      }
      const s = byId.get(id);
      runs.push({ session: id, name: s?.name ?? '', avatar: s?.avatar ?? null, from: i, to: t.length, x });
    } else {
      x += Math.max(0, t[i]! - t[i - 1]!);
    }
    xs.push(x);
  }
  const last = runs[runs.length - 1];
  const lastEnd = last ? byId.get(last.session)?.end : null;
  if (last && lastEnd != null) gaps.push({ x, name: last.name, from: lastEnd, to: null });
  const span = fullSpan(x, t.length, capacity, stepMs);
  const shift = span - x;
  if (shift > 0) {
    for (let i = 0; i < xs.length; i++) xs[i] = xs[i]! + shift;
    for (const run of runs) run.x += shift;
    for (const gap of gaps) gap.x += shift;
  }
  return { xs, span, runs, gaps };
}

function fullSpan(x: number, count: number, capacity: number, stepMs: number): number {
  if (count === 0 || count >= capacity) return Math.max(x, 1);
  const room = Math.max(capacity - 1, 1);
  if (count === 1 || x <= 0) return Math.max(room * stepMs, x, 1);
  return Math.max((x * room) / (count - 1), x, 1);
}
