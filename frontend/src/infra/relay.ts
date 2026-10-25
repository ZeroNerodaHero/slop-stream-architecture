/**
 * The video server speaks one websocket at /ws. One message each way to set up:
 *   we send   {"role":"publish"|"watch","name":"...","sdp":"<offer>"}
 *             (a publisher adds the go-live "session" and "token"; video checks them with the api)
 *   we get    {"sdp":"<answer>"}  or  {"error":"..."}
 * The socket stays open for the whole session. Closing it hangs up. On the open socket:
 *   a publisher sends  {"slots":[{"slot":0,"kind":"camera"},{"slot":1,"kind":"screen","label":"screen"}]}
 *                      whenever what it shows changes: its video slots that are live, see `SlotInfo`
 *   a watcher gets     {"event":"slots","slots":[...]}  right after the answer and on every change
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

export interface RelayReply {
  sdp?: string;
  error?: string;
  event?: string;
  slots?: SlotInfo[];
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
export function connectRelay({ role, name, pc, session, token, url = '/ws', timeoutMs = 15000, signal, onMessage }: ConnectRelayOptions): Promise<WebSocket> {
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
      const setup = { role, name, sdp: pc.localDescription?.sdp ?? '', session, token };
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
