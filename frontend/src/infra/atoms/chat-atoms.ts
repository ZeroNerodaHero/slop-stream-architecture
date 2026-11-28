import { atom, type Atom, type PrimitiveAtom } from 'jotai';
import { atomWithStorage } from 'jotai/utils';

import { api, type GroupBadge, messageOf, type Owner, type PinnedLine } from '@/infra/api';
import { forgetMe, meAtom } from '@/infra/atoms/auth-atoms';
import { record } from '@/infra/atoms/inspector-atoms';
import { trackSocket } from '@/infra/debug/sockets';
import { encodeEmotes, tokensAsTyped } from '@/infra/emotes';
import { hideBotsAtom } from '@/infra/atoms/settings-atoms';
import { type Attached, Attachments, idsOf, isPictureRefusal, MAX_CHAT_IMAGES, releaseAttached, wordsOf } from '@/infra/chat-attach';
import { audioOf, type ChatAudio } from '@/infra/chat-audio';
import { type ChatVideo, videoOf } from '@/infra/chat-video';
import { relayUrl } from '@/infra/relay';
import { acquireTopic, listenTopic, onRtFrame, onRtPhase, pressTopic, rtAsk, rtFill, rtFresh, rtHolds, rtIdentify, rtOn } from '@/infra/rt/client';
import { rtPerfAnswer, rtPerfBegin, rtPerfMark, rtPerfSay } from '@/infra/rt/perf';
import type { Release } from '@/infra/rt/refs';
import { channelOf, chatTopicOf, type RtFrame, type Subbed } from '@/infra/rt/wire';
import { store } from '@/infra/store';
import { fromWire, picturesOf } from '@/infra/chat-wire';
import { type LinkEmbed, linkEmbedOf } from '@/infra/link-embed';
import { applyReaction, type Reaction, reacted, reactionsOf } from '@/shared-components/reaction-list';
import { HERE } from '@/infra/here';

export interface ChatLine {
  id: string;
  from: string;
  text: string;
  streamer: boolean;
  verified: boolean;
  groups: GroupBadge[];
  avatar: number | null;
  oauth_verified?: boolean;
  at: number;
  image?: string | null;
  images: string[];
  video?: ChatVideo | null;
  audio?: ChatAudio;
  channel?: string;
  reply?: ChatReply;
  mentions?: string[];
  reactions?: Reaction[];
  embed?: LinkEmbed | null;
  pending?: 'sending' | 'failed';
}

export interface ChatReply {
  id: string;
  from: string;
  text: string;
  streamer?: boolean;
  verified?: boolean;
  avatar?: number | null;
  images?: number;
  video?: boolean;
  audio?: boolean;
}

export const BOT_GROUP = 'bot';

export function isBotLine(line: ChatLine): boolean {
  return line.groups.some((g) => g.name === BOT_GROUP);
}

export type ChatPhase = 'off' | 'connecting' | 'open' | 'closed';

export const MAX_CHAT_CHARS = 500;
export { MAX_CHAT_IMAGES };
const KEEP_LINES = 500;
const RETRY_FIRST_MS = 250;
const RETRY_CAP_MS = 15_000;
const FAILED_SHOWN_MS = 6000;
const OLDER_PAGE = 50;
const MAX_LOADED = 2000;
const LEAVE_MS = 100;
const HISTORY_WAIT_MS = 4000;
const BOOT_CHAT_MS = 10_000;
const NO_LINE_YET = '0-0';

function chatPath(room: string): string {
  return room
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
}

const latestPath = (name: string) => `/chat/${chatPath(name)}/before`;

declare global {
  interface Window {
    __bootChat?: { name: string; born: number; lines: Promise<Response> };
  }
}

function takeBootChat(name: string): Promise<ChatLine[]> | null {
  const boot = window.__bootChat;
  if (!boot) return null;
  delete window.__bootChat;
  if (boot.name !== name || performance.now() - boot.born > BOOT_CHAT_MS) return null;
  return linesOf(boot.lines).catch(() => chatGet(latestPath(name)));
}

let takeEarly: (name: string) => Promise<ChatLine[]> | null = () => null;

export function takeHistoryFrom(take: (name: string) => Promise<ChatLine[]> | null) {
  takeEarly = take;
}

export function askLatest(name: string): Promise<ChatLine[]> {
  return chatGet(latestPath(name));
}

function askHistory(name: string): Promise<ChatLine[]> {
  return takeBootChat(name) ?? takeEarly(name) ?? askLatest(name);
}
const EVERY_CHANNEL = '*';
const NICK_RE = /^[a-zA-Z0-9_-]{1,24}$/;

export const nickAtom = atomWithStorage<string>('nick', '', undefined, {
  getOnInit: true
});
export const nickIsValidAtom = atom((get) => NICK_RE.test(get(nickAtom).trim()));
export const chatSpeakerAtom = atom((get) => get(meAtom) || get(nickAtom).trim());
export const chatChannelAtom = atom('');

export interface ChatTier {
  burst: number;
  window: number;
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

const NOTICE_WORDS: Record<string, string> = {
  cooldown: 'your role has a cooldown between lines',
  'channel cooldown': 'this channel has a cooldown between lines',
  'timed out': 'you are timed out here',
  'no such line': 'that line is gone, so the reply was not sent',
  'you are banned from this chat': 'you are banned from this chat'
};
const REACT_WORDS: Record<string, string> = {
  'no such line': 'that line is gone',
  'timed out': 'you are timed out here',
  'you are banned from this chat': 'you are banned from this chat',
  'too many reactions': 'that line has as many reactions as it holds'
};
const FLASH_MS = 1600;

type ScrollPlan = 'bottom' | 'keep' | { id: string } | null;

type Wire = {
  type?: string;
  messages?: ChatLine[];
  count?: number;
  error?: string;
  wait?: number;
  channel?: string;
  emoji?: string;
  who?: string;
  on?: boolean;
  react?: string;
  reader?: boolean;
} & Partial<ChatLine>;

interface RtHold {
  topic: string;
  release: Release;
  offs: (() => void)[];
  synced: boolean;
}

const EVICTED_WORDS = `too many chats are open in ${HERE}, close one to bring this back`;

export function isValidNick(nick: string): boolean {
  return NICK_RE.test(nick.trim());
}

export function chars(text: string): number {
  return [...text].length;
}

export function setNick(raw: string) {
  store.set(nickAtom, raw.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24));
}

