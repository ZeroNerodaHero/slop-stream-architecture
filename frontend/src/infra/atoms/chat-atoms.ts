/**
 * The text chat next to a stream, and in a server's channels. A room is one websocket: at
 * /chat/<name> for a stream, or /chat/<server>/* for a whole server, every channel's lines on
 * the one socket, each tagged with its channel, so the room page switches channels on screen
 * (`showChannel`) and opens nothing. The lines of the channels not on screen wait on a shelf;
 * the api's last lines of every channel seed it (`seedChannels`), and the socket is told the
 * newest id it has per channel (`since`) so nothing falls between the two. See docs/chat.md,
 * docs/groups.md and docs/chat-audit.md.
 *
 * Every room is a `ChatRoom` of its own, kept by its key (`chatRoomFor`): a stream's name, or
 * `<server>/*`. Its lines, its draft, its socket, its shelf and its scroll are its own, so two
 * panels on two rooms at once (the corner player's stream over a group's channel, your own
 * stream's chat in the player while you watch someone else) each show their own lines and send
 * to their own room. Panels join and leave a room (`join` hands back the leave); the room
 * closes `LEAVE_MS` after its last panel went, and two panels on one room share it: one socket,
 * one list of lines, no line twice.
 */

import { atom, type Atom, type PrimitiveAtom } from 'jotai';
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
  /** the speaker's account has an outside login linked (the verified mark, `OAuthMark`), as the row is now. only a `verified` or `streamer` line can have it; absent on an older chat */
  oauth_verified?: boolean;
  at: number;
  /** The first picture on the line. Null, or absent on an older chat, when there is none. `images` is the whole set. */
  image?: string | null;
  /** Every picture on the line, the ids from `POST /api/chat-images`. Empty when there are none. */
  images: string[];
  /** On a search hit of a server alone: the channel the line is in, since a server's search spans every channel the viewer sees (`search`). */
  channel?: string;
}

/** The automatic group a socket that says `bot: true` wears. The hide switch keys on it. */
export const BOT_GROUP = 'bot';

export function isBotLine(line: ChatLine): boolean {
  return line.groups.some((g) => g.name === BOT_GROUP);
}

export type ChatPhase = 'off' | 'connecting' | 'open' | 'closed';

export const MAX_CHAT_CHARS = 500;
/** Pictures waiting to go with the next line, the ids `POST /api/chat-images` returned. Ten at most, the chat's cap. */
export const MAX_CHAT_IMAGES = 10;
const KEEP_LINES = 500;
const RECONNECT_MS = 3000;
/** One page of older lines. A short page is the end. Matches `PAGE` in history.rs. */
const OLDER_PAGE = 50;
/** Loaded lines kept while the reader has scrolled up. The live tail, stuck to the bottom, stays at KEEP_LINES. */
const MAX_LOADED = 2000;
/**
 * How long a room stays open after its last panel went. Long enough for the next panel to
 * arrive when it is a commit or two behind the one that took the last away (leaving the go
 * live page turns the corner player on from an effect's cleanup, so its chat mounts a render
 * later; the chat moving with the player into a window of its own is one panel unmounting and
 * another mounting), short enough that nobody is in a room they have left.
 */
const LEAVE_MS = 100;

/** A stream is one segment. A server channel is two (`vip/general`): encode each, keep the slash. */
function chatPath(room: string): string {
  return room
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
}
/** The channel of `/chat/<server>/<channel>` that is every channel: the server socket's. Matches `EVERY_CHANNEL` in chat.rs. */
const EVERY_CHANNEL = '*';
const NICK_RE = /^[a-zA-Z0-9_-]{1,24}$/;

/** Your name without an account. Remembered across pages and visits (localstorage). */
// read at init, not on first mount: the events socket says hello as this name from main.tsx,
// before any component has mounted (docs/status.md)
export const nickAtom = atomWithStorage<string>('nick', '', undefined, {
  getOnInit: true
});
export const nickIsValidAtom = atom((get) => NICK_RE.test(get(nickAtom).trim()));
/** The name this browser talks as: the login, else the nick. */
export const chatSpeakerAtom = atom((get) => get(meAtom) || get(nickAtom).trim());
/**
 * The channel the group room page has on screen ('' for none): the notifications read it, so a
 * line said there is not news. Written by the server room whose channel is on screen, and
 * cleared when that room closes; a stream's room never touches it.
 */
export const chatChannelAtom = atom('');

/**
 * The chat's two token buckets (chat.rs `ANON_TIER`, `LOGIN_TIER`): `burst` lines at once,
 * refilling at `burst` per `window` ms, one token every `window / burst`. The page keeps the same
 * bucket per room, so a line over the rate is refused here, at once, with how long until the
 * next may go, and nothing is sent. The chat has the bucket itself, one per speaker per room and
 * shared by every socket of theirs, and the last word: its `slow down` carries the same wait,
 * and the page's bucket is set to agree (another tab spent the tokens, or this page was reloaded).
 */
