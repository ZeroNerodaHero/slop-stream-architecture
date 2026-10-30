/**
 * The text chat next to a stream, and in a server's channels. One websocket at
 * /chat/<name> for a stream, or /chat/<server>/* for a whole server: every channel's
 * lines on the one socket, each tagged with its channel, so the room page switches
 * channels on screen (`showChannel`) and opens nothing. The lines of the channels not
 * on screen wait on a shelf; the api's last lines of every channel seed it
 * (`seedChannels`), and the socket is told the newest id it has per channel (`since`)
 * so nothing falls between the two. See docs/chat.md and docs/groups.md.
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
  /** The first picture on the line. Null, or absent on an older chat, when there is none. `images` is the whole set. */
  image?: string | null;
  /** Every picture on the line, the ids from `POST /api/chat-images`. Empty when there are none. */
  images: string[];
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
/** The channel of `/chat/<server>/<channel>` that is every channel: the server socket's. Matches `EVERY_CHANNEL` in chat.rs. */
const EVERY_CHANNEL = '*';
const NICK_RE = /^[a-zA-Z0-9_-]{1,24}$/;

/** Your name without an account. Remembered across pages and visits (localstorage). */
// read at init, not on first mount: the events socket says hello as this name from main.tsx,
// before any component has mounted (docs/status.md)
export const nickAtom = atomWithStorage<string>('nick', '', undefined, { getOnInit: true });
export const chatPhaseAtom = atom<ChatPhase>('off');
export const chatLinesAtom = atom<ChatLine[]>([]);
export const chatCountAtom = atom(0);
export const chatDraftAtom = atom('');
/** Pictures waiting to go with the next line, the ids `POST /api/chat-images` returned. Ten at most, the chat's cap. */
export const MAX_CHAT_IMAGES = 10;
export const chatImagesAtom = atom<string[]>([]);
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
  const picture = get(chatImagesAtom).length > 0;
  return get(chatPhaseAtom) === 'open' && length <= MAX_CHAT_CHARS && (length > 0 || picture);
});

interface Session {
  /** The room on the wire: a stream's name, or `<server>/*` for a server. */
  name: string;
  /** The server, when this socket is every channel of one. */
  server: string | null;
  owner: Owner | null;
  ws: WebSocket | null;
  timer: ReturnType<typeof setTimeout> | null;
}

let session: Session | null = null;
let notice: ReturnType<typeof setTimeout> | null = null;

/**
 * A server's channels, apart from the one on screen: each one's live tail (KEEP_LINES at most)
 * and how many sockets are in it. The one on screen lives in the atoms like a stream's room,
 * and goes back on the shelf when another is shown. Kept by server, not by socket: the api's
 * lines may land before the socket opens, and stay through a reconnect.
 */
interface Shelf {
  server: string;
  tails: Map<string, ChatLine[]>;
  counts: Map<string, number>;
}

let shelf: Shelf | null = null;
/** The channel on screen, for a server session. '' until `showChannel`. */
let channel = '';

/** The channel the server session shows. '' for a stream's room. */
export const chatChannelAtom = atom('');

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

/** Another picture on the next line, ignored past the cap or when it is already there. */
export function addChatImage(id: string) {
  const now = store.get(chatImagesAtom);
  if (!id || now.includes(id) || now.length >= MAX_CHAT_IMAGES) return;
  store.set(chatImagesAtom, [...now, id]);
}

export function removeChatImage(id: string) {
  store.set(chatImagesAtom, store.get(chatImagesAtom).filter((have) => have !== id));
}

/**
 * Join a room. With `owner` (the streamer's own grant) the server marks our lines.
 * Calling it again for the same room with a different owner reconnects.
 */
export function openChat(name: string, owner: Owner | null = null) {
  if (session && session.name === name && sameOwner(session.owner, owner) && session.ws) return;
  closeChat(false);
  session = { name, server: null, owner, ws: null, timer: null };
  connect();
}

/**
 * Join a server: every channel of it on one socket (docs/groups.md), with `show` the channel
 * on screen to begin with. Calling it again for the same server only changes that; another
 * server starts over, shelf and all. Later changes of channel are `showChannel`'s.
 */
export function openServerChat(server: string, show: string) {
  if (session?.server === server && session.ws) {
    showChannel(show);
    return;
  }
  if (session?.server !== server) {
    closeChat(true);
    takeShelf(server);
  } else closeChat(false);
  session = { name: `${server}/${EVERY_CHANNEL}`, server, owner: null, ws: null, timer: null };
  showChannel(show);
  connect();
}

