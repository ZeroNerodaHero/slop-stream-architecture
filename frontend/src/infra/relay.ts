/**
 * The video server speaks one websocket at /ws. One message each way to set up:
 *   we send   {"role":"publish"|"watch","name":"...","sdp":"<offer>"}
 *             (a publisher adds the go-live "session" and "token"; video checks them with the api.
 *              home's muted camera previews add "preview":true: video serves them like watchers but
 *              counts none as a viewer and caps them apart, 12 per address in all, past which it
 *              answers "too many previews from your address")
 *   we get    {"sdp":"<answer>"}  or  {"error":"..."}
 * The socket stays open for the whole session. Closing it hangs up. On the open socket:
 *   a publisher sends  {"slots":[{"slot":0,"kind":"camera"},{"slot":1,"kind":"screen","label":"screen"}],
 *                       "scene":{"layers":[{"id":"s1","kind":"screen","slot":1,"x":0,"y":0,"w":1,"h":1},
 *                                          {"id":"cam","kind":"camera","slot":0,"x":0.73,"y":0.714,"w":0.25,"h":0.25}]}}
 *                      whenever what it shows changes: its video slots that are live, see `SlotInfo`
 *                      (slot 0 is named only while the camera is on: a mic-only stream leaves it
 *                      out and its section quiet), and how its frame is laid out, see `Scene`
 *   a watcher gets     {"event":"slots","slots":[...],"scene":{...}}  right after the answer and on every change
 *                      (no `scene` from a publisher that never sent one: the dummy, an older page)
 *                      {"event":"ended"}  when the publisher leaves
 *   both get           {"event":"viewers","viewers":3}  how many addresses are receiving it, on change, at most 1/s
 *
 * A publisher's offer carries every video section it may ever send on: the camera and
 * SCREEN_SLOTS empty ones for screens, filled and emptied later with `replaceTrack`, which
 * renegotiates nothing. A watcher's offer asks for as many, so a screen shared mid-stream
 * reaches everyone already watching. Which slot is what travels in the slots frames: packets
 * alone cannot say (an empty section still gets padding, and a muted track never says so).
 */

import { record } from '@/infra/atoms/inspector-atoms';

export type RelayRole = 'publish' | 'watch';

/** Screens a publisher can share beside the camera, at once. Both sides offer this many video sections for them. */
export const SCREEN_SLOTS = 3;

/**
 * One live video slot of a publisher, as it tells the watchers. `slot` counts the video
 * sections of its offer from 0: the camera is 0, the screens are 1 to SCREEN_SLOTS.
 */
export interface SlotInfo {
  slot: number;
  /** `camera`, `screen`; anything else is shown as is. */
  kind: string;
  label?: string;
}

/**
 * A box in the frame: its top left corner and its size, each a fraction of the 16:9 frame in
 * 0..1, to thousandths. Fractions, so the go live page's preview and every watcher's player
 * draw the same picture at any size.
 */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
/** How a video fills its box: `cover` crops to fill it (a face), `contain` shows the whole picture (a screen). Absent: by kind, see `fitOf`. */
export type Fit = 'cover' | 'contain';
/**
 * One layer of the streamer's frame (docs/screen.md): one of their video slots, a picture
 * they uploaded (an api asset, by id: the watcher builds the url under the stream's name), or
 * their avatar (the profile picture under the stream's name, else the letter the name makes;
 * every player draws it from the name and moves it with the sound it is receiving, so it
 * carries nothing but its box). `id` is the streamer's, short, unique in the scene; it keys the
 * boxes on both sides.
 */
export type VideoLayer = Box & { id: string; kind: 'camera' | 'screen'; slot: number; fit?: Fit };
export type ImageLayer = Box & { id: string; kind: 'image'; asset: number };
export type AvatarLayer = Box & { id: string; kind: 'avatar' };
export type Layer = VideoLayer | ImageLayer | AvatarLayer;
/** The frame, bottom layer first: the array order is the z-order. A live video slot in no layer is a tile beside the picture. */
export interface Scene {
  layers: Layer[];
}

/** Layers one scene may hold; video checks the same. */
export const MAX_LAYERS = 16;
/** A layer is at least this much of the frame wide and tall: smaller is a dot nobody can see or take hold of. */
export const LAYER_MIN = 0.05;
/** A layer's id: short, plain. */
const ID_RE = /^[a-z0-9_-]{1,16}$/i;

