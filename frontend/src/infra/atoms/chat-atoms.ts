/**
 * The text chat next to a stream, and in a server's channel. One websocket at
 * /chat/<name> or /chat/<server>/<channel>; see docs/chat.md.
 * Same shape as the other atom modules: atoms for what renders, a module handle
 * for the socket, action functions for every transition.
 */

import { atom } from 'jotai';
import { atomWithStorage } from 'jotai/utils';

import type { GroupBadge, Owner } from '@/infra/api';
import { forgetMe, meAtom } from '@/infra/atoms/auth-atoms';
import { record } from '@/infra/atoms/inspector-atoms';
import { hideBotsAtom } from '@/infra/atoms/settings-atoms';
import { relayUrl } from '@/infra/relay';
import { store } from '@/infra/store';

export interface ChatLine {
  id: string;
  from: string;
  text: string;
  streamer: boolean;
  /** said by a login: `from` really is that account */
  verified: boolean;
  /** the speaker's groups as badges, `bot` first when it is one. see docs/groups.md */
  groups: GroupBadge[];
  /** the speaker's picture (its `?v=`, as everywhere in the api), or null for none. only a `verified` or `streamer` line can have one */
  avatar: number | null;
  at: number;
  /** A picture on the line, the id from `POST /api/chat-images`. Null, or absent on an older chat, when there is none. */
  image?: string | null;
}

/** The automatic group a socket that says `bot: true` wears. The hide switch keys on it. */
export const BOT_GROUP = 'bot';

export function isBotLine(line: ChatLine): boolean {
  return line.groups.some((g) => g.name === BOT_GROUP);
}

export type ChatPhase = 'off' | 'connecting' | 'open' | 'closed';

export const MAX_CHAT_CHARS = 500;
const KEEP_LINES = 500;
const RECONNECT_MS = 3000;

/** A stream is one segment. A server channel is two (`vip/general`): encode each, keep the slash. */
function chatPath(room: string): string {
  return room.split('/').map((part) => encodeURIComponent(part)).join('/');
}
const NICK_RE = /^[a-zA-Z0-9_-]{1,24}$/;

/** Your name without an account. Remembered across pages and visits (localstorage). */
// read at init, not on first mount: the events socket says hello as this name from main.tsx,
// before any component has mounted (docs/status.md)
export const nickAtom = atomWithStorage<string>('nick', '', undefined, { getOnInit: true });
export const chatPhaseAtom = atom<ChatPhase>('off');
export const chatLinesAtom = atom<ChatLine[]>([]);
export const chatCountAtom = atom(0);
export const chatDraftAtom = atom('');
/** A picture waiting to go with the next line, the id `POST /api/chat-images` returned. */
export const chatImageAtom = atom<string | null>(null);
export const chatNoticeAtom = atom('');
/** True while this socket speaks as the streamer. */
export const chatAsStreamerAtom = atom(false);

/** The lines on screen: every line, or without the bots' while `hideBotsAtom` is on. */
export const visibleChatLinesAtom = atom((get) => {
  const lines = get(chatLinesAtom);
  return get(hideBotsAtom) ? lines.filter((line) => !isBotLine(line)) : lines;
});
/** How many lines the switch is holding back right now. 0 while it is off. */
export const hiddenBotLinesAtom = atom((get) => (get(hideBotsAtom) ? get(chatLinesAtom).filter(isBotLine).length : 0));

/** Search hits, or one account's lines, newest first. Null when the list is closed. */
export const chatResultsAtom = atom<ChatLine[] | null>(null);
/** The query, or the account name, that `chatResultsAtom` is for. */
export const chatResultsForAtom = atom('');
/** The panel is showing a window around an old line, not the live tail. */
export const chatPinnedAtom = atom(false);
/** Lines that arrived in the live tail while the panel was pinned to an old one. */
export const chatBehindAtom = atom(0);
/** Bumped when the panel should scroll and the lines themselves did not change. */
export const chatScrollAtom = atom(0);

/** One page of older lines. A short page is the end. Matches `PAGE` in history.rs. */
const OLDER_PAGE = 50;
/** Loaded lines kept while the reader has scrolled up. The live tail, stuck to the bottom, stays at KEEP_LINES. */
const MAX_LOADED = 2000;

type ScrollPlan = 'bottom' | 'keep' | { id: string } | null;
let scrollPlan: ScrollPlan = null;
let following = true;
let olderBusy = false;
let noMoreOlder = false;
let olderPaused = false;
let pinned = false;
let savedTail: ChatLine[] | null = null;
let behind = 0;