/** The shelf for this server, kept when it already is the one. */
function takeShelf(server: string): Shelf {
  if (shelf?.server !== server) {
    shelf = { server, tails: new Map(), counts: new Map() };
    channel = '';
    store.set(chatChannelAtom, '');
  }
  return shelf;
}

/**
 * The channel on screen, for a server session: the one shown goes back on the shelf as its
 * live tail, and the next one's comes off it. Nothing is asked of anyone: the lines were
 * loaded with the room, and the socket has kept every channel current since.
 */
export function showChannel(next: string) {
  const current = shelf;
  if (!current || next === channel) return;
  if (channel) {
    current.tails.set(channel, pinned && savedTail ? savedTail : store.get(chatLinesAtom));
  }
  channel = next;
  store.set(chatChannelAtom, next);
  resetHistory();
  scrollPlan = 'bottom';
  store.set(chatLinesAtom, current.tails.get(next) ?? []);
  store.set(chatCountAtom, current.counts.get(next) ?? 0);
}

/**
 * The api's last lines of every channel (`GET /api/groups/:group/messages`), onto the shelf,
 * and onto the screen for the channel shown. Merged by id with what the socket has brought
 * already, so whichever landed first, nothing is lost or drawn twice; then the socket is told
 * the newest id of each, and sends what came after.
 */
export function seedChannels(server: string, lines: Record<string, ChatLine[]>) {
  const current = takeShelf(server);
  for (const [name, raw] of Object.entries(lines)) {
    const fresh = Array.isArray(raw) ? raw.map(fromWire) : [];
    if (session?.server === server && name === channel) {
      if (pinned && savedTail) savedTail = mergeLines(savedTail, fresh);
      else {
        if (following) scrollPlan = 'bottom';
        store.set(chatLinesAtom, mergeLines(store.get(chatLinesAtom), fresh));
      }
    } else current.tails.set(name, mergeLines(current.tails.get(name) ?? [], fresh));
  }
  sendSince();
}

/** A channel added to the server since the socket opened (the events socket said so): follow it too. */
export function followChannel(name: string) {
  if (!session?.server || !session.ws || session.ws.readyState !== WebSocket.OPEN) return;
  const join = { type: 'join', channel: name };
  record(`/chat/${session.name}`, 'out', join);
  session.ws.send(JSON.stringify(join));
}

/** A channel deleted from the server: its lines go with it. */
export function dropChannel(name: string) {
  shelf?.tails.delete(name);
  shelf?.counts.delete(name);
}

/**
 * My picture changed: every line of mine already on screen wears the new one, on the tail, the
 * shelf and a search. The server gives a line its speaker's picture as it is now (chat.rs
 * `with_faces`), so anything loaded from here on is right on its own; this is the tab that
 * was open. A line is mine when it is `name`'s as a login or as the room's streamer: a nick's
 * line is nobody's picture, so it is left alone.
 */
export function refaceLines(name: string, avatar: number | null) {
  const wear = (lines: ChatLine[]) => lines.map((line) => (line.from === name && (line.verified || line.streamer) ? { ...line, avatar } : line));
  store.set(chatLinesAtom, wear(store.get(chatLinesAtom)));
  const results = store.get(chatResultsAtom);
  if (results) store.set(chatResultsAtom, wear(results));
  if (savedTail) savedTail = wear(savedTail);
  if (shelf) for (const [key, tail] of shelf.tails) shelf.tails.set(key, wear(tail));
}

/** The name changed (nick edited, logged in or out), or its groups did: say hello again as the new one. */
export function reconnectChat() {
  if (!session) return;
  const { name, server, owner } = session;
  closeChat(false);
  session = { name, server, owner, ws: null, timer: null };
  connect();
}

export function closeChat(reset = true) {
  if (!session) return;
  if (session.timer) clearTimeout(session.timer);
  if (session.ws) {
    session.ws.onclose = null;
    session.ws.close();
  }
  const wasServer = session.server !== null;
  session = null;
  inFlight.length = 0;
  resetHistory();
  if (reset) {
    store.set(chatLinesAtom, []);
    store.set(chatCountAtom, 0);
    store.set(chatAsStreamerAtom, false);
    store.set(chatDraftAtom, '');
    store.set(chatImagesAtom, []);
    store.set(chatNoticeAtom, '');
    if (wasServer) {
      shelf = null;
      channel = '';
      store.set(chatChannelAtom, '');
    }
  }
  store.set(chatPhaseAtom, 'off');
}

