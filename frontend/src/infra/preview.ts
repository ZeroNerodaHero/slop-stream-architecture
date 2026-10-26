/**
 * Muted camera previews for the home page, beside the one watched stream.
 *
 * The watch page and the corner player share one connection (`watch-atoms`). These are
 * their own peers, so a card playing on home does not hang up a stream in the corner.
 * Each one asks for a single video section and no audio: video gives that watcher the
 * camera, which is the 720 picture the streamer sends. There is no smaller encode.
 * Each goes to video as `preview: true`, so it is not a viewer and spends none of this
 * address's watcher share (relay.ts); a hidden tab holds none at all.
 */

import { atom } from 'jotai';

import { connectRelay, type RelayReply, waitForIceGathering } from '@/infra/relay';
import { store } from '@/infra/store';

/** Camera streams that are actually playing, by name. Absent until the first frame's track arrives. */
export const previewStreamsAtom = atom<Readonly<Record<string, MediaStream>>>({});

/** The first wait after a connection dropped. It doubles on every drop in a row, until a track arrives. */
const RETRY_MS = 5000;
/** The longest wait between attempts, and the only one after video refused the stream. */
const RETRY_CAP_MS = 60_000;
/** What `connectRelay` rejects with on its own (relay.ts). Any other text is video's `{"error":...}`, sent before the answer. */
const TRANSPORT_ERRORS = new Set(['socket error', 'socket closed', 'server did not answer', 'cancelled', 'bad reply']);

interface Session {
  pc: RTCPeerConnection;
  ws: WebSocket | null;
  stream: MediaStream;
  closed: boolean;
}

/**
 * Why a session ended on its own. `refused` is video's `{"error":...}`: it looked at the request
 * and said no (too many watchers from this address, say), and asking again at once asks the same
 * question at the price of a whole handshake. `dropped` is the socket or the peer going away,
 * which a new attempt can mend.
 */
type Ended = 'refused' | 'dropped';

const sessions = new Map<string, Session>();
const retries = new Map<string, number>();
/** The next wait after a drop, per name. Absent is the first. */
const backoff = new Map<string, number>();
let wanted = new Set<string>();

function publish(name: string, stream: MediaStream | null) {
  const current = store.get(previewStreamsAtom);
  if (stream) {
    if (current[name] === stream) return;
    store.set(previewStreamsAtom, { ...current, [name]: stream });
    return;
  }
  if (!(name in current)) return;
  const next = { ...current };
  delete next[name];
  store.set(previewStreamsAtom, next);
}

/**
 * The cameras home should be playing: the two newest, plus the card under the pointer.
 * A name that stays in the set keeps its connection. Anything else is hung up.
 */
export function setHomePreviews(names: readonly string[]) {
  const next = new Set(names);
  wanted = next;
  for (const name of sessions.keys()) {
    if (!next.has(name)) stop(name);
  }
  for (const name of retries.keys()) {
    if (!next.has(name)) stop(name);
  }
  for (const name of next) {
    if (!sessions.has(name) && !retries.has(name)) void start(name);
  }
}

/** The name is not wanted any more: hang up, and forget the retry, so wanting it again starts fresh. */
function stop(name: string) {
  const retry = retries.get(name);
  if (retry !== undefined) {
    clearTimeout(retry);
    retries.delete(name);
  }
  backoff.delete(name);
  const session = sessions.get(name);
  if (session) hangUp(name, session);
}

function hangUp(name: string, session: Session) {
  session.closed = true;
  session.ws?.close();
  session.pc.close();
  sessions.delete(name);
  publish(name, null);
}

function again(name: string, session: Session, ended: Ended) {
  if (session.closed || sessions.get(name) !== session) return;
  hangUp(name, session);
  if (!wanted.has(name) || retries.has(name)) return;
  let wait = RETRY_CAP_MS;
  if (ended === 'dropped') {
    wait = backoff.get(name) ?? RETRY_MS;
    backoff.set(name, Math.min(wait * 2, RETRY_CAP_MS));
  }
  retries.set(
    name,
    window.setTimeout(() => {
      retries.delete(name);
      if (wanted.has(name) && !sessions.has(name)) void start(name);
    }, wait)
  );
}

async function start(name: string) {
  // a hidden tab starts nothing: the visibility listener below starts the wanted names when it shows
  if (!wanted.has(name) || sessions.has(name) || document.hidden) return;
  const pc = new RTCPeerConnection();
  const stream = new MediaStream();
  const session: Session = { pc, ws: null, stream, closed: false };
  sessions.set(name, session);
  // one video, no audio: the camera, and nothing to unmute on a card
  pc.addTransceiver('video', { direction: 'recvonly' });
  pc.ontrack = (event) => {
    if (session.closed || event.track.kind !== 'video') return;
    if (!stream.getVideoTracks().includes(event.track)) stream.addTrack(event.track);
    // the connection works: a drop from here on is tried again soon, not where the last run's doubling left off
    backoff.delete(name);
    publish(name, stream);
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') again(name, session, 'dropped');
  };
  const onMessage = (msg: RelayReply) => {
    if (msg.error) again(name, session, 'refused');
    else if (msg.event === 'ended') again(name, session, 'dropped');
  };
  try {
    await pc.setLocalDescription(await pc.createOffer());
    await waitForIceGathering(pc, 1000);
    if (session.closed || !wanted.has(name)) {
      if (!session.closed) stop(name);
      return;
    }
    session.ws = await connectRelay({ role: 'watch', name, pc, preview: true, onMessage });
    if (session.closed || !wanted.has(name)) {
      session.ws.close();
      if (!session.closed) stop(name);
      return;
    }
    // a close with no error frame before it: the socket went, or video is gone
    session.ws.onclose = () => again(name, session, 'dropped');
  } catch (err) {
    // before the answer, video's refusal is the rejection's text; relay.ts's own words are the transport
    const refused = err instanceof Error && !TRANSPORT_ERRORS.has(err.message);
    if (!session.closed) again(name, session, refused ? 'refused' : 'dropped');
  }
}

// a hidden tab holds no previews: nobody sees them, and each one is a peer video keeps
// for this address. `wanted` stays as it is, so the tab showing again starts them over.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    for (const name of sessions.keys()) stop(name);
    for (const name of retries.keys()) stop(name);
    return;
  }
  for (const name of wanted) {
    if (!sessions.has(name) && !retries.has(name)) void start(name);
  }
});