export interface ChatTier {
  burst: number;
  window: number;
  /** The rule in words, for the send button's title while it counts down. */
  words: string;
}
const TIERS: { anon: ChatTier; login: ChatTier } = {
  anon: {
    burst: 2,
    window: 60_000,
    words: '2 lines a minute without an account'
  },
  login: { burst: 3, window: 10_000, words: '3 lines in 10 seconds' }
};

/** The chat's short words for a refusal, as the notice reads them. Anything else is said as it came. */
const NOTICE_WORDS: Record<string, string> = {
  cooldown: 'your role has a cooldown between lines',
  'channel cooldown': 'this channel has a cooldown between lines',
  'timed out': 'you are timed out here'
};

type ScrollPlan = 'bottom' | 'keep' | { id: string } | null;

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

/** Every room this page has: open, or on its way out (`LEAVE_MS`), or seeded by the api before its panel came. By key. */
const rooms = new Map<string, ChatRoom>();
/** The key of the server room whose channel the room page has on screen: the one `chatChannelAtom` and `searchRoom` speak of. */
let shownServer: string | null = null;

/** The key a room is kept under: a stream's name, or `<server>/*`. */
export function chatRoomKey(name: string, server: boolean): string {
  return server ? `${name}/${EVERY_CHANNEL}` : name;
}

/** The room, made when this page has none yet. `server`: `name` is a server, and the room is every channel of it. */
export function chatRoomFor(name: string, server = false): ChatRoom {
  const key = chatRoomKey(name, server);
  let room = rooms.get(key);
  if (!room) {
    room = new ChatRoom(key, server ? name : null);
    rooms.set(key, room);
  }
  return room;
}

/**
 * One room: its atoms for what renders, its socket, and the actions on it. A stream's room, or
 * a server's (every channel on one socket, the one on screen in the atoms and the rest on the
 * shelf). Panels `join` it and call what that hands back when they go.
 */
export class ChatRoom {
  /** The key it is kept under, and the room on the wire: a stream's name, or `<server>/*`. */
  readonly key: string;
  /** The server, when this is every channel of one. */
  readonly server: string | null;

  readonly phaseAtom: PrimitiveAtom<ChatPhase> = atom<ChatPhase>('off');
  readonly linesAtom: PrimitiveAtom<ChatLine[]> = atom<ChatLine[]>([]);
  /**
   * The room's past has landed: a stream's with the socket's `history` frame, a server's with the
   * api's last lines (`seedChannels`, had it any or not). Until then an empty tail is not "nothing
   * yet", and the panel stands grey lines in its place.
   */
  readonly loadedAtom: PrimitiveAtom<boolean> = atom(false);
  readonly countAtom: PrimitiveAtom<number> = atom(0);
  readonly draftAtom: PrimitiveAtom<string> = atom('');
  readonly imagesAtom: PrimitiveAtom<string[]> = atom<string[]>([]);
  readonly noticeAtom: PrimitiveAtom<string> = atom('');
  /** True while this socket speaks as the streamer. */
  readonly asStreamerAtom: PrimitiveAtom<boolean> = atom(false);
  /** When the next line may go, unix ms, set by a refused send; 0 when none was refused or the wait is over. The send button counts it down. */
  readonly waitAtom: PrimitiveAtom<number> = atom(0);
  /** Bumped by every refused send, so the countdown on the button shakes again. */
  readonly shakeAtom: PrimitiveAtom<number> = atom(0);
  /** Search hits, or one account's lines, newest first; the panel shows them where its lines are. Null when the pane is closed. */
  readonly resultsAtom: PrimitiveAtom<ChatLine[] | null> = atom<ChatLine[] | null>(null);
  /** The query, or the account name, that `resultsAtom` is for. */
  readonly resultsForAtom: PrimitiveAtom<string> = atom('');
  /** The panel is showing a window around an old line, not the live tail. */
  readonly pinnedAtom: PrimitiveAtom<boolean> = atom(false);
  /** Lines that arrived in the live tail while the panel was pinned to an old one. */
  readonly behindAtom: PrimitiveAtom<number> = atom(0);
  /** Bumped when the panel should scroll and the lines themselves did not change. */
  readonly scrollAtom: PrimitiveAtom<number> = atom(0);
  /**
   * A second panel is drawing this room: the player's own window, over a page whose own chat is
   * that same room (ChatPanel `guest`). Still one room and one socket: the page's panel draws
   * nothing while this is on, so one list is on screen.
   */
  readonly guestAtom: PrimitiveAtom<boolean> = atom(false);
  /** The channel on screen, for a server room. '' for a stream's. */
  readonly channelAtom: PrimitiveAtom<string> = atom('');