const rooms = new Map<string, ChatRoom>();

function pressChat(topic: string) {
  if (rtHolds(topic)) return;
  rtPerfBegin(topic, 'press');
  pressTopic(topic);
}

export function warmServerChat(server: string) {
  if (!rtOn || (!store.get(meAtom) && !isValidNick(store.get(nickAtom).trim()))) return;
  pressChat(chatTopicOf(`${server}/${EVERY_CHANNEL}`));
}

const WARM_CHAT_MS = 5000;
let warm: { name: string; ws: WebSocket; me: string | null | undefined; timer: ReturnType<typeof setTimeout> } | null = null;

function dropWarm() {
  if (!warm) return;
  clearTimeout(warm.timer);
  warm.ws.close();
  warm = null;
}

export function warmChat(name: string) {
  if (rtOn) {
    pressChat(chatTopicOf(name));
    return;
  }
  if (rooms.get(name)?.connected()) return;
  if (warm?.name === name && warm.ws.readyState <= WebSocket.OPEN) {
    clearTimeout(warm.timer);
    warm.timer = setTimeout(dropWarm, WARM_CHAT_MS);
    return;
  }
  dropWarm();
  warm = { name, ws: trackSocket('chat', new WebSocket(relayUrl(`/chat/${chatPath(name)}`)), `/chat/${chatPath(name)}`), me: store.get(meAtom), timer: setTimeout(dropWarm, WARM_CHAT_MS) };
}

function takeWarmChat(name: string): WebSocket | null {
  const held = warm;
  if (!held || held.name !== name) return null;
  clearTimeout(held.timer);
  warm = null;
  const me = store.get(meAtom);
  if (held.ws.readyState > WebSocket.OPEN || (held.me !== undefined && me !== undefined && held.me !== me)) {
    held.ws.close();
    return null;
  }
  return held.ws;
}
let shownServer: string | null = null;

export function chatRoomKey(name: string, server: boolean): string {
  return server ? `${name}/${EVERY_CHANNEL}` : name;
}

export function chatRoomFor(name: string, server = false): ChatRoom {
  const key = chatRoomKey(name, server);
  let room = rooms.get(key);
  if (!room) {
    room = new ChatRoom(key, server ? name : null);
    rooms.set(key, room);
  }
  return room;
}

export class ChatRoom {
  readonly key: string;
  readonly server: string | null;

  readonly phaseAtom: PrimitiveAtom<ChatPhase> = atom<ChatPhase>('off');
  readonly linesAtom: PrimitiveAtom<ChatLine[]> = atom<ChatLine[]>([]);
  readonly loadedAtom: PrimitiveAtom<boolean> = atom(false);
  readonly countAtom: PrimitiveAtom<number> = atom(0);
  readonly draftAtom: PrimitiveAtom<string> = atom('');
  readonly attach: Attachments = new Attachments((text) => this.showNotice(text));
  readonly picturesAtom = this.attach.picturesAtom;
  readonly videoAtom = this.attach.videoAtom;
  readonly voiceAtom = this.attach.voiceAtom;
  readonly readyIdsAtom = this.attach.readyIdsAtom;
  readonly sendingAtom: PrimitiveAtom<boolean> = atom(false);
  readonly noticeAtom: PrimitiveAtom<string> = atom('');
  readonly asStreamerAtom: PrimitiveAtom<boolean> = atom(false);
  readonly waitAtom: PrimitiveAtom<number> = atom(0);
  readonly shakeAtom: PrimitiveAtom<number> = atom(0);
  readonly resultsAtom: PrimitiveAtom<ChatLine[] | null> = atom<ChatLine[] | null>(null);
  readonly resultsForAtom: PrimitiveAtom<string> = atom('');
  readonly pinnedAtom: PrimitiveAtom<boolean> = atom(false);
  readonly behindAtom: PrimitiveAtom<number> = atom(0);
  readonly scrollAtom: PrimitiveAtom<number> = atom(0);
  readonly guestAtom: PrimitiveAtom<boolean> = atom(false);
  readonly readerAtom: PrimitiveAtom<boolean> = atom(false);
  readonly pendingAtom: PrimitiveAtom<ChatLine[]> = atom<ChatLine[]>([]);
  readonly channelAtom: PrimitiveAtom<string> = atom('');
  readonly replyAtom: PrimitiveAtom<ChatLine | null> = atom<ChatLine | null>(null);
  readonly flashAtom: PrimitiveAtom<string | null> = atom<string | null>(null);

  readonly visibleLinesAtom: Atom<ChatLine[]>;
  readonly hiddenBotLinesAtom: Atom<number>;
  readonly tierAtom: Atom<ChatTier>;
  readonly canSendAtom: Atom<boolean>;

  private joins = new Map<symbol, Owner | null>();
  private owner: Owner | null = null;
  private me: string | null | undefined = null;
  private nick = '';
  private history: Promise<void> | null = null;
  private historyRun = 0;
  private historyHeld = false;
  private greeted = false;
  private ws: WebSocket | null = null;
  private rt: RtHold | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private leaving: ReturnType<typeof setTimeout> | null = null;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  private bucket: { tokens: number; at: number };
  private inFlight: ({ key: string; text: string; images: string[]; reply: ChatLine | null } & Attached)[] = [];
  private sent = 0;
  private acked = new Map<string, string>();
  private retries = 0;
  private flashTimer: ReturnType<typeof setTimeout> | null = null;
  private wasOpen = false;

  private scrollPlan: ScrollPlan = null;
  private following = true;
  private olderBusy = false;
  private noMoreOlder = false;
  private olderPaused = false;
  private pinned = false;
  private savedTail: ChatLine[] | null = null;
  private behind = 0;

