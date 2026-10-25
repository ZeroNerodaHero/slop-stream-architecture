/**
 * Muted camera previews for the home page, beside the one watched stream.
 *
 * The watch page and the corner player share one connection (`watch-atoms`). These are
 * their own peers, so a card playing on home does not hang up a stream in the corner.
 * Each one asks for a single video section and no audio: video gives that watcher the
 * camera, which is the 720 picture the streamer sends. There is no smaller encode.
 */

import { atom } from 'jotai';

import { connectRelay, type RelayReply, waitForIceGathering } from '@/infra/relay';
import { store } from '@/infra/store';

/** Camera streams that are actually playing, by name. Absent until the first frame's track arrives. */
export const previewStreamsAtom = atom<Readonly<Record<string, MediaStream>>>({});

interface Session {
  pc: RTCPeerConnection;
  ws: WebSocket | null;
  stream: MediaStream;
  closed: boolean;
}

const sessions = new Map<string, Session>();
const retries = new Map<string, number>();
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

function stop(name: string) {
  const retry = retries.get(name);
  if (retry !== undefined) {
    clearTimeout(retry);
    retries.delete(name);
  }
  const session = sessions.get(name);
  if (!session) return;
  session.closed = true;
  session.ws?.close();
  session.pc.close();
  sessions.delete(name);
  publish(name, null);
}

function again(name: string, session: Session) {
  if (session.closed || sessions.get(name) !== session) return;
  stop(name);
  if (!wanted.has(name) || retries.has(name)) return;
  retries.set(
    name,
    window.setTimeout(() => {
      retries.delete(name);
      if (wanted.has(name) && !sessions.has(name)) void start(name);
    }, 5000)
  );
}

async function start(name: string) {
  if (!wanted.has(name) || sessions.has(name)) return;
  const pc = new RTCPeerConnection();
  const stream = new MediaStream();
  const session: Session = { pc, ws: null, stream, closed: false };
  sessions.set(name, session);
  // one video, no audio: the camera, and nothing to unmute on a card
  pc.addTransceiver('video', { direction: 'recvonly' });
  pc.ontrack = (event) => {
    if (session.closed || event.track.kind !== 'video') return;
    if (!stream.getVideoTracks().includes(event.track)) stream.addTrack(event.track);
    publish(name, stream);
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') again(name, session);
  };
  const onMessage = (msg: RelayReply) => {
    if (msg.event === 'ended' || msg.error) again(name, session);
  };
  try {
    await pc.setLocalDescription(await pc.createOffer());
    await waitForIceGathering(pc, 1000);
    if (session.closed || !wanted.has(name)) {
      if (!session.closed) stop(name);
      return;
    }
    session.ws = await connectRelay({ role: 'watch', name, pc, onMessage });
    if (session.closed || !wanted.has(name)) {
      session.ws.close();
      if (!session.closed) stop(name);
      return;
    }
    session.ws.onclose = () => again(name, session);
  } catch {
    if (!session.closed) again(name, session);
  }
}