  /** The lines on screen: every line, or without the bots' while `hideBotsAtom` is on. */
  readonly visibleLinesAtom: Atom<ChatLine[]>;
  /** How many lines the switch is holding back right now. 0 while it is off. */
  readonly hiddenBotLinesAtom: Atom<number>;
  /** The tier of this room's lines: a login's or the streamer's, else a nick's. */
  readonly tierAtom: Atom<ChatTier>;
  readonly canSendAtom: Atom<boolean>;

  /** The panels in the room, each with the owner it came with: the streamer's own grant, or null. */
  private joins = new Map<symbol, Owner | null>();
  /** The grant the socket said hello with. The last panel's that brought one: the streamer speaks as the streamer in every panel of their room. */
  private owner: Owner | null = null;
  /** The login the socket said hello as; `null` for a nick, or the streamer's grant alone. */
  private me: string | null = null;
  private ws: WebSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private leaving: ReturnType<typeof setTimeout> | null = null;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  /** The page's copy of the chat's bucket for this speaker in this room: the tokens in it as of `at` (unix ms). A network reconnect keeps it, as the chat does; a new hello (another name, another grant) is a full one. */
  private bucket: { tokens: number; at: number };
  /**
   * Lines sent and not seen back from the room yet, oldest first. The server handles a socket's
   * frames in order, so a drop (`slow down`, chat busy or down) is of the oldest, and goes back
   * into the box; a line that comes back through the room is off the list.
   */
  private inFlight: { text: string; images: string[] }[] = [];

  // the scroll and the history window
  private scrollPlan: ScrollPlan = null;
  private following = true;
  private olderBusy = false;
  private noMoreOlder = false;
  private olderPaused = false;
  private pinned = false;
  private savedTail: ChatLine[] | null = null;
  private behind = 0;

  /** A server's channels apart from the one on screen: each one's live tail (KEEP_LINES at most) and how many sockets are in it. */
  private tails = new Map<string, ChatLine[]>();
  private counts = new Map<string, number>();
  /** The channel on screen, for a server room. '' until `showChannel`. */
  private channel = '';

  constructor(key: string, server: string | null) {
    this.key = key;
    this.server = server;
    this.bucket = { tokens: TIERS.anon.burst, at: Date.now() };
    const lines = this.linesAtom;
    const asStreamer = this.asStreamerAtom;
    this.visibleLinesAtom = atom((get) => {
      const all = get(lines);
      return get(hideBotsAtom) ? all.filter((line) => !isBotLine(line)) : all;
    });
    this.hiddenBotLinesAtom = atom((get) => (get(hideBotsAtom) ? get(lines).filter(isBotLine).length : 0));
    this.tierAtom = atom((get) => (get(meAtom) || get(asStreamer) ? TIERS.login : TIERS.anon));
    const draft = this.draftAtom;
    const images = this.imagesAtom;
    const phase = this.phaseAtom;
    this.canSendAtom = atom((get) => {
      const length = chars(get(draft).trim());
      const picture = get(images).length > 0;
      return get(phase) === 'open' && length <= MAX_CHAT_CHARS && (length > 0 || picture);
    });
  }

  // ---- panels in and out --------------------------------------------------------------------

  /**
   * A panel is in the room: the socket opens, or is kept, or says hello again when this panel's
   * grant or the login changed what it should say. Hands back the leave. Joined again within
   * `LEAVE_MS` of the last panel going, the room stays open: nothing reconnects.
   */
  join(owner: Owner | null = null): () => void {
    const token = Symbol(this.key);
    this.joins.set(token, owner);
    // put back when a close went through between this panel's render and its effect: one room per key
    if (!rooms.has(this.key)) rooms.set(this.key, this);
    if (this.leaving) clearTimeout(this.leaving);
    this.leaving = null;
    this.open();
    return () => this.leave(token);
  }

  /** The panel with `token` is gone. The room closes `LEAVE_MS` from now unless another panel takes it first; the grant it brought goes with it. */
  private leave(token: symbol) {
    if (!this.joins.delete(token)) return;
    if (this.joins.size > 0) {
      // the streamer's panel went and a watcher's is left: that one speaks as itself from here
      if (!sameOwner(this.owner, this.wantedOwner())) this.open();
      return;
    }
    if (this.leaving) return;
    this.leaving = setTimeout(() => {
      this.leaving = null;
      if (this.joins.size === 0) this.close();
    }, LEAVE_MS);
  }

  /** The grant the room should say hello with: the newest panel's that brought one. */
  private wantedOwner(): Owner | null {
    let owner: Owner | null = null;
    for (const o of this.joins.values()) if (o) owner = o;
    return owner;
  }

  /** The socket as the panels want it: kept when it already is, else said hello to again (the lines stay). The nick box's join, too. */
  open() {
    const owner = this.wantedOwner();
    const me = store.get(meAtom) ?? null;
    if (this.ws && sameOwner(this.owner, owner) && this.me === me) return;
    const fresh = !sameOwner(this.owner, owner) || this.me !== me;
    this.owner = owner;
    this.hangUp();
    if (fresh) this.bucket = { tokens: this.tier().burst, at: Date.now() };
    this.connect();
  }