  private tails = new Map<string, ChatLine[]>();
  private counts = new Map<string, number>();
  private channel = '';

  constructor(key: string, server: string | null) {
    this.key = key;
    this.server = server;
    this.bucket = { tokens: TIERS.anon.burst, at: Date.now() };
    const lines = this.linesAtom;
    const asStreamer = this.asStreamerAtom;
    const pending = this.pendingAtom;
    const shownChannel = this.channelAtom;
    this.visibleLinesAtom = atom((get) => {
      const all = get(lines);
      const shown = get(hideBotsAtom) ? all.filter((line) => !isBotLine(line)) : all;
      const here = get(shownChannel);
      const mine = get(pending).filter((line) => (line.channel ?? '') === here);
      return mine.length > 0 ? [...shown, ...mine] : shown;
    });
    this.hiddenBotLinesAtom = atom((get) => (get(hideBotsAtom) ? get(lines).filter(isBotLine).length : 0));
    this.tierAtom = atom((get) => (get(meAtom) || get(asStreamer) ? TIERS.login : TIERS.anon));
    const draft = this.draftAtom;
    const attached = this.attach.anyAtom;
    const sending = this.sendingAtom;
    const phase = this.phaseAtom;
    const reader = this.readerAtom;
    this.canSendAtom = atom((get) => {
      const length = chars(get(draft).trim());
      return !get(sending) && get(phase) === 'open' && !get(reader) && length <= MAX_CHAT_CHARS && (length > 0 || get(attached));
    });
  }

  join(owner: Owner | null = null): () => void {
    const token = Symbol(this.key);
    this.joins.set(token, owner);
    if (!rooms.has(this.key)) rooms.set(this.key, this);
    if (this.leaving) clearTimeout(this.leaving);
    this.leaving = null;
    this.open();
    return () => this.leave(token);
  }

  private leave(token: symbol) {
    if (!this.joins.delete(token)) return;
    if (this.joins.size > 0) {
      if (!sameOwner(this.owner, this.wantedOwner())) this.open();
      return;
    }
    if (this.leaving) return;
    this.leaving = setTimeout(() => {
      this.leaving = null;
      if (this.joins.size === 0) this.close();
    }, LEAVE_MS);
  }

  private wantedOwner(): Owner | null {
    let owner: Owner | null = null;
    for (const o of this.joins.values()) if (o) owner = o;
    return owner;
  }

  open() {
    const owner = this.wantedOwner();
    const me = store.get(meAtom);
    const nick = me ? '' : store.get(nickAtom).trim();
    this.loadHistory();
    const same = sameOwner(this.owner, owner) && this.sameSpeaker(me, nick);
    if ((this.ws || this.rt) && same) {
      if (!this.greeted && me !== undefined) {
        this.me = me;
        this.nick = nick;
      }
      return;
    }
    this.owner = owner;
    this.hangUp();
    if (!same) {
      this.bucket = { tokens: this.tier().burst, at: Date.now() };
      if (rtOn) rtIdentify();
    }
    this.connect();
  }

  private sameSpeaker(me: string | null | undefined, nick: string): boolean {
    if (me === undefined || (this.me === undefined && !this.greeted)) return true;
    if (typeof me === 'string') return this.me === me;
    return typeof this.me !== 'string' && this.nick === nick;
  }

  private loadHistory() {
    if (this.server || this.history) return;
    const run = ++this.historyRun;
    this.history = askHistory(this.key).then(
      (lines) => {
        if (this.historyRun !== run) return;
        this.historyHeld = true;
        this.scrollPlan = 'bottom';
        store.set(this.linesAtom, mergeLines(lines, store.get(this.linesAtom)));
        store.set(this.loadedAtom, true);
        if (this.rt) rtPerfMark(this.rt.topic, 'history');
        this.rtSync();
      },
      (err: unknown) => {
        if (this.historyRun !== run) return;
        this.history = null;
        store.set(this.loadedAtom, true);
        this.showNotice(err instanceof Error ? err.message : 'could not load the chat');
      }
    );
  }

  private settled(): Promise<void> {
    const history = this.history;
    if (!history) return Promise.resolve();
    return Promise.race([history, new Promise<void>((done) => setTimeout(done, HISTORY_WAIT_MS))]);
  }

  private sinceId(): string | undefined {
    const tail = this.liveTail();
    const last = tail[tail.length - 1];
    if (last) return last.id;
    return this.historyHeld ? NO_LINE_YET : undefined;
  }

  connected(): boolean {
    return this.ws !== null || this.rt !== null;
  }

  reconnect() {
    if (this.joins.size === 0) return;
    this.hangUp();
    this.bucket = { tokens: this.tier().burst, at: Date.now() };
    this.connect();
  }

  setGuest(on: boolean) {
    store.set(this.guestAtom, on);
  }

