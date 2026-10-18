/**
 * The text chat next to a stream. One websocket at /chat/<name>; see docs/chat.md.
 * Same shape as the other atom modules: atoms for what renders, a module handle
 * for the socket, action functions for every transition.
 */

import { atom } from 'jotai';
import { atomWithStorage } from 'jotai/utils';

import type { Owner } from '@/infra/api';
import { relayUrl } from '@/infra/relay';
import { store } from '@/infra/store';

export interface ChatLine {
  id: string;
  from: string;
  text: string;
  streamer: boolean;
  at: number;
}

export type ChatPhase = 'off' | 'connecting' | 'open' | 'closed';

export const MAX_CHAT_CHARS = 500;
const KEEP_LINES = 500;
const RECONNECT_MS = 3000;
const NICK_RE = /^[a-zA-Z0-9_-]{1,24}$/;

/** Remembered across pages and visits. */
export const nickAtom = atomWithStorage<string>('nick', '');
export const chatPhaseAtom = atom<ChatPhase>('off');
export const chatLinesAtom = atom<ChatLine[]>([]);
export const chatCountAtom = atom(0);
export const chatDraftAtom = atom('');
export const chatNoticeAtom = atom('');
/** True while this socket speaks as the streamer. */
export const chatAsStreamerAtom = atom(false);

export const nickIsValidAtom = atom((get) => NICK_RE.test(get(nickAtom).trim()));
export const chatCanSendAtom = atom((get) => {
  const draft = get(chatDraftAtom).trim();
  return get(chatPhaseAtom) === 'open' && draft.length > 0 && draft.length <= MAX_CHAT_CHARS;
});

interface Session {
  name: string;
  owner: Owner | null;
  ws: WebSocket | null;
  timer: ReturnType<typeof setTimeout> | null;
}

let session: Session | null = null;
let notice: ReturnType<typeof setTimeout> | null = null;

export function isValidNick(nick: string): boolean {
  return NICK_RE.test(nick.trim());
}

export function setNick(raw: string) {
  store.set(nickAtom, raw.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24));
}

export function setChatDraft(raw: string) {
  store.set(chatDraftAtom, raw.slice(0, MAX_CHAT_CHARS + 50)); // a little slack so the counter can go red
}

/**
 * Join a room. With `owner` (the streamer's own grant) the server marks our lines.
 * Calling it again for the same room with a different owner reconnects.
 */
export function openChat(name: string, owner: Owner | null = null) {
  if (session && session.name === name && sameOwner(session.owner, owner) && session.ws) return;
  closeChat(false);
  session = { name, owner, ws: null, timer: null };
  connect();
}

export function closeChat(reset = true) {
  if (!session) return;
  if (session.timer) clearTimeout(session.timer);
  if (session.ws) {
    session.ws.onclose = null;
    session.ws.close();
  }
  session = null;
  if (reset) {
    store.set(chatLinesAtom, []);
    store.set(chatCountAtom, 0);
    store.set(chatAsStreamerAtom, false);
    store.set(chatDraftAtom, '');
    store.set(chatNoticeAtom, '');
  }
  store.set(chatPhaseAtom, 'off');
}

export function sendChat() {
  const text = store.get(chatDraftAtom).trim();
  if (!session?.ws || session.ws.readyState !== WebSocket.OPEN || !text) return;
  if (text.length > MAX_CHAT_CHARS) {
    showNotice('too long');
    return;
  }
  session.ws.send(JSON.stringify({ type: 'say', text }));
  store.set(chatDraftAtom, '');
}

function connect() {
  const current = session;
  if (!current) return;
  const nick = store.get(nickAtom).trim();
  if (!current.owner && !isValidNick(nick)) {
    // no nick yet: wait for one, the panel calls openChat again on save
    store.set(chatPhaseAtom, 'off');
    return;
  }

  store.set(chatPhaseAtom, 'connecting');
  const ws = new WebSocket(relayUrl(`/chat/${current.name}`));
  current.ws = ws;

  ws.onopen = () => {
    const hello = current.owner ? { type: 'hello', nick, session: current.owner.session, token: current.owner.token } : { type: 'hello', nick };
    ws.send(JSON.stringify(hello));
    store.set(chatPhaseAtom, 'open');
    store.set(chatAsStreamerAtom, current.owner !== null);
  };
  ws.onmessage = (e) => {
    let msg: { type?: string; messages?: ChatLine[]; count?: number; error?: string } & Partial<ChatLine>;
    try {
      msg = JSON.parse(String(e.data));
    } catch {
      return;
    }
    if (msg.type === 'history' && msg.messages) store.set(chatLinesAtom, msg.messages.slice(-KEEP_LINES));
    else if (msg.type === 'message' && msg.id) appendLine(msg as ChatLine);
    else if (msg.type === 'count' && typeof msg.count === 'number') store.set(chatCountAtom, msg.count);
    else if (msg.type === 'error' && msg.error) showNotice(msg.error);
  };
  ws.onclose = () => {
    if (session !== current) return;
    store.set(chatPhaseAtom, 'closed');
    current.ws = null;
    current.timer = setTimeout(connect, RECONNECT_MS);
  };
}

function appendLine(line: ChatLine) {
  const lines = store.get(chatLinesAtom);
  if (lines.length && lines[lines.length - 1]?.id === line.id) return;
  const next = lines.length >= KEEP_LINES ? lines.slice(lines.length - KEEP_LINES + 1) : lines.slice();
  next.push(line);
  store.set(chatLinesAtom, next);
}

function showNotice(text: string) {
  store.set(chatNoticeAtom, text);
  if (notice) clearTimeout(notice);
  notice = setTimeout(() => store.set(chatNoticeAtom, ''), 3000);
}

function sameOwner(a: Owner | null, b: Owner | null): boolean {
  return (a === null && b === null) || (a !== null && b !== null && a.session === b.session && a.token === b.token);
}