export const isVideoLayer = (layer: Layer): layer is VideoLayer => layer.kind === 'camera' || layer.kind === 'screen';
/** How a video layer fills its box when it does not say: a face fills, a screen is shown whole (text must never be cut). */
export const fitOf = (layer: VideoLayer): Fit => layer.fit ?? (layer.kind === 'camera' ? 'cover' : 'contain');

export interface RelayReply {
  sdp?: string;
  error?: string;
  event?: string;
  slots?: SlotInfo[];
  /** With `event: 'slots'`: the streamer's `Scene`, when it sent one. */
  scene?: unknown;
  /** With `event: 'viewers'`: different addresses receiving the stream right now. docs/viewers.md */
  viewers?: number;
}

/** The count of a `viewers` event, or null when the frame has none that makes sense. */
export function viewersOf(msg: RelayReply): number | null {
  return typeof msg.viewers === 'number' && Number.isInteger(msg.viewers) && msg.viewers >= 0 ? msg.viewers : null;
}

/** The slots of a `slots` event, kept to the well-formed entries. `null` when the message has none. */
export function slotsOf(msg: RelayReply): SlotInfo[] | null {
  if (!Array.isArray(msg.slots)) return null;
  return msg.slots.filter(
    (s): s is SlotInfo =>
      typeof s === 'object' &&
      s !== null &&
      Number.isInteger(s.slot) &&
      s.slot >= 0 &&
      typeof s.kind === 'string' &&
      (s.label === undefined || typeof s.label === 'string')
  );
}

const isFraction = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;

export const thousandth = (v: number) => Math.round(v * 1000) / 1000;

/**
 * A box kept inside the frame, to thousandths (so a drag does not send a float's whole tail):
 * the size between `LAYER_MIN` and the frame, the corner so the whole box fits.
 */
export function clampBox(box: Box): Box {
  const w = thousandth(Math.min(1, Math.max(LAYER_MIN, box.w)));
  const h = thousandth(Math.min(1, Math.max(LAYER_MIN, box.h)));
  return { x: thousandth(Math.min(1 - w, Math.max(0, box.x))), y: thousandth(Math.min(1 - h, Math.max(0, box.y))), w, h };
}

/** One layer from anything, kept inside the frame; `null` when it is not one. */
function validLayer(raw: unknown): Layer | null {
  if (!raw || typeof raw !== 'object') return null;
  const l = raw as Record<string, unknown>;
  if (typeof l.id !== 'string' || !ID_RE.test(l.id) || !isFraction(l.x) || !isFraction(l.y) || !isFraction(l.w) || !isFraction(l.h)) return null;
  const box = clampBox({ x: l.x, y: l.y, w: l.w, h: l.h });
  if (l.kind === 'camera' || l.kind === 'screen') {
    if (!Number.isInteger(l.slot) || (l.slot as number) < 0) return null;
    const fit = l.fit === 'cover' || l.fit === 'contain' ? l.fit : undefined;
    return { id: l.id, kind: l.kind, slot: l.slot as number, ...(fit && { fit }), ...box };
  }
  if (l.kind === 'image') {
    return Number.isInteger(l.asset) && (l.asset as number) > 0 ? { id: l.id, kind: 'image', asset: l.asset as number, ...box } : null;
  }
  if (l.kind === 'avatar') return { id: l.id, kind: 'avatar', ...box };
  return null;
}

/**
 * A `Scene` from anything (a frame's `scene`, localstorage): every layer kept inside the frame
 * and clamped to thousandths, a layer that is not one dropped and the rest standing (the way
 * `slotsOf` drops a bad slot), the ids made unique (a second use of one is dropped); `null`
 * when it is not a scene at all.
 */
export function validScene(raw: unknown): Scene | null {
  if (!raw || typeof raw !== 'object') return null;
  const { layers } = raw as { layers?: unknown };
  if (!Array.isArray(layers)) return null;
  const seen = new Set<string>();
  const kept: Layer[] = [];
  for (const entry of layers.slice(0, MAX_LAYERS)) {
    const layer = validLayer(entry);
    if (!layer || seen.has(layer.id)) continue;
    seen.add(layer.id);
    kept.push(layer);
  }
  return { layers: kept };
}

