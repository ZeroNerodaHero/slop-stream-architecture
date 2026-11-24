export const RT_VERSION = 1;
export const RT_PATH = '/rt';
export const RT_TICKET_PATH = '/rt/ticket';

export const TAB_PING_MS = 15_000;
export const TAB_DEAD_MS = 60_000;
export const WATCHDOG_MS = 45_000;
export const RESYNC_MS = 60_000;
export const MISMATCH_RESEND_MS = 1_000;
export const ANSWER_MS = 10_000;
export const RETRY_FIRST_MS = 250;
export const RETRY_MAX_MS = 30_000;
export const RESTART_SPREAD_MS = 1_500;
export const WORKER_WAIT_MS = 2_000;

export type RtPhase = 'off' | 'connecting' | 'open' | 'closed';

export interface Refusal {
  topic: string;
  error: string;
}

export interface Subbed {
  type: 'subbed';
  rev: number;
  topics: string[];
  refused: Refusal[];
  evicted: string[];
}

export interface Ack {
  type: 'ack';
  rid: string;
  id?: string;
}

export interface Nack {
  type: 'nack';
  rid: string;
  error: string;
  wait?: number;
}

export type Answer = Ack | Nack;

export type RtFrame = { type: string; topic?: string; [key: string]: unknown };

export interface SubOut {
  type: 'sub';
  rev: number;
  topics: string[];
  since?: Record<string, string>;
  fresh?: string[];
  peek?: string[];
}

export interface HelloOut {
  type: 'hello';
  v: number;
  nick?: string;
}

export type Ask = { type: 'say'; topic: string; [key: string]: unknown } | { type: 'react'; topic: string; [key: string]: unknown };

export function normalTopic(topic: string): string {
  return topic.trim().toLowerCase();
}

export function isChatTopic(topic: string): boolean {
  return topic.startsWith('chat:');
}

export function chatTopicOf(room: string): string {
  return normalTopic(`chat:${room}`);
}

export function wildcardOf(topic: string): string | null {
  if (!isChatTopic(topic)) return null;
  const rest = topic.slice('chat:'.length);
  const slash = rest.indexOf('/');
  if (slash < 0 || rest.slice(slash + 1) === '*') return null;
  return `chat:${rest.slice(0, slash)}/*`;
}

export function channelOf(topic: string): string | null {
  if (!isChatTopic(topic)) return null;
  const rest = topic.slice('chat:'.length);
  const slash = rest.indexOf('/');
  return slash < 0 ? null : rest.slice(slash + 1);
}

export function covers(held: ReadonlySet<string>, topic: string): boolean {
  if (held.has(topic)) return true;
  const every = wildcardOf(topic);
  return every !== null && held.has(every);
}

function idParts(id: string): [number, number] {
  const [ms, seq] = id.split('-');
  return [Number(ms) || 0, Number(seq) || 0];
}

export function compareIds(a: string, b: string): number {
  const [ams, aseq] = idParts(a);
  const [bms, bseq] = idParts(b);
  return ams === bms ? aseq - bseq : ams - bms;
}

export function isLineId(id: unknown): id is string {
  return typeof id === 'string' && /^\d+-\d+$/.test(id);
}

export function parseFrame(data: unknown): RtFrame | null {
  if (typeof data !== 'string') return null;
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || typeof (raw as { type?: unknown }).type !== 'string') return null;
  return raw as RtFrame;
}

export function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const have = new Set(a);
  return b.every((t) => have.has(t));
}

export function retryDelay(failures: number, random: () => number): number {
  const base = Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** Math.max(0, failures - 1));
  return Math.min(RETRY_MAX_MS, Math.round(base + base * 0.5 * random()));
}

export function restartDelay(random: () => number): number {
  return Math.round(RESTART_SPREAD_MS * random());
}

export function rtSocketUrl(href: string): string {
  const u = new URL(RT_PATH, href);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return u.href;
}

export async function fetchTicket(href: string): Promise<string> {
  const res = await fetch(new URL(RT_TICKET_PATH, href), { method: 'POST', credentials: 'same-origin', cache: 'no-store' });
  const body = (await res.json().catch(() => null)) as { ticket?: unknown } | null;
  if (!res.ok || typeof body?.ticket !== 'string') throw new Error(`rt ticket: http ${res.status}`);
  return body.ticket;
}

export function rtWanted(href: string, storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null): boolean {
  let flag: string | null = null;
  try {
    flag = new URL(href).searchParams.get('rt');
  } catch {
    flag = null;
  }
  try {
    if (flag === '0') storage?.setItem('rt', '0');
    else if (flag === '1') storage?.removeItem('rt');
    if (flag === '0' || flag === '1') return flag === '1';
    return storage?.getItem('rt') !== '0';
  } catch {
    return flag !== '0';
  }
}