  /** The name changed (nick edited, logged in or out), or its groups did: say hello again as the new one. Nothing for a room no panel is in. */
  reconnect() {
    if (this.joins.size === 0) return;
    this.hangUp();
    this.bucket = { tokens: this.tier().burst, at: Date.now() };
    this.connect();
  }

  /** A guest panel came up, or went (ChatPanel `guest`): the panel that holds the room stands aside for as long. */
  setGuest(on: boolean) {
    store.set(this.guestAtom, on);
  }

  /** The socket down, the lines kept: a hello again is on its way, or the room was refused. */
  private hangUp() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
    }
    this.ws = null;
    this.inFlight.length = 0;
    this.resetHistory();
    // the hits were this room's as this speaker
    this.clearResults();
    store.set(this.phaseAtom, 'off');
  }

  /** The last panel is gone: the socket, the lines, the draft and the shelf with it, and the room off the page's list. */
  private close() {
    this.hangUp();
    store.set(this.linesAtom, []);
    store.set(this.loadedAtom, false);
    store.set(this.countAtom, 0);
    store.set(this.asStreamerAtom, false);
    store.set(this.draftAtom, '');
    store.set(this.imagesAtom, []);
    store.set(this.noticeAtom, '');
    store.set(this.waitAtom, 0);
    store.set(this.guestAtom, false);
    this.owner = null;
    this.me = null;
    this.tails = new Map();
    this.counts = new Map();
    this.channel = '';
    store.set(this.channelAtom, '');
    if (shownServer === this.key) {
      shownServer = null;
      store.set(chatChannelAtom, '');
    }
    if (rooms.get(this.key) === this) rooms.delete(this.key);
  }

  // ---- the box ----------------------------------------------------------------------------------

  setDraft(raw: string) {
    // a little slack so the counter can go red. cut between scalars, never through a surrogate pair
    store.set(this.draftAtom, [...raw].slice(0, MAX_CHAT_CHARS + 50).join(''));
  }

  /** Another picture on the next line, ignored past the cap or when it is already there. */
  addImage(id: string) {
    const now = store.get(this.imagesAtom);
    if (!id || now.includes(id) || now.length >= MAX_CHAT_IMAGES) return;
    store.set(this.imagesAtom, [...now, id]);
  }

  removeImage(id: string) {
    store.set(
      this.imagesAtom,
      store.get(this.imagesAtom).filter((have) => have !== id)
    );
  }

  showNotice(text: string, ms = 3000) {
    store.set(this.noticeAtom, text);
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => store.set(this.noticeAtom, ''), ms);
  }

  send() {
    const ws = this.ws;
    const text = store.get(this.draftAtom).trim();
    const images = store.get(this.imagesAtom);
    if (!ws || ws.readyState !== WebSocket.OPEN || (!text && images.length === 0)) return;
    if (chars(text) > MAX_CHAT_CHARS) {
      this.showNotice('too long');
      return;
    }
    if (this.server && !this.channel) return;
    // a wait the chat set (a cooldown, a timeout) still running: the line stays in the box and the button shakes
    const held = store.get(this.waitAtom) - Date.now();
    if (held > 0) {
      this.refuse(held);
      return;
    }
    // the bucket, before anything goes out: over the rate, the line stays in the box and the button says how long
    const wait = this.takeToken();
    if (wait > 0) {
      this.refuse(wait);
      return;
    }
    // `image` is the first, so a chat that only knows one picture still keeps that one
    const say: Record<string, unknown> = images.length ? { type: 'say', text, image: images[0], images } : { type: 'say', text };
    // a server socket is every channel: the line says which
    if (this.server) say.channel = this.channel;
    record(`/chat/${this.key}`, 'out', say);
    ws.send(JSON.stringify(say));
    this.inFlight.push({ text, images });
    store.set(this.draftAtom, '');
    store.set(this.imagesAtom, []);
    // your own line goes out: the view goes to the newest line, out of a jump too, and again when the line comes back
    this.toLatest();
  }

  /** The tier a socket's lines are on: the streamer's grant or a login is the login's, a nick the other. */
  private tier(): ChatTier {
    return this.owner || store.get(meAtom) ? TIERS.login : TIERS.anon;
  }

  /** A token out of the page's bucket, or how long (ms) until there is one. */
  private takeToken(): number {
    const { burst, window } = this.tier();
    const now = Date.now();
    const b = this.bucket;
    b.tokens = Math.min(burst, b.tokens + ((now - b.at) * burst) / window);
    b.at = now;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return 0;
    }
    return Math.ceil(((1 - b.tokens) * window) / burst);
  }

  /** A refused send: the button counts `wait` ms down, and shakes. */
  private refuse(wait: number) {
    store.set(this.waitAtom, Date.now() + wait);
    store.set(this.shakeAtom, store.get(this.shakeAtom) + 1);
  }

  // ---- the socket -------------------------------------------------------------------------------

  private connect() {
    const nick = store.get(nickAtom).trim();
    const me = store.get(meAtom) ?? null;
    const owner = this.owner;
    if (!owner && !me && !isValidNick(nick)) {
      // no nick yet: wait for one, the panel's join (or the profile tab's save) opens it
      store.set(this.phaseAtom, 'off');
      return;
    }

    store.set(this.phaseAtom, 'connecting');
    const ws = new WebSocket(relayUrl(`/chat/${chatPath(this.key)}`));
    this.ws = ws;
    this.me = me;
    const source = `/chat/${this.key}`;

    ws.onopen = () => {
      // a login needs no nick: the cookie went with the handshake and the server names us
      const hello = owner ? { type: 'hello', nick, session: owner.session, token: owner.token } : me ? { type: 'hello' } : { type: 'hello', nick };
      record(source, 'out', hello); // the token is taken out before it is kept
      ws.send(JSON.stringify(hello));
      store.set(this.phaseAtom, 'open');
      store.set(this.asStreamerAtom, owner !== null || me === this.key);
      // a server socket sends no history: it is told what this page has, and sends what came after
      if (this.server) this.sendSince();
    };
    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      let msg: {
        type?: string;
        messages?: ChatLine[];
        count?: number;
        error?: string;
        wait?: number;
        channel?: string;
      } & Partial<ChatLine>;
      try {
        msg = JSON.parse(String(e.data));
      } catch {
        return;
      }
      record(source, 'in', msg);
      const tagged = this.server && typeof msg.channel === 'string' ? msg.channel : null;
      if (msg.type === 'history' && msg.messages) {
        this.resetHistory();
        this.scrollPlan = 'bottom';
        store.set(this.linesAtom, msg.messages.slice(-KEEP_LINES).map(fromWire));
        store.set(this.loadedAtom, true);
      } else if (msg.type === 'message' && msg.id) {
        const sent = this.inFlight.findIndex((p) => p.text === (msg.text ?? '') && samePictures(p.images, picturesOf(msg)));
        if (sent >= 0) this.inFlight.splice(sent, 1);
        const line = fromWire(msg as ChatLine);
        // another channel's line waits on the shelf; the one on screen's goes up like a stream's
        if (tagged !== null && tagged !== this.channel) this.shelfAppend(tagged, line);
        else {
          this.appendLine(line);
          // one of ours back: it lands at the bottom, where the send put the view. someone else's leaves a reader where they are
          if (sent >= 0) this.toLatest();
        }
      } else if (msg.type === 'count' && typeof msg.count === 'number') {
        if (tagged !== null) {
          this.counts.set(tagged, msg.count);
          if (tagged === this.channel) store.set(this.countAtom, msg.count);
        } else store.set(this.countAtom, msg.count);
      } else if (msg.type === 'error' && msg.error) {
        this.onError(msg.error, msg.wait, me);
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      store.set(this.phaseAtom, 'closed');
      this.ws = null;
      this.timer = setTimeout(() => {
        this.timer = null;
        if (this.joins.size > 0) this.connect();
      }, RECONNECT_MS);
    };
  }

  private onError(error: string, wait: number | undefined, me: string | null) {
    // a bad nick, or a channel that is not there: back out, and do not reconnect.
    // a channel that is not there is not a dead login.
    const refused = /nick|account/.test(error);
    const gone = /no such channel|not a server|that name is reserved|bad name/.test(error);
    this.showNotice(NOTICE_WORDS[error] ?? error, refused || gone ? 8000 : 3000);
    // the chat's bucket said no where this page's said yes (another tab spent the tokens, or
    // this page was reloaded): its wait is the truth, and the button counts it down
    if (error === 'slow down') {
      const tier = this.tier();
      const ms = typeof wait === 'number' && wait > 0 ? wait : tier.window / tier.burst;
      this.bucket = {
        tokens: Math.max(0, 1 - (ms * tier.burst) / tier.window),
        at: Date.now()
      };
      this.refuse(ms);
    }
    // a role's or the channel's cooldown, or a timeout (docs/groups.md): the chat says how long,
    // and the button counts it down; the bucket is not the matter, so it is left alone
    if (error in NOTICE_WORDS && typeof wait === 'number' && wait > 0) this.refuse(wait);
    // the oldest line out was not taken: back into the box, unless something new is being typed
    if (/slow down|cooldown|timed out|chat is (busy|down)/.test(error)) {
      const lost = this.inFlight.shift();
      if (lost?.text && !store.get(this.draftAtom)) store.set(this.draftAtom, lost.text);
      if (lost && lost.images.length > 0 && store.get(this.imagesAtom).length === 0) store.set(this.imagesAtom, lost.images);
    }
    if (refused || gone) {
      this.hangUp();
      // a login is only ever refused when its cookie died (logout-all, passwd): stop being that name
      if (me) forgetMe();
    }
  }

  // ---- a server's channels ----------------------------------------------------------------------

  /**
   * The channel on screen, for a server room: the one shown goes back on the shelf as its live
   * tail, and the next one's comes off it. Nothing is asked of anyone: the lines were loaded
   * with the room, and the socket has kept every channel current since.
   */
  showChannel(next: string) {
    if (!this.server) return;
    shownServer = this.key;
    store.set(chatChannelAtom, next);
    if (next === this.channel) return;
    if (this.channel) this.tails.set(this.channel, this.liveTail());
    this.channel = next;
    store.set(this.channelAtom, next);
    this.resetHistory();
    this.scrollPlan = 'bottom';
    store.set(this.linesAtom, this.tails.get(next) ?? []);
    store.set(this.countAtom, this.counts.get(next) ?? 0);
  }

  /**
   * The api's last lines of every channel (`GET /api/groups/:group/messages`), onto the shelf,
   * and onto the screen for the channel shown. Merged by id with what the socket has brought
   * already, so whichever landed first, nothing is lost or drawn twice; then the socket is told
   * the newest id of each, and sends what came after.
   */
  seedChannels(lines: Record<string, ChatLine[]>) {
    for (const [name, raw] of Object.entries(lines)) {
      const fresh = Array.isArray(raw) ? raw.map(fromWire) : [];
      if (name === this.channel) {
        if (this.pinned && this.savedTail) this.savedTail = mergeLines(this.savedTail, fresh);
        else {
          if (this.following) this.scrollPlan = 'bottom';
          store.set(this.linesAtom, mergeLines(store.get(this.linesAtom), fresh));
        }
      } else this.tails.set(name, mergeLines(this.tails.get(name) ?? [], fresh));
    }
    store.set(this.loadedAtom, true);
    this.sendSince();
  }

  /** A channel added to the server since the socket opened (the events socket said so): follow it too. */
  followChannel(name: string) {
    const ws = this.ws;
    if (!this.server || !ws || ws.readyState !== WebSocket.OPEN) return;
    const join = { type: 'join', channel: name };
    record(`/chat/${this.key}`, 'out', join);
    ws.send(JSON.stringify(join));
  }

  /** A channel deleted from the server: its lines go with it. */
  dropChannel(name: string) {
    this.tails.delete(name);
    this.counts.delete(name);
  }

  /**
   * The channel `from` is called `to` now (the events socket said so): its tail and its count
   * on the shelf go under the new name, and when it is the one on screen, the screen is `to`'s
   * from here, live tail and all, so the page moving to the new address swaps nothing.
   */
  moveChannelLines(from: string, to: string) {
    if (from === to) return;
    const tail = this.tails.get(from);
    const count = this.counts.get(from);
    this.tails.delete(from);
    this.counts.delete(from);
    if (tail) this.tails.set(to, tail);
    if (count !== undefined) this.counts.set(to, count);
    if (this.channel === from) {
      this.channel = to;
      store.set(this.channelAtom, to);
      if (shownServer === this.key) store.set(chatChannelAtom, to);
    }
  }

  /** The live tail of the channel on screen: the one parked behind a jump, else the lines. */
  private liveTail(): ChatLine[] {
    return this.pinned && this.savedTail ? this.savedTail : store.get(this.linesAtom);
  }

  /** A line of a channel not on screen: onto its tail on the shelf, capped like the live tail. */
  private shelfAppend(name: string, line: ChatLine) {
    const tail = this.tails.get(name) ?? [];
    if (tail.some((have) => have.id === line.id)) return;
    const next = tail.length >= KEEP_LINES ? tail.slice(tail.length - KEEP_LINES + 1) : tail.slice();
    next.push(line);
    this.tails.set(name, next);
  }

  /** Tell the server socket what this page has, so it sends what came after. Nothing to say, nothing sent. */
  private sendSince() {
    const ws = this.ws;
    if (!this.server || !ws || ws.readyState !== WebSocket.OPEN) return;
    const since: Record<string, string> = {};
    for (const [name, tail] of this.tails) {
      const last = tail[tail.length - 1];
      if (last && name !== this.channel) since[name] = last.id;
    }
    if (this.channel) {
      const tail = this.liveTail();
      const last = tail[tail.length - 1];
      if (last) since[this.channel] = last.id;
    }
    if (Object.keys(since).length === 0) return;
    const frame = { type: 'since', since };
    record(`/chat/${this.key}`, 'out', frame);
    ws.send(JSON.stringify(frame));
  }

  /** My picture changed: every line of mine in this room wears the new one, on the tail, the shelf and a search. */
  reface(name: string, avatar: number | null) {
    const wear = (lines: ChatLine[]) => lines.map((line) => (line.from === name && (line.verified || line.streamer) ? { ...line, avatar } : line));
    store.set(this.linesAtom, wear(store.get(this.linesAtom)));
    const results = store.get(this.resultsAtom);
    if (results) store.set(this.resultsAtom, wear(results));
    if (this.savedTail) this.savedTail = wear(this.savedTail);
    for (const [key, tail] of this.tails) this.tails.set(key, wear(tail));
  }

  // ---- the scroll and the history ---------------------------------------------------------------

  /** The room the history routes read: a stream's name, or `server/<channel on screen>`. Null with no channel yet. */
  private httpRoom(): string | null {
    if (!this.server) return this.key;
    return this.channel ? `${this.server}/${this.channel}` : null;
  }

  private resetHistory() {
    this.pinned = false;
    this.savedTail = null;
    this.behind = 0;
    this.noMoreOlder = false;
    this.olderPaused = false;
    this.olderBusy = false;
    this.following = true;
    store.set(this.pinnedAtom, false);
    store.set(this.behindAtom, 0);
    // the hits stay: a server's are every channel's, so a change of channel from the list leaves the pane up
  }

  /** The view sits on the newest line, or the reader has scrolled up. */
  setFollowing(on: boolean) {
    this.following = on;
  }

  /** Scroll a pixel away from the top and a failed older-page can be asked again. */
  noteScroll(scrollTop: number) {
    if (scrollTop >= 48) this.olderPaused = false;
  }

  /**
   * The plan for the next time the lines paint: `bottom` after a join or "latest", `keep` when
   * older lines were prepended, or the id to put in the middle. Read once by the panel.
   */
  takeScrollPlan(): ScrollPlan {
    const plan = this.scrollPlan;
    this.scrollPlan = null;
    return plan;
  }

  /**
   * The lines on screen do not fill the list, so no scroll will ever reach its top to ask for
   * more: a server's channel asks now. Its first page is cut to the window's height
   * (room-atoms `loadLines`), and short lines may not fill it. A stream's room came with its
   * whole history on the socket, so there is nothing more to want.
   */
  fillShort() {
    if (this.server) void this.loadOlder();
  }

  /** Older than the oldest line on screen. Redis while it still has them, postgres past that. */
  async loadOlder() {
    const name = this.httpRoom();
    const oldest = store.get(this.linesAtom)[0];
    if (!name || !oldest || this.olderBusy || this.noMoreOlder || this.olderPaused) return;
    this.olderBusy = true;
    try {
      const lines = await chatGet(`/chat/${chatPath(name)}/before?id=${encodeURIComponent(oldest.id)}`);
      if (this.httpRoom() !== name) return;
      const have = new Set(store.get(this.linesAtom).map((l) => l.id));
      const older = lines.filter((l) => !have.has(l.id));
      if (older.length === 0 || older.length < OLDER_PAGE) this.noMoreOlder = true;
      if (older.length === 0) return;
      this.scrollPlan = 'keep';
      store.set(this.linesAtom, older.concat(store.get(this.linesAtom)));
    } catch (err) {
      this.olderPaused = true;
      this.showNotice(err instanceof Error ? err.message : 'could not load older lines');
    } finally {
      this.olderBusy = false;
    }
  }

  /**
   * Matches, newest first: a stream's room, or a server's, which is every channel the viewer
   * sees unless `channel:<name>` among the words names one (each hit then says its channel,
   * `ChatLine.channel`). Asked of the channel on screen; a change of channel meanwhile does not
   * drop the answer, since it is the server's. Off, the server says history is not kept.
   */
  async search(raw: string) {
    const name = this.httpRoom();
    const q = raw.trim();
    if (!name || !q) return;
    try {
      const lines = await chatGet(`/chat/${chatPath(name)}/search?q=${encodeURIComponent(q)}`);
      if (!this.server && this.httpRoom() !== name) return;
      store.set(this.resultsAtom, lines);
      store.set(this.resultsForAtom, q);
    } catch (err) {
      store.set(this.resultsAtom, null);
      this.showNotice(err instanceof Error ? err.message : 'search failed');
    }
  }

  /** One account's lines in this room, newest first. A nick with no account is not one. */
  async showSpeaker(speaker: string) {
    const name = this.httpRoom();
    if (!name) return;
    try {
      const lines = await chatGet(`/chat/${chatPath(name)}/by/${encodeURIComponent(speaker)}`);
      if (this.httpRoom() !== name) return;
      store.set(this.resultsAtom, lines);
      store.set(this.resultsForAtom, speaker);
    } catch (err) {
      store.set(this.resultsAtom, null);
      this.showNotice(err instanceof Error ? err.message : 'could not load those lines');
    }
  }

  clearResults() {
    store.set(this.resultsAtom, null);
    store.set(this.resultsForAtom, '');
  }

  /**
   * Put `id` in view. Already loaded: just scroll. Otherwise load the window around it and leave
   * the live tail parked, so "latest" comes back to it. `inChannel`, a server's hit from another
   * channel: that channel on screen first, the way the channel list would put it.
   */
  async openLine(id: string, inChannel?: string) {
    if (inChannel !== undefined && this.server && inChannel !== this.channel) this.showChannel(inChannel);
    const name = this.httpRoom();
    if (!name) return;
    if (store.get(this.linesAtom).some((l) => l.id === id)) {
      this.scrollPlan = { id };
      store.set(this.scrollAtom, store.get(this.scrollAtom) + 1);
      return;
    }
    try {
      const lines = await chatGet(`/chat/${chatPath(name)}/around/${encodeURIComponent(id)}`);
      if (this.httpRoom() !== name) return;
      if (!this.pinned) this.savedTail = store.get(this.linesAtom).slice();
      this.pinned = true;
      this.following = false;
      store.set(this.pinnedAtom, true);
      this.scrollPlan = { id };
      store.set(this.linesAtom, lines);
    } catch (err) {
      this.showNotice(err instanceof Error ? err.message : 'could not open that line');
    }
  }

  /** Back to the live tail that was on screen before a jump. */
  backToLatest() {
    const tail = this.savedTail;
    this.savedTail = null;
    this.pinned = false;
    this.behind = 0;
    this.following = true;
    this.noMoreOlder = false;
    store.set(this.pinnedAtom, false);
    store.set(this.behindAtom, 0);
    this.scrollPlan = 'bottom';
    if (tail) store.set(this.linesAtom, tail);
    else store.set(this.scrollAtom, store.get(this.scrollAtom) + 1);
  }

  /** To the newest line on the next paint: back to the live tail first when a jump has an old window on screen. Your own send's. */
  private toLatest() {
    if (this.pinned) {
      this.backToLatest();
      return;
    }
    this.following = true;
    this.scrollPlan = 'bottom';
    store.set(this.scrollAtom, store.get(this.scrollAtom) + 1);
  }

  /** A line onto the live tail (or the parked one, behind a jump). One already there, by id, is not drawn twice. */
  private appendLine(line: ChatLine) {
    if (this.pinned && this.savedTail) {
      if (this.savedTail.some((have) => have.id === line.id)) return;
      this.savedTail.push(line);
      if (this.savedTail.length > MAX_LOADED) this.savedTail.splice(0, this.savedTail.length - MAX_LOADED);
      this.behind += 1;
      store.set(this.behindAtom, this.behind);
      return;
    }
    const lines = store.get(this.linesAtom);
    if (lines.some((have) => have.id === line.id)) return;
    const cap = this.following ? KEEP_LINES : MAX_LOADED;
    const next = lines.length >= cap ? lines.slice(lines.length - cap + 1) : lines.slice();
    if (next.length < lines.length) this.noMoreOlder = false;
    next.push(line);
    store.set(this.linesAtom, next);
  }
}