  private hangUp() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
    }
    this.ws = null;
    this.dropRt();
    this.acked.clear();
    for (const lost of this.inFlight.splice(0)) this.restore(lost, null);
    this.resetHistory();
    this.clearResults();
    store.set(this.phaseAtom, 'off');
  }

  private close() {
    this.hangUp();
    store.set(this.linesAtom, []);
    store.set(this.loadedAtom, false);
    store.set(this.countAtom, 0);
    store.set(this.asStreamerAtom, false);
    store.set(this.draftAtom, '');
    this.attach.clear();
    store.set(this.sendingAtom, false);
    store.set(this.replyAtom, null);
    store.set(this.flashAtom, null);
    store.set(this.noticeAtom, '');
    store.set(this.waitAtom, 0);
    store.set(this.guestAtom, false);
    store.set(this.readerAtom, false);
    store.set(this.pendingAtom, []);
    this.retries = 0;
    this.owner = null;
    this.me = null;
    this.nick = '';
    this.greeted = false;
    this.historyRun += 1;
    this.history = null;
    this.historyHeld = false;
    this.tails = new Map();
    this.counts = new Map();
    this.wasOpen = false;
    this.channel = '';
    store.set(this.channelAtom, '');
    if (shownServer === this.key) {
      shownServer = null;
      store.set(chatChannelAtom, '');
    }
    if (rooms.get(this.key) === this) rooms.delete(this.key);
  }

  setDraft(raw: string) {
    store.set(this.draftAtom, [...raw].slice(0, MAX_CHAT_CHARS + 50).join(''));
  }

  addPictures(files: File[]) {
    this.attach.addPictures(files);
  }

  removePicture(key: string) {
    this.attach.removePicture(key);
  }

  addVideo(file: File, many = false) {
    this.attach.addVideo(file, many);
  }

  removeVideo() {
    this.attach.removeVideo();
  }

  setReply(line: ChatLine | null) {
    store.set(this.replyAtom, line);
  }

  async jumpToReply(id: string, inChannel?: string) {
    if (!(await this.openLine(id, inChannel, 'that line is not here any more'))) return;
    store.set(this.flashAtom, id);
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => {
      if (store.get(this.flashAtom) === id) store.set(this.flashAtom, null);
    }, FLASH_MS);
  }

  react(line: ChatLine, emoji: string) {
    const me = store.get(meAtom);
    if (!me) {
      this.showNotice('log in to react');
      return;
    }
    const on = !(line.reactions ?? []).some((r) => r.emoji === emoji && reacted(r, me));
    if (this.rt) {
      if (store.get(this.phaseAtom) !== 'open') {
        this.showNotice('chat is down, try again');
        return;
      }
      const topic = this.server ? chatTopicOf(`${this.server}/${line.channel ?? this.channel}`) : this.rt.topic;
      void rtAsk({ type: 'react', topic, id: line.id, emoji, on }).then((answer) => {
        if (answer.type === 'nack') this.showNotice(REACT_WORDS[answer.error] ?? answer.error);
      });
      return;
    }
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      this.showNotice('chat is down, try again');
      return;
    }
    const frame: Record<string, unknown> = { type: 'react', id: line.id, emoji, on };
    if (this.server) frame.channel = line.channel ?? this.channel;
    record(`/chat/${this.key}`, 'out', frame);
    ws.send(JSON.stringify(frame));
  }

  private applyReact(channel: string | null, id: string, emoji: string, who: string, on: boolean) {
    const me = store.get(meAtom);
    const touch = (lines: ChatLine[]) => {
      const at = lines.findIndex((l) => l.id === id);
      const line = lines[at];
      if (!line) return lines;
      const next = lines.slice();
      next[at] = { ...line, reactions: applyReaction(line.reactions, emoji, who, on, me) };
      return next;
    };
    if (channel !== null && channel !== this.channel) {
      const tail = this.tails.get(channel);
      if (tail) this.tails.set(channel, touch(tail));
    } else {
      const lines = store.get(this.linesAtom);
      const next = touch(lines);
      if (next !== lines) store.set(this.linesAtom, next);
      if (this.savedTail) this.savedTail = touch(this.savedTail);
    }
    const results = store.get(this.resultsAtom);
    if (results?.some((l) => l.id === id && (channel === null || l.channel === undefined || l.channel === channel))) {
      store.set(
        this.resultsAtom,
        results.map((l) =>
          l.id === id && (channel === null || l.channel === undefined || l.channel === channel) ? { ...l, reactions: applyReaction(l.reactions, emoji, who, on, me) } : l
        )
      );
    }
  }

  private patchLine(channel: string | null, id: string, next: (line: ChatLine) => ChatLine) {
    const touch = (lines: ChatLine[]) => {
      const at = lines.findIndex((l) => l.id === id);
      const line = lines[at];
      if (!line) return lines;
      const out = lines.slice();
      out[at] = next(line);
      return out;
    };
    if (channel !== null && channel !== this.channel) {
      const tail = this.tails.get(channel);
      if (tail) this.tails.set(channel, touch(tail));
    } else {
      const lines = store.get(this.linesAtom);
      const out = touch(lines);
      if (out !== lines) store.set(this.linesAtom, out);
      if (this.savedTail) this.savedTail = touch(this.savedTail);
    }
    const results = store.get(this.resultsAtom);
    const hit = (l: ChatLine) => l.id === id && (channel === null || l.channel === undefined || l.channel === channel);
    if (results?.some(hit)) store.set(this.resultsAtom, results.map((l) => (hit(l) ? next(l) : l)));
  }

  setEmbed(id: string, embed: LinkEmbed | null, channel: string | null = null) {
    this.patchLine(channel, id, (line) => ({ ...line, embed }));
  }

  hideEmbed(line: ChatLine) {
    const channel = this.server ? (line.channel ?? this.channel) : null;
    const was = line.embed ?? null;
    this.setEmbed(line.id, null, channel);
    const asked = this.server && channel ? api.hideGroupEmbed(this.server, channel, line.id) : api.hideStreamEmbed(this.key, line.id);
    asked.catch((err: unknown) => {
      this.setEmbed(line.id, was, channel);
      this.showNotice(messageOf(err));
    });
  }

  removeLine(id: string, channel: string | null = null) {
    const drop = (lines: ChatLine[]) => (lines.some((l) => l.id === id) ? lines.filter((l) => l.id !== id) : lines);
    if (channel !== null && channel !== this.channel) {
      const tail = this.tails.get(channel);
      if (tail) this.tails.set(channel, drop(tail));
    } else {
      const lines = store.get(this.linesAtom);
      const next = drop(lines);
      if (next !== lines) store.set(this.linesAtom, next);
      if (this.savedTail) this.savedTail = drop(this.savedTail);
    }
    const results = store.get(this.resultsAtom);
    if (results?.some((l) => l.id === id && (channel === null || l.channel === undefined || l.channel === channel))) {
      store.set(
        this.resultsAtom,
        results.filter((l) => !(l.id === id && (channel === null || l.channel === undefined || l.channel === channel)))
      );
    }
  }

  showNotice(text: string, ms = 4000) {
    store.set(this.noticeAtom, wordsOf(text));
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => store.set(this.noticeAtom, ''), ms);
  }

  async send() {
    if (store.get(this.sendingAtom)) return;
    if (!store.get(this.draftAtom).trim() && !this.attach.any()) return;
    store.set(this.sendingAtom, true);
    try {
      await this.attach.settle();
    } finally {
      store.set(this.sendingAtom, false);
    }
    const error = this.attach.errorOf();
    if (error) {
      this.showNotice(error, 4000);
      return;
    }
    const ws = this.ws;
    const text = store.get(this.draftAtom).trim();
    const pictures = this.attach.pictures();
    const images = idsOf(pictures);
    const clip = this.attach.video();
    const video = clip?.video ?? null;
    const audio = this.attach.voice()?.audio;
    const live = this.rt ? store.get(this.phaseAtom) === 'open' : ws !== null && ws.readyState === WebSocket.OPEN;
    if (!live || (!text && images.length === 0 && !video && !audio)) return;
    if (chars(text) > MAX_CHAT_CHARS) {
      this.showNotice('too long');
      return;
    }
    if (this.server && !this.channel) return;
    const held = store.get(this.waitAtom) - Date.now();
    if (held > 0) {
      this.refuse(held);
      return;
    }
    const wait = this.takeToken();
    if (wait > 0) {
      this.refuse(wait);
      return;
    }
    const words = encodeEmotes(text);
    const say: Record<string, unknown> = images.length ? { type: 'say', text: words, image: images[0], images } : { type: 'say', text: words };
    if (video) say.video = video.id;
    if (audio) say.audio = audio.id;
    const reply = store.get(this.replyAtom);
    if (reply) say.reply = reply.id;
    const key = `pending-${++this.sent}`;
    if (this.rt) {
      const topic = this.server ? chatTopicOf(`${this.server}/${this.channel}`) : this.rt.topic;
      rtPerfSay(key, undefined, topic);
      void rtAsk({ ...say, type: 'say', topic }).then((answer) => {
        rtPerfAnswer(key, answer.type === 'ack');
        if (answer.type === 'ack') {
          if (typeof answer.id === 'string') this.onAck(key, answer.id);
          return;
        }
        const at = this.inFlight.findIndex((sent) => sent.key === key);
        const [lost] = at >= 0 ? this.inFlight.splice(at, 1) : [];
        if (lost) this.restore(lost, answer.error);
        this.onError(answer.error, answer.wait, typeof this.me === 'string' ? this.me : null, false);
      });
    } else if (ws) {
      if (this.server) say.channel = this.channel;
      record(`/chat/${this.key}`, 'out', say);
      ws.send(JSON.stringify(say));
    }
    const asStreamer = store.get(this.asStreamerAtom);
    const line: ChatLine = {
      id: key,
      from: asStreamer ? this.key : store.get(chatSpeakerAtom),
      text: words,
      streamer: asStreamer,
      verified: Boolean(store.get(meAtom)),
      groups: [],
      avatar: null,
      at: Date.now(),
      image: images[0] ?? null,
      images,
      video,
      audio,
      reply: reply ? quoteOf(reply) : undefined,
      channel: this.server ? this.channel : undefined,
      pending: 'sending'
    };
    store.set(this.pendingAtom, [...store.get(this.pendingAtom), line]);
    this.inFlight.push({ key, text, images, reply, ...this.attach.take() });
    store.set(this.draftAtom, '');
    store.set(this.replyAtom, null);
    this.toLatest();
  }

  private tier(): ChatTier {
    return this.owner || store.get(meAtom) ? TIERS.login : TIERS.anon;
  }

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

  private refuse(wait: number) {
    store.set(this.waitAtom, Date.now() + wait);
    store.set(this.shakeAtom, store.get(this.shakeAtom) + 1);
  }

  private connect() {
    const known = store.get(meAtom);
    const owner = this.owner;
    if (this.server && !owner && known === undefined) {
      store.set(this.phaseAtom, 'off');
      return;
    }
    const me = known ?? null;
    const nick = store.get(nickAtom).trim();
    if (this.server && !owner && !me && !isValidNick(nick)) {
      store.set(this.phaseAtom, 'off');
      return;
    }
    if (rtOn && !owner) {
      this.connectRt(known, nick);
      return;
    }

    this.loadHistory();
    store.set(this.phaseAtom, 'connecting');
    const ws = (this.server ? null : takeWarmChat(this.key)) ?? trackSocket('chat', new WebSocket(relayUrl(`/chat/${chatPath(this.key)}`)), `/chat/${chatPath(this.key)}`);
    this.ws = ws;
    this.me = known;
    this.nick = me ? '' : nick;
    this.greeted = false;
    store.set(this.readerAtom, false);
    const source = `/chat/${this.key}`;

    const greet = async () => {
      if (!this.server) await this.settled();
      if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
      const speaker = store.get(meAtom);
      if (speaker !== undefined) this.me = speaker;
      const named = owner || typeof this.me === 'string' ? {} : isValidNick(this.nick) ? { nick: this.nick } : {};
      const since = this.server ? undefined : this.sinceId();
      const hello = {
        type: 'hello',
        ...(owner ? { nick, session: owner.session, token: owner.token } : named),
        ...(since ? { since } : {})
      };
      record(source, 'out', hello);
      ws.send(JSON.stringify(hello));
      this.greeted = true;
      store.set(this.phaseAtom, 'open');
      store.set(this.asStreamerAtom, owner !== null || this.me === this.key);
      if (this.server) this.sendSince();
      if (this.server && this.wasOpen) void this.refreshReactions();
      if (!this.server && this.wasOpen) void this.refreshLatest();
      this.wasOpen = true;
    };
    if (ws.readyState === WebSocket.OPEN) void greet();
    else ws.onopen = greet;
    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      let msg: Wire;
      try {
        msg = JSON.parse(String(e.data));
      } catch {
        return;
      }
      record(source, 'in', msg);
      this.retries = 0;
      this.onWire(msg, this.server && typeof msg.channel === 'string' ? msg.channel : null);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      store.set(this.phaseAtom, 'closed');
      this.ws = null;
      this.timer = setTimeout(() => {
        this.timer = null;
        if (this.joins.size > 0) this.connect();
      }, retryAfter(this.retries++));
    };
  }

  private onAck(key: string, id: string) {
    const at = this.inFlight.findIndex((p) => p.key === key);
    if (at < 0) return;
    const seen = store.get(this.linesAtom).some((line) => line.id === id) || [...this.tails.values()].some((lines) => lines.some((line) => line.id === id));
    if (!seen) {
      this.acked.set(id, key);
      return;
    }
    const echoed = this.inFlight.splice(at, 1)[0]!;
    releaseAttached(echoed);
    this.dropPending(echoed.key);
  }

  private onWire(msg: Wire, tagged: string | null) {
    if (msg.type === 'ready') {
      store.set(this.readerAtom, msg.reader === true);
    } else if (msg.type === 'message' && msg.id) {
      const said = tokensAsTyped(msg.text ?? '');
      const ackedKey = this.acked.get(msg.id);
      this.acked.delete(msg.id);
      let sent = ackedKey === undefined ? -1 : this.inFlight.findIndex((p) => p.key === ackedKey);
      if (sent < 0)
        sent = this.inFlight.findIndex(
          (p) =>
            p.text === said &&
            samePictures(p.images, picturesOf(msg)) &&
            (p.video?.video?.id ?? null) === (videoOf(msg.video)?.id ?? null) &&
            (p.voice?.audio?.id ?? null) === (audioOf(msg.audio)?.id ?? null)
        );
      if (sent >= 0) {
        const echoed = this.inFlight.splice(sent, 1)[0]!;
        releaseAttached(echoed);
        this.dropPending(echoed.key);
      }
      const line = fromWire(msg as ChatLine);
      if (tagged !== null && tagged !== this.channel) this.shelfAppend(tagged, line);
      else {
        this.appendLine(line);
        if (sent >= 0) this.toLatest();
      }
    } else if (msg.type === 'count' && typeof msg.count === 'number') {
      if (tagged !== null) {
        this.counts.set(tagged, msg.count);
        if (tagged === this.channel) store.set(this.countAtom, msg.count);
      } else store.set(this.countAtom, msg.count);
    } else if (msg.type === 'react' && typeof msg.id === 'string' && typeof msg.emoji === 'string' && typeof msg.who === 'string') {
      this.applyReact(tagged, msg.id, msg.emoji, msg.who, msg.on === true);
    } else if (msg.type === 'delete' && typeof msg.id === 'string') {
      this.removeLine(msg.id, tagged);
    } else if (msg.type === 'embed' && typeof msg.id === 'string') {
      this.setEmbed(msg.id, linkEmbedOf(msg.embed), tagged);
    } else if (msg.type === 'error' && msg.error && typeof msg.react === 'string') {
      this.showNotice(REACT_WORDS[msg.error] ?? msg.error);
    } else if (msg.type === 'error' && msg.error) {
      this.onError(msg.error, msg.wait, typeof this.me === 'string' ? this.me : null);
    }
  }

  private connectRt(known: string | null | undefined, nick: string) {
    this.loadHistory();
    const topic = chatTopicOf(this.server ? `${this.server}/${EVERY_CHANNEL}` : this.key);
    this.me = known;
    this.nick = typeof known === 'string' ? '' : nick;
    this.greeted = true;
    store.set(this.readerAtom, !this.server && typeof known !== 'string' && !isValidNick(nick));
    store.set(this.phaseAtom, 'connecting');
    rtPerfBegin(topic, 'mount');
    const rt: RtHold = { topic, release: acquireTopic(topic), offs: [], synced: false };
    this.rt = rt;
    rt.offs.push(
      listenTopic(topic, (frame) => {
        if (this.rt === rt) this.onRt(frame);
      }),
      onRtFrame((frame) => {
        if (this.rt === rt && frame.type === 'subbed') this.onRtSubbed(rt, frame as unknown as Subbed);
      }),
      onRtPhase((phase) => {
        if (this.rt !== rt || phase === 'open') return;
        rt.synced = false;
        if (store.get(this.phaseAtom) === 'open') store.set(this.phaseAtom, 'closed');
      })
    );
    if (rtHolds(topic)) this.rtOpened(rt);
  }

  private dropRt() {
    const rt = this.rt;
    this.rt = null;
    if (!rt) return;
    for (const off of rt.offs.splice(0)) off();
    rt.release();
  }

  private onRtSubbed(rt: RtHold, frame: Subbed) {
    if ((frame.topics ?? []).includes(rt.topic)) {
      this.rtOpened(rt);
      return;
    }
    const refused = (frame.refused ?? []).find((r) => r.topic === rt.topic);
    if (refused) {
      if (refused.error === 'slow down') return;
      rt.synced = false;
      store.set(this.phaseAtom, 'closed');
      this.onError(refused.error, undefined, typeof this.me === 'string' ? this.me : null);
      return;
    }
    if ((frame.evicted ?? []).includes(rt.topic) && store.get(this.phaseAtom) !== 'closed') {
      rt.synced = false;
      store.set(this.phaseAtom, 'closed');
      this.showNotice(EVICTED_WORDS, 8000);
    }
  }

  private rtOpened(rt: RtHold) {
    rtPerfMark(rt.topic, 'subbed');
    if (store.get(this.phaseAtom) !== 'open') {
      store.set(this.phaseAtom, 'open');
      store.set(this.asStreamerAtom, this.me === this.key);
      if (this.wasOpen) {
        if (this.server) void this.refreshReactions();
        else void this.refreshLatest();
      }
      this.wasOpen = true;
    }
    if (rt.synced) return;
    rt.synced = true;
    this.rtSync();
  }

  private rtSync() {
    const rt = this.rt;
    if (!rt || store.get(this.phaseAtom) !== 'open') return;
    if (this.server) {
      this.sendSince();
      return;
    }
    const since = this.historyHeld ? this.sinceId() : undefined;
    if (since) rtFill({ [rt.topic]: since });
  }

  private onRt(frame: RtFrame) {
    const topic = typeof frame.topic === 'string' ? frame.topic : '';
    if (frame.type === 'gap') {
      void this.fillGap();
      return;
    }
    if (frame.type === 'message' && this.rt) rtPerfMark(this.rt.topic, 'first-line');
    const msg: Record<string, unknown> = { ...frame };
    delete msg.topic;
    this.onWire(msg as Wire, this.server ? channelOf(topic) : null);
  }

  private async fillGap() {
    const server = this.server;
    const link = this.rt;
    try {
      if (server) {
        const pages = await api.groupMessages(server);
        if (this.rt === link && this.server === server) this.seedChannels(pages);
        return;
      }
      const fresh = await askLatest(this.key);
      if (this.rt !== link) return;
      if (this.pinned && this.savedTail) this.savedTail = mergeLines(this.savedTail, fresh);
      else store.set(this.linesAtom, mergeLines(store.get(this.linesAtom), fresh));
    } catch {
      return;
    }
  }

  private onError(error: string, wait: number | undefined, me: string | null, unmatched = true) {
    const refused = /nick|account/.test(error);
    const gone = /no such channel|not a server|that name is reserved|bad name/.test(error);
    this.showNotice(NOTICE_WORDS[error] ?? error, refused || gone ? 8000 : 3000);
    if (error === 'slow down') {
      const tier = this.tier();
      const ms = typeof wait === 'number' && wait > 0 ? wait : tier.window / tier.burst;
      this.bucket = {
        tokens: Math.max(0, 1 - (ms * tier.burst) / tier.window),
        at: Date.now()
      };
      this.refuse(ms);
    }
    if (error in NOTICE_WORDS && typeof wait === 'number' && wait > 0) this.refuse(wait);
    if (unmatched && /slow down|cooldown|timed out|banned|chat is (busy|down)|no such line|image rejected|never checked|picture/.test(error)) {
      const lost = this.inFlight.shift();
      if (lost) this.restore(lost, error);
    }
    if (refused || gone) {
      this.hangUp();
      if (me) forgetMe();
    }
  }

  private dropPending(key: string) {
    const pending = store.get(this.pendingAtom);
    if (pending.some((line) => line.id === key)) store.set(this.pendingAtom, pending.filter((line) => line.id !== key));
  }

  private failPending(key: string) {
    store.set(this.pendingAtom, store.get(this.pendingAtom).map((line) => (line.id === key ? { ...line, pending: 'failed' as const } : line)));
    setTimeout(() => this.dropPending(key), FAILED_SHOWN_MS);
  }

  private restore(lost: { key: string; text: string; reply: ChatLine | null } & Attached, error: string | null) {
    this.failPending(lost.key);
    if (lost.text && !store.get(this.draftAtom)) store.set(this.draftAtom, lost.text);
    this.attach.restore(lost, error && isPictureRefusal(error) ? error : null);
    if (lost.reply && error !== 'no such line' && !store.get(this.replyAtom)) store.set(this.replyAtom, lost.reply);
  }

  showChannel(next: string) {
    if (!this.server) return;
    shownServer = this.key;
    store.set(chatChannelAtom, next);
    if (next === this.channel) return;
    if (this.channel) this.tails.set(this.channel, this.liveTail());
    this.channel = next;
    store.set(this.channelAtom, next);
    store.set(this.replyAtom, null);
    store.set(this.flashAtom, null);
    this.resetHistory();
    this.scrollPlan = 'bottom';
    store.set(this.linesAtom, this.tails.get(next) ?? []);
    store.set(this.countAtom, this.counts.get(next) ?? 0);
  }

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

  followChannel(name: string) {
    if (this.rt) {
      if (this.server) rtFresh(this.rt.topic);
      return;
    }
    const ws = this.ws;
    if (!this.server || !ws || ws.readyState !== WebSocket.OPEN) return;
    const join = { type: 'join', channel: name };
    record(`/chat/${this.key}`, 'out', join);
    ws.send(JSON.stringify(join));
  }

  dropChannel(name: string) {
    this.tails.delete(name);
    this.counts.delete(name);
  }

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

  private liveTail(): ChatLine[] {
    return this.pinned && this.savedTail ? this.savedTail : store.get(this.linesAtom);
  }

  private async refreshReactions() {
    const server = this.server;
    if (!server) return;
    let pages: Record<string, ChatLine[]>;
    try {
      pages = await api.groupMessages(server);
    } catch {
      return;
    }
    if (this.server !== server || !(this.ws || this.rt)) return;
    for (const [channel, raw] of Object.entries(pages)) {
      if (!Array.isArray(raw)) continue;
      const fresh = new Map(raw.map((line) => [line.id, reactionsOf(line.reactions)]));
      const wear = (lines: ChatLine[]) => lines.map((line) => (fresh.has(line.id) ? { ...line, reactions: fresh.get(line.id) } : line));
      if (channel === this.channel) {
        store.set(this.linesAtom, wear(store.get(this.linesAtom)));
        if (this.savedTail) this.savedTail = wear(this.savedTail);
      } else {
        const tail = this.tails.get(channel);
        if (tail) this.tails.set(channel, wear(tail));
      }
    }
  }

  private async refreshLatest() {
    const link = this.ws ?? this.rt;
    let fresh: ChatLine[];
    try {
      fresh = await askLatest(this.key);
    } catch {
      return;
    }
    const first = fresh[0];
    const last = fresh[fresh.length - 1];
    if ((this.ws ?? this.rt) !== link || !first || !last) return;
    const byId = new Map(fresh.map((line) => [line.id, line]));
    const within = (id: string) => compareIds(id, first.id) >= 0 && compareIds(id, last.id) <= 0;
    const wear = (lines: ChatLine[]) =>
      lines.flatMap((line) => {
        const now = byId.get(line.id);
        if (now) return [{ ...line, reactions: now.reactions }];
        return within(line.id) ? [] : [line];
      });
    store.set(this.linesAtom, wear(store.get(this.linesAtom)));
    if (this.savedTail) this.savedTail = wear(this.savedTail);
  }

  private shelfAppend(name: string, line: ChatLine) {
    const tail = this.tails.get(name) ?? [];
    if (tail.some((have) => have.id === line.id)) return;
    const next = tail.length >= KEEP_LINES ? tail.slice(tail.length - KEEP_LINES + 1) : tail.slice();
    next.push(line);
    this.tails.set(name, next);
  }

  private sendSince() {
    if (!this.server) return;
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
    if (this.rt) {
      if (store.get(this.phaseAtom) !== 'open') return;
      const server = this.server;
      rtFill(Object.fromEntries(Object.entries(since).map(([channel, id]) => [chatTopicOf(`${server}/${channel}`), id])));
      return;
    }
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const frame = { type: 'since', since };
    record(`/chat/${this.key}`, 'out', frame);
    ws.send(JSON.stringify(frame));
  }

  reface(name: string, avatar: number | null) {
    const wear = (lines: ChatLine[]) => lines.map((line) => (line.from === name && (line.verified || line.streamer) ? { ...line, avatar } : line));
    store.set(this.linesAtom, wear(store.get(this.linesAtom)));
    const results = store.get(this.resultsAtom);
    if (results) store.set(this.resultsAtom, wear(results));
    if (this.savedTail) this.savedTail = wear(this.savedTail);
    for (const [key, tail] of this.tails) this.tails.set(key, wear(tail));
  }

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
  }

  setFollowing(on: boolean) {
    this.following = on;
  }

  noteScroll(scrollTop: number) {
    if (scrollTop >= 48) this.olderPaused = false;
  }

  takeScrollPlan(): ScrollPlan {
    const plan = this.scrollPlan;
    this.scrollPlan = null;
    return plan;
  }

  fillShort() {
    if (this.server) void this.loadOlder();
  }

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

  async openLine(id: string, inChannel?: string, missing?: string): Promise<boolean> {
    if (inChannel !== undefined && this.server && inChannel !== this.channel) this.showChannel(inChannel);
    const name = this.httpRoom();
    if (!name) return false;
    if (store.get(this.linesAtom).some((l) => l.id === id)) {
      this.scrollPlan = { id };
      store.set(this.scrollAtom, store.get(this.scrollAtom) + 1);
      return true;
    }
    try {
      const lines = await chatGet(`/chat/${chatPath(name)}/around/${encodeURIComponent(id)}`);
      if (this.httpRoom() !== name) return false;
      if (!lines.some((l) => l.id === id)) {
        this.showNotice(missing ?? 'could not open that line');
        return false;
      }
      if (!this.pinned) this.savedTail = store.get(this.linesAtom).slice();
      this.pinned = true;
      this.following = false;
      store.set(this.pinnedAtom, true);
      this.scrollPlan = { id };
      store.set(this.linesAtom, lines);
      return true;
    } catch (err) {
      this.showNotice(missing ?? (err instanceof Error ? err.message : 'could not open that line'));
      return false;
    }
  }

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

  private toLatest() {
    if (this.pinned) {
      this.backToLatest();
      return;
    }
    this.following = true;
    this.scrollPlan = 'bottom';
    store.set(this.scrollAtom, store.get(this.scrollAtom) + 1);
  }

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