/** The scene of a `slots` event, or `null` when the frame carries none that makes sense. */
export function sceneOf(msg: RelayReply): Scene | null {
  return validScene(msg.scene);
}

/**
 * Resolve when ICE gathering is done, or after capMs. The server advertises its own public
 * ip, so our candidates barely matter. Give the browser a moment for free ones anyway.
 */
export function waitForIceGathering(pc: RTCPeerConnection, capMs = 1000): Promise<void> {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', onChange);
      resolve();
    };
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') finish();
    };
    const timer = setTimeout(finish, capMs);
    pc.addEventListener('icegatheringstatechange', onChange);
  });
}

/** '/ws' -> 'wss://<this host>/ws' (or ws:// on the http dev server). */
export function relayUrl(path = '/ws'): string {
  const u = new URL(path, location.href);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return u.href;
}

export function parseRelayMessage(data: unknown): RelayReply | null {
  if (typeof data !== 'string') return null;
  try {
    return JSON.parse(data) as RelayReply;
  } catch {
    return null;
  }
}

interface ConnectRelayOptions {
  role: RelayRole;
  name: string;
  pc: RTCPeerConnection;
  /** The api's go-live grant. Publishers only; without it video answers "not your stream". */
  session?: number;
  token?: number;
  /** One of home's muted camera previews. Watchers only: video holds it apart from the viewers and their caps. */
  preview?: boolean;
  url?: string;
  timeoutMs?: number;
  /** Aborting rejects with "cancelled" (the user pressed stop while we were connecting). */
  signal?: AbortSignal;
  /**
   * The frames after the answer (`{"event":...}`). Installed on the socket before it is handed
   * back, so nothing is lost between the answer and a handler set afterwards: the first slots
   * event follows the answer at once, while `setRemoteDescription` is still being awaited here.
   * Frames that came in that window are delivered first, in order, once the caller has the socket.
   */
  onMessage?: (msg: RelayReply) => void;
}

/**
 * Open the socket, send the offer, apply the answer. Resolves with the open socket.
 * Rejects with Error(text) on {"error"}, socket trouble, timeout, or abort.
 */
export function connectRelay({ role, name, pc, session, token, preview, url = '/ws', timeoutMs = 15000, signal, onMessage }: ConnectRelayOptions): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(relayUrl(url));
    let done = false;
    const pending: RelayReply[] = [];

    const fail = (err: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ws.close();
      reject(err);
    };
    const timer = setTimeout(() => fail(new Error('server did not answer')), timeoutMs);
    if (signal) {
      if (signal.aborted) {
        fail(new Error('cancelled'));
        return;
      }
      signal.addEventListener('abort', () => fail(new Error('cancelled')), { once: true });
    }

    ws.onopen = () => {
      // JSON.stringify drops the undefined ones, so a watcher's frame has no session or token
      // and only a preview's has preview
      const setup = { role, name, sdp: pc.localDescription?.sdp ?? '', session, token, preview };
      record(url, 'out', setup); // the token is taken out, the sdp clipped, before it is kept
      ws.send(JSON.stringify(setup));
    };
    ws.onerror = () => fail(new Error('socket error'));
    ws.onclose = () => fail(new Error('socket closed'));
    ws.onmessage = async (e) => {
      if (done) return;
      const msg = parseRelayMessage(e.data);
      if (msg) record(url, 'in', msg);
      if (!msg) {
        fail(new Error('bad reply'));
        return;
      }
      if (msg.error) {
        fail(new Error(msg.error));
        return;
      }
      if (!msg.sdp) {
        if (onMessage) pending.push(msg);
        return;
      }
      try {
        await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      if (done) return;
      done = true;
      clearTimeout(timer);
      ws.onopen = ws.onerror = ws.onclose = null;
      ws.onmessage = onMessage
        ? (ev) => {
            const later = parseRelayMessage(ev.data);
            if (later) {
              record(url, 'in', later);
              onMessage(later);
            }
          }
        : null;
      resolve(ws);
      // after the caller's own continuation (it takes the socket and sets onclose first)
      if (onMessage && pending.length) queueMicrotask(() => pending.forEach(onMessage));
    };
  });
}
