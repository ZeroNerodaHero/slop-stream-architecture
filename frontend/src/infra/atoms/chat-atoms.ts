/**
 * The text chat next to a stream. One websocket at /chat/<name>; see docs/chat.md.
 * Same shape as the other atom modules: atoms for what renders, a module handle
 * for the socket, action functions for every transition.
 */

import { atom } from 'jotai';
import { atomWithStorage } from 'jotai/utils';

import type { Owner } from '@/infra/api';
import { forgetMe, meAtom } from '@/infra/atoms/auth-atoms';
import { relayUrl } from '@/infra/relay';
import { store } from '@/infra/store';

export interface ChatLine {
  id: string;
  from: string;
  text: string;
  streamer: boolean;
  /** said by a login: `from` really is that account */
  verified: boolean;
  at: number;
}

export type ChatPhase = 'off' | 'connecting' | 'open' | 'closed';

export const MAX_CHAT_CHARS = 500;
const KEEP_LINES = 500;
const RECONNECT_MS = 3000;
const NICK_RE = /^[a-zA-Z0-9_-]{1,24}$/;

/** Your name without an account. Remembered across pages and visits (localstorage). */
export const nickAtom = atomWithStorage<string>('nick', '');
export const chatPhaseAtom = atom<ChatPhase>('off');
export const chatLinesAtom = atom<ChatLine[]>([]);
export const chatCountAtom = atom(0);
export const chatDraftAtom = atom('');
export const chatNoticeAtom = atom('');
/** True while this socket speaks as the streamer. */
export const chatAsStreamerAtom = atom(false);

export const nickIsValidAtom = atom((get) => NICK_RE.test(get(nickAtom).trim()));
/** The name this browser talks as: the login, else the nick. */
export const chatSpeakerAtom = atom((get) => get(meAtom) || get(nickAtom).trim());
export const chatCanSendAtom = atom((get) => {
  const length = chars(get(chatDraftAtom).trim());
  return get(chatPhaseAtom) === 'open' && length > 0 && length <= MAX_CHAT_CHARS;
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

/** Length the way the server counts it: unicode scalars, not utf-16 units (an emoji is one, not two). */
export function chars(text: string): number {
  return [...text].length;
}

export function setNick(raw: string) {
  store.set(nickAtom, raw.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24));
}

export function setChatDraft(raw: string) {
  // a little slack so the counter can go red. cut between scalars, never through a surrogate pair
  store.set(chatDraftAtom, [...raw].slice(0, MAX_CHAT_CHARS + 50).join(''));
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

/** The name changed (nick edited, logged in or out): say hello again as the new one. */
export function reconnectChat() {
  if (!session) return;
  const { name, owner } = session;
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
  inFlight.length = 0;
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
  if (chars(text) > MAX_CHAT_CHARS) {
    showNotice('too long');
    return;
  }
  session.ws.send(JSON.stringify({ type: 'say', text }));
  inFlight.push(text);
  store.set(chatDraftAtom, '');
}

/**
 * Lines sent and not seen back from the room yet, oldest first. The server handles a socket's
 * frames in order, so a drop (`slow down`, chat busy or down) is of the oldest, and goes back
 * into the box; a line that comes back through the room is off the list.
 */
const inFlight: string[] = [];

function connect() {
  const current = session;
  if (!current) return;
  const nick = store.get(nickAtom).trim();
  const me = store.get(meAtom) ?? null;
  if (!current.owner && !me && !isValidNick(nick)) {
    // no nick yet: wait for one, the panel calls openChat again on save
    store.set(chatPhaseAtom, 'off');
    return;
  }

  store.set(chatPhaseAtom, 'connecting');
  const ws = new WebSocket(relayUrl(`/chat/${current.name}`));
  current.ws = ws;

  ws.onopen = () => {
    // a login needs no nick: the cookie went with the handshake and the server names us
    const hello = current.owner ? { type: 'hello', nick, session: current.owner.session, token: current.owner.token } : me ? { type: 'hello' } : { type: 'hello', nick };
    ws.send(JSON.stringify(hello));
    store.set(chatPhaseAtom, 'open');
    store.set(chatAsStreamerAtom, current.owner !== null || me === current.name);
  };
  ws.onmessage = (e) => {
    let msg: { type?: string; messages?: ChatLine[]; count?: number; error?: string } & Partial<ChatLine>;
    try {
      msg = JSON.parse(String(e.data));
    } catch {
      return;
    }
    if (msg.type === 'history' && msg.messages) store.set(chatLinesAtom, msg.messages.slice(-KEEP_LINES));
    else if (msg.type === 'message' && msg.id) {
      const sent = inFlight.indexOf(msg.text ?? '');
      if (sent >= 0) inFlight.splice(sent, 1);
      appendLine(msg as ChatLine);
    } else if (msg.type === 'count' && typeof msg.count === 'number') store.set(chatCountAtom, msg.count);
    else if (msg.type === 'error' && msg.error) {
      // the server refused who we are (bad nick, somebody's name): back to the nick box, no retry loop
      const refused = /nick|account/.test(msg.error);
      showNotice(msg.error, refused ? 8000 : 3000);
      // the oldest line out was not taken: back into the box, unless something new is being typed
      if (/slow down|chat is (busy|down)/.test(msg.error)) {
        const lost = inFlight.shift();
        if (lost && !store.get(chatDraftAtom)) store.set(chatDraftAtom, lost);
      }
      if (refused && session === current) {
        closeChat(false);
        // a login is only ever refused when its cookie died (logout-all, passwd): stop being that name
        if (me) forgetMe();
      }
    }
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

function showNotice(text: string, ms = 3000) {
  store.set(chatNoticeAtom, text);
  if (notice) clearTimeout(notice);
  notice = setTimeout(() => store.set(chatNoticeAtom, ''), ms);
}

function sameOwner(a: Owner | null, b: Owner | null): boolean {
  return (a === null && b === null) || (a !== null && b !== null && a.session === b.session && a.token === b.token);
}