export const nickIsValidAtom = atom((get) => NICK_RE.test(get(nickAtom).trim()));
/** The name this browser talks as: the login, else the nick. */
export const chatSpeakerAtom = atom((get) => get(meAtom) || get(nickAtom).trim());
export const chatCanSendAtom = atom((get) => {
  const length = chars(get(chatDraftAtom).trim());
  const picture = get(chatImageAtom) !== null;
  return get(chatPhaseAtom) === 'open' && length <= MAX_CHAT_CHARS && (length > 0 || picture);
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

export function setChatImage(id: string | null) {
  store.set(chatImageAtom, id);
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

/** The name changed (nick edited, logged in or out), or its groups did: say hello again as the new one. */
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
  resetHistory();
  if (reset) {
    store.set(chatLinesAtom, []);
    store.set(chatCountAtom, 0);
    store.set(chatAsStreamerAtom, false);
    store.set(chatDraftAtom, '');
    store.set(chatImageAtom, null);
    store.set(chatNoticeAtom, '');
  }
  store.set(chatPhaseAtom, 'off');
}

export function sendChat() {
  const text = store.get(chatDraftAtom).trim();
  const image = store.get(chatImageAtom);
  if (!session?.ws || session.ws.readyState !== WebSocket.OPEN || (!text && !image)) return;
  if (chars(text) > MAX_CHAT_CHARS) {
    showNotice('too long');
    return;
  }
  const say = image ? { type: 'say', text, image } : { type: 'say', text };
  record(`/chat/${session.name}`, 'out', say);
  session.ws.send(JSON.stringify(say));
  inFlight.push({ text, image });
  store.set(chatDraftAtom, '');
  store.set(chatImageAtom, null);
}

/**
 * Lines sent and not seen back from the room yet, oldest first. The server handles a socket's
 * frames in order, so a drop (`slow down`, chat busy or down) is of the oldest, and goes back
 * into the box; a line that comes back through the room is off the list.
 */
const inFlight: { text: string; image: string | null }[] = [];

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
  const ws = new WebSocket(relayUrl(`/chat/${chatPath(current.name)}`));
  current.ws = ws;

  ws.onopen = () => {
    // a login needs no nick: the cookie went with the handshake and the server names us
    const hello = current.owner ? { type: 'hello', nick, session: current.owner.session, token: current.owner.token } : me ? { type: 'hello' } : { type: 'hello', nick };
    record(`/chat/${current.name}`, 'out', hello); // the token is taken out before it is kept
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
    record(`/chat/${current.name}`, 'in', msg);
    if (msg.type === 'history' && msg.messages) {
      resetHistory();
      scrollPlan = 'bottom';
      store.set(chatLinesAtom, msg.messages.slice(-KEEP_LINES).map(fromWire));
    }
    else if (msg.type === 'message' && msg.id) {
      const sent = inFlight.findIndex((p) => p.text === (msg.text ?? '') && p.image === (typeof msg.image === 'string' ? msg.image : null));
      if (sent >= 0) inFlight.splice(sent, 1);
      appendLine(fromWire(msg as ChatLine));
    } else if (msg.type === 'count' && typeof msg.count === 'number') store.set(chatCountAtom, msg.count);
    else if (msg.type === 'error' && msg.error) {
      // a bad nick, or a channel that is not there: back out, and do not reconnect.
      // a channel that is not there is not a dead login.
      const refused = /nick|account/.test(msg.error);
      const gone = /no such channel|not a server|that name is reserved|bad name/.test(msg.error);
      showNotice(msg.error, refused || gone ? 8000 : 3000);
      // the oldest line out was not taken: back into the box, unless something new is being typed
      if (/slow down|chat is (busy|down)/.test(msg.error)) {
        const lost = inFlight.shift();
        if (lost?.text && !store.get(chatDraftAtom)) store.set(chatDraftAtom, lost.text);
        if (lost?.image && !store.get(chatImageAtom)) store.set(chatImageAtom, lost.image);
      }
      if ((refused || gone) && session === current) {
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

/** A line from a chat server older than the badges has no `groups`, one older than the faces no `avatar`: a line with none of either. */
function fromWire(line: ChatLine): ChatLine {
  return {
    ...line,
    groups: Array.isArray(line.groups) ? line.groups : [],
    avatar: typeof line.avatar === 'number' ? line.avatar : null,
    image: typeof line.image === 'string' && line.image ? line.image : null,
  };
}

function resetHistory() {
  pinned = false;
  savedTail = null;
  behind = 0;
  noMoreOlder = false;
  olderPaused = false;
  olderBusy = false;
  following = true;
  store.set(chatPinnedAtom, false);
  store.set(chatBehindAtom, 0);
  store.set(chatResultsAtom, null);
  store.set(chatResultsForAtom, '');
}

/** The view sits on the newest line, or the reader has scrolled up. */
export function setChatFollowing(on: boolean) {
  following = on;
}

/** Scroll a pixel away from the top and a failed older-page can be asked again. */
export function noteChatScroll(scrollTop: number) {
  if (scrollTop >= 48) olderPaused = false;
}

/**
 * The plan for the next time the lines paint: `bottom` after a join or "latest",
 * `keep` when older lines were prepended, or the id to put in the middle.
 * Read once by the panel. A tick is bumped only when the lines did not change,
 * so a line already on screen still scrolls.
 */
export function takeScrollPlan(): 'bottom' | 'keep' | { id: string } | null {
  const plan = scrollPlan;
  scrollPlan = null;
  return plan;
}

/** Older than the oldest line on screen. Redis while it still has them, postgres past that. */
export async function loadOlder() {
  const name = session?.name;
  const oldest = store.get(chatLinesAtom)[0];
  if (!name || !oldest || olderBusy || noMoreOlder || olderPaused) return;
  olderBusy = true;
  try {
    const lines = await chatGet(`/chat/${chatPath(name)}/before?id=${encodeURIComponent(oldest.id)}`);
    if (session?.name !== name) return;
    const have = new Set(store.get(chatLinesAtom).map((l) => l.id));
    const older = lines.filter((l) => !have.has(l.id));
    if (older.length === 0 || older.length < OLDER_PAGE) noMoreOlder = true;
    if (older.length === 0) return;
    scrollPlan = 'keep';
    store.set(chatLinesAtom, older.concat(store.get(chatLinesAtom)));
  } catch (err) {
    olderPaused = true;
    showNotice(err instanceof Error ? err.message : 'could not load older lines');
  } finally {
    olderBusy = false;
  }
}

/** Matches in this room, newest first. Off, the server says history is not kept. */
export async function searchRoom(raw: string) {
  const name = session?.name;
  const q = raw.trim();
  if (!name || !q) return;
  try {
    const lines = await chatGet(`/chat/${chatPath(name)}/search?q=${encodeURIComponent(q)}`);
    if (session?.name !== name) return;
    store.set(chatResultsAtom, lines);
    store.set(chatResultsForAtom, q);
  } catch (err) {
    store.set(chatResultsAtom, null);
    showNotice(err instanceof Error ? err.message : 'search failed');
  }
}

/** One account's lines in this room, newest first. A nick with no account is not one. */
export async function showSpeaker(speaker: string) {
  const name = session?.name;
  if (!name) return;
  try {
    const lines = await chatGet(`/chat/${chatPath(name)}/by/${encodeURIComponent(speaker)}`);
    if (session?.name !== name) return;
    store.set(chatResultsAtom, lines);
    store.set(chatResultsForAtom, speaker);
  } catch (err) {
    store.set(chatResultsAtom, null);
    showNotice(err instanceof Error ? err.message : 'could not load those lines');
  }
}

export function clearResults() {
  store.set(chatResultsAtom, null);
  store.set(chatResultsForAtom, '');
}

/**
 * Put `id` in view. Already loaded: just scroll. Otherwise load the window around it
 * and leave the live tail parked, so "latest" comes back to it.
 */
export async function openLine(id: string) {
  const name = session?.name;
  if (!name) return;
  if (store.get(chatLinesAtom).some((l) => l.id === id)) {
    scrollPlan = { id };
    store.set(chatScrollAtom, store.get(chatScrollAtom) + 1);
    return;
  }
  try {
    const lines = await chatGet(`/chat/${chatPath(name)}/around/${encodeURIComponent(id)}`);
    if (session?.name !== name) return;
    if (!pinned) savedTail = store.get(chatLinesAtom).slice();
    pinned = true;
    following = false;
    store.set(chatPinnedAtom, true);
    scrollPlan = { id };
    store.set(chatLinesAtom, lines);
  } catch (err) {
    showNotice(err instanceof Error ? err.message : 'could not open that line');
  }
}

/** Back to the live tail that was on screen before a jump. */
export function backToLatest() {
  const tail = savedTail;
  savedTail = null;
  pinned = false;
  behind = 0;
  following = true;
  noMoreOlder = false;
  store.set(chatPinnedAtom, false);
  store.set(chatBehindAtom, 0);
  scrollPlan = 'bottom';
  if (tail) store.set(chatLinesAtom, tail);
  else store.set(chatScrollAtom, store.get(chatScrollAtom) + 1);
}

async function chatGet(path: string): Promise<ChatLine[]> {
  const res = await fetch(path, { cache: 'no-store' });
  let data: { lines?: ChatLine[]; error?: string } | null = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) throw new Error(data?.error || `http ${res.status}`);
  return (data?.lines ?? []).map(fromWire);
}

function appendLine(line: ChatLine) {
  if (pinned && savedTail) {
    if (savedTail[savedTail.length - 1]?.id === line.id) return;
    savedTail.push(line);
    if (savedTail.length > MAX_LOADED) savedTail.splice(0, savedTail.length - MAX_LOADED);
    behind += 1;
    store.set(chatBehindAtom, behind);
    return;
  }
  const lines = store.get(chatLinesAtom);
  if (lines.length && lines[lines.length - 1]?.id === line.id) return;
  const cap = following ? KEEP_LINES : MAX_LOADED;
  const next = lines.length >= cap ? lines.slice(lines.length - cap + 1) : lines.slice();
  if (next.length < lines.length) noMoreOlder = false;
  next.push(line);
  store.set(chatLinesAtom, next);
}

export function showNotice(text: string, ms = 3000) {
  store.set(chatNoticeAtom, text);
  if (notice) clearTimeout(notice);
  notice = setTimeout(() => store.set(chatNoticeAtom, ''), ms);
}

function sameOwner(a: Owner | null, b: Owner | null): boolean {
  return (a === null && b === null) || (a !== null && b !== null && a.session === b.session && a.token === b.token);
}