export function sendChat() {
  const text = store.get(chatDraftAtom).trim();
  const images = store.get(chatImagesAtom);
  if (!session?.ws || session.ws.readyState !== WebSocket.OPEN || (!text && images.length === 0)) return;
  if (chars(text) > MAX_CHAT_CHARS) {
    showNotice('too long');
    return;
  }
  if (session.server && !channel) return;
  // `image` is the first, so a chat that only knows one picture still keeps that one
  const say: Record<string, unknown> = images.length ? { type: 'say', text, image: images[0], images } : { type: 'say', text };
  // a server socket is every channel: the line says which
  if (session.server) say.channel = channel;
  record(`/chat/${session.name}`, 'out', say);
  session.ws.send(JSON.stringify(say));
  inFlight.push({ text, images });
  store.set(chatDraftAtom, '');
  store.set(chatImagesAtom, []);
}

/**
 * Lines sent and not seen back from the room yet, oldest first. The server handles a socket's
 * frames in order, so a drop (`slow down`, chat busy or down) is of the oldest, and goes back
 * into the box; a line that comes back through the room is off the list.
 */
const inFlight: { text: string; images: string[] }[] = [];

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
    // a server socket sends no history: it is told what this page has, and sends what came after
    if (current.server) sendSince();
  };
  ws.onmessage = (e) => {
    let msg: { type?: string; messages?: ChatLine[]; count?: number; error?: string; channel?: string } & Partial<ChatLine>;
    try {
      msg = JSON.parse(String(e.data));
    } catch {
      return;
    }
    record(`/chat/${current.name}`, 'in', msg);
    const tagged = current.server && typeof msg.channel === 'string' ? msg.channel : null;
    if (msg.type === 'history' && msg.messages) {
      resetHistory();
      scrollPlan = 'bottom';
      store.set(chatLinesAtom, msg.messages.slice(-KEEP_LINES).map(fromWire));
    }
    else if (msg.type === 'message' && msg.id) {
      const sent = inFlight.findIndex((p) => p.text === (msg.text ?? '') && samePictures(p.images, picturesOf(msg)));
      if (sent >= 0) inFlight.splice(sent, 1);
      const line = fromWire(msg as ChatLine);
      // another channel's line waits on the shelf; the one on screen's goes up like a stream's
      if (tagged !== null && tagged !== channel) shelfAppend(tagged, line);
      else appendLine(line);
    } else if (msg.type === 'count' && typeof msg.count === 'number') {
      if (tagged !== null) {
        shelf?.counts.set(tagged, msg.count);
        if (tagged === channel) store.set(chatCountAtom, msg.count);
      } else store.set(chatCountAtom, msg.count);
    } else if (msg.type === 'error' && msg.error) {
      // a bad nick, or a channel that is not there: back out, and do not reconnect.
      // a channel that is not there is not a dead login.
      const refused = /nick|account/.test(msg.error);
      const gone = /no such channel|not a server|that name is reserved|bad name/.test(msg.error);
      showNotice(msg.error, refused || gone ? 8000 : 3000);
      // the oldest line out was not taken: back into the box, unless something new is being typed
      if (/slow down|chat is (busy|down)/.test(msg.error)) {
        const lost = inFlight.shift();
        if (lost?.text && !store.get(chatDraftAtom)) store.set(chatDraftAtom, lost.text);
        if (lost && lost.images.length > 0 && store.get(chatImagesAtom).length === 0) store.set(chatImagesAtom, lost.images);
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

/** A line from a chat server older than the badges has no `groups`, one older than the faces no `avatar`, one older than several pictures no `images`: a line with none of each. */
function fromWire(line: ChatLine): ChatLine {
  const images = picturesOf(line);
  return {
    ...line,
    groups: Array.isArray(line.groups) ? line.groups : [],
    avatar: typeof line.avatar === 'number' ? line.avatar : null,
    image: images[0] ?? null,
    images,
  };
}

/** The pictures a line carries. `images` when the chat sent the set, otherwise the one `image`. */
function picturesOf(line: { image?: string | null; images?: unknown }): string[] {
  if (Array.isArray(line.images)) {
    const ids = line.images.filter((id): id is string => typeof id === 'string' && id.length > 0);
    if (ids.length > 0) return ids;
  }
  return typeof line.image === 'string' && line.image ? [line.image] : [];
}

/**
 * The line that came back is the one we sent. A chat that only keeps one picture echoes
 * that first id and nothing else: still this send, the rest did not travel.
 */
function samePictures(sent: string[], back: string[]): boolean {
  if (sent.length === back.length) return sent.every((id, i) => id === back[i]);
  return sent.length > 1 && back.length === 1 && back[0] === sent[0];
}

/** "1729000000000-3" -> [1729000000000, 3]: a redis stream id, ordered the way redis orders them. */
function idParts(id: string): [number, number] {
  const [ms, seq] = id.split('-');
  return [Number(ms) || 0, Number(seq) || 0];
}

function compareIds(a: string, b: string): number {
  const [ams, aseq] = idParts(a);
  const [bms, bseq] = idParts(b);
  return ams === bms ? aseq - bseq : ams - bms;
}

/** Two sets of a channel's lines as one: by id, in id order, the newest KEEP_LINES. */
function mergeLines(have: ChatLine[], more: ChatLine[]): ChatLine[] {
  if (more.length === 0) return have;
  const byId = new Map<string, ChatLine>();
  for (const line of have) byId.set(line.id, line);
  for (const line of more) byId.set(line.id, line);
  const all = [...byId.values()].sort((a, b) => compareIds(a.id, b.id));
  return all.length > KEEP_LINES ? all.slice(all.length - KEEP_LINES) : all;
}

/** A line of a channel not on screen: onto its tail on the shelf, capped like the live tail. */
function shelfAppend(name: string, line: ChatLine) {
  if (!shelf) return;
  const tail = shelf.tails.get(name) ?? [];
  if (tail.length && tail[tail.length - 1]?.id === line.id) return;
  const next = tail.length >= KEEP_LINES ? tail.slice(tail.length - KEEP_LINES + 1) : tail.slice();
  next.push(line);
  shelf.tails.set(name, next);
}

/** The newest line this page holds of each channel: the one on screen's live tail, and every tail on the shelf. */
function sinceIds(): Record<string, string> {
  const since: Record<string, string> = {};
  if (!shelf) return since;
  for (const [name, tail] of shelf.tails) {
    const last = tail[tail.length - 1];
    if (last && name !== channel) since[name] = last.id;
  }
  if (channel) {
    const tail = pinned && savedTail ? savedTail : store.get(chatLinesAtom);
    const last = tail[tail.length - 1];
    if (last) since[channel] = last.id;
  }
  return since;
}

/** Tell the server socket what this page has, so it sends what came after. Nothing to say, nothing sent. */
function sendSince() {
  if (!session?.server || !session.ws || session.ws.readyState !== WebSocket.OPEN) return;
  const since = sinceIds();
  if (Object.keys(since).length === 0) return;
  const frame = { type: 'since', since };
  record(`/chat/${session.name}`, 'out', frame);
  session.ws.send(JSON.stringify(frame));
}

/** The room the history routes read: a stream's name, or `server/<channel on screen>`. Null with no channel yet. */
function httpRoom(): string | null {
  if (!session) return null;
  if (!session.server) return session.name;
  return channel ? `${session.server}/${channel}` : null;
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
  const name = httpRoom();
  const oldest = store.get(chatLinesAtom)[0];
  if (!name || !oldest || olderBusy || noMoreOlder || olderPaused) return;
  olderBusy = true;
  try {
    const lines = await chatGet(`/chat/${chatPath(name)}/before?id=${encodeURIComponent(oldest.id)}`);
    if (httpRoom() !== name) return;
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
  const name = httpRoom();
  const q = raw.trim();
  if (!name || !q) return;
  try {
    const lines = await chatGet(`/chat/${chatPath(name)}/search?q=${encodeURIComponent(q)}`);
    if (httpRoom() !== name) return;
    store.set(chatResultsAtom, lines);
    store.set(chatResultsForAtom, q);
  } catch (err) {
    store.set(chatResultsAtom, null);
    showNotice(err instanceof Error ? err.message : 'search failed');
  }
}

/** One account's lines in this room, newest first. A nick with no account is not one. */
export async function showSpeaker(speaker: string) {
  const name = httpRoom();
  if (!name) return;
  try {
    const lines = await chatGet(`/chat/${chatPath(name)}/by/${encodeURIComponent(speaker)}`);
    if (httpRoom() !== name) return;
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
  const name = httpRoom();
  if (!name) return;
  if (store.get(chatLinesAtom).some((l) => l.id === id)) {
    scrollPlan = { id };
    store.set(chatScrollAtom, store.get(chatScrollAtom) + 1);
    return;
  }
  try {
    const lines = await chatGet(`/chat/${chatPath(name)}/around/${encodeURIComponent(id)}`);
    if (httpRoom() !== name) return;
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