// ---- every room at once -------------------------------------------------------------------------

/** The name changed (nick edited, logged in or out), or its groups did: every room this page is in says hello again as the new one. */
export function reconnectChat() {
  for (const room of rooms.values()) room.reconnect();
}

/**
 * My picture changed: every line of mine already on screen wears the new one, in every room. The
 * server gives a line its speaker's picture as it is now (chat.rs `with_faces`), so anything
 * loaded from here on is right on its own; this is the tab that was open. A line is mine when it
 * is `name`'s as a login or as the room's streamer: a nick's line is nobody's picture.
 */
export function refaceLines(name: string, avatar: number | null) {
  for (const room of rooms.values()) room.reface(name, avatar);
}

/** A server's room, for the room page's atoms (room-atoms.ts): made when the api's lines land before the panel does. */
export function serverChat(server: string): ChatRoom {
  return chatRoomFor(server, true);
}

/** A server's room when this page has one; a fact about a server nobody here is in has no lines to move. */
export function findServerChat(server: string): ChatRoom | undefined {
  return rooms.get(chatRoomKey(server, true));
}

/** The search box over a group's roster asks the server whose channel is on screen. */
export async function searchRoom(raw: string) {
  if (shownServer) await rooms.get(shownServer)?.search(raw);
}

/** One account's lines in the room `key` (a profile popup opened from a line there). */
export async function showSpeaker(speaker: string, key: string) {
  await rooms.get(key)?.showSpeaker(speaker);
}

// ---- lines --------------------------------------------------------------------------------------

/** A line from a chat server older than the badges has no `groups`, one older than the faces no `avatar`, one older than several pictures no `images`: a line with none of each. */
function fromWire(line: ChatLine): ChatLine {
  const images = picturesOf(line);
  return {
    ...line,
    groups: Array.isArray(line.groups) ? line.groups : [],
    avatar: typeof line.avatar === 'number' ? line.avatar : null,
    image: images[0] ?? null,
    images
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

function sameOwner(a: Owner | null, b: Owner | null): boolean {
  return (a === null && b === null) || (a !== null && b !== null && a.session === b.session && a.token === b.token);
}
