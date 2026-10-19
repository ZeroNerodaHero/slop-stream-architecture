/**
 * The video server speaks one websocket at /ws. One message each way:
 *   we send   {"role":"publish"|"watch","name":"...","sdp":"<offer>"}
 *             (a publisher adds the go-live "session" and "token"; video checks them with the api)
 *   we get    {"sdp":"<answer>"}  or  {"error":"..."}
 *   later     {"event":"ended"}  (watchers, when the publisher leaves)
 * The socket stays open for the whole session. Closing it hangs up.
 */

export type RelayRole = 'publish' | 'watch';

interface RelayReply {
  sdp?: string;
  error?: string;
  event?: string;
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
}

/**
 * Open the socket, send the offer, apply the answer. Resolves with the open socket.
 * Rejects with Error(text) on {"error"}, socket trouble, timeout, or abort.
 */
export function connectRelay({ role, name, pc, session, token, url = '/ws', timeoutMs = 15000, signal }: ConnectRelayOptions): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(relayUrl(url));
    let done = false;

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
      ws.send(JSON.stringify({ role, name, sdp: pc.localDescription?.sdp ?? '', session, token }));
    };
    ws.onerror = () => fail(new Error('socket error'));
    ws.onclose = () => fail(new Error('socket closed'));
    ws.onmessage = async (e) => {
      if (done) return;
      const msg = parseRelayMessage(e.data);
      if (!msg) {
        fail(new Error('bad reply'));
        return;
      }
      if (msg.error) {
        fail(new Error(msg.error));
        return;
      }
      if (!msg.sdp) return;
      try {
        await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      if (done) return;
      done = true;
      clearTimeout(timer);
      ws.onopen = ws.onerror = ws.onclose = ws.onmessage = null;
      resolve(ws);
    };
  });
}