export function reconnectChat() {
  if (rtOn) rtIdentify();
  for (const room of rooms.values()) room.reconnect();
}

export function refaceLines(name: string, avatar: number | null) {
  for (const room of rooms.values()) room.reface(name, avatar);
}

export function serverChat(server: string): ChatRoom {
  return chatRoomFor(server, true);
}

export function findServerChat(server: string): ChatRoom | undefined {
  return rooms.get(chatRoomKey(server, true));
}

export async function searchRoom(raw: string) {
  if (shownServer) await rooms.get(shownServer)?.search(raw);
}

export async function showSpeaker(speaker: string, key: string) {
  await rooms.get(key)?.showSpeaker(speaker);
}

export { fromWire } from '@/infra/chat-wire';

export async function loadChannelPins(server: string, channel: string): Promise<PinnedLine[]> {
  const { pins } = await api.channelPins(server, channel);
  return pins.map(fromWire);
}

function samePictures(sent: string[], back: string[]): boolean {
  if (sent.length === back.length) return sent.every((id, i) => id === back[i]);
  return sent.length > 1 && back.length === 1 && back[0] === sent[0];
}

function idParts(id: string): [number, number] {
  const [ms, seq] = id.split('-');
  return [Number(ms) || 0, Number(seq) || 0];
}

function compareIds(a: string, b: string): number {
  const [ams, aseq] = idParts(a);
  const [bms, bseq] = idParts(b);
  return ams === bms ? aseq - bseq : ams - bms;
}

function mergeLines(have: ChatLine[], more: ChatLine[]): ChatLine[] {
  if (more.length === 0) return have;
  const byId = new Map<string, ChatLine>();
  for (const line of have) byId.set(line.id, line);
  for (const line of more) byId.set(line.id, line);
  const all = [...byId.values()].sort((a, b) => compareIds(a.id, b.id));
  return all.length > KEEP_LINES ? all.slice(all.length - KEEP_LINES) : all;
}

function chatGet(path: string): Promise<ChatLine[]> {
  return linesOf(fetch(path, { cache: 'no-store' }));
}

async function linesOf(response: Promise<Response>): Promise<ChatLine[]> {
  const res = await response;
  let data: { lines?: ChatLine[]; error?: string } | null = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) throw new Error(data?.error || `http ${res.status}`);
  return (data?.lines ?? []).map(fromWire);
}

function retryAfter(tries: number): number {
  const base = Math.min(RETRY_CAP_MS, RETRY_FIRST_MS * 2 ** tries);
  return Math.round(base + Math.random() * base * 0.5);
}

function quoteOf(line: ChatLine): ChatReply {
  return {
    id: line.id,
    from: line.from,
    text: [...line.text].slice(0, 120).join(''),
    streamer: line.streamer,
    verified: line.verified,
    avatar: line.avatar,
    images: line.images.length,
    video: Boolean(line.video),
    audio: Boolean(line.audio)
  };
}

function sameOwner(a: Owner | null, b: Owner | null): boolean {
  return (a === null && b === null) || (a !== null && b !== null && a.session === b.session && a.token === b.token);
}
