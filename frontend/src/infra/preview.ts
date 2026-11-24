import { atom } from 'jotai';

import { connectRelay, type RelayReply, waitForIceGathering } from '@/infra/relay';
import { store } from '@/infra/store';

export const previewStreamsAtom = atom<Readonly<Record<string, MediaStream>>>({});

const RETRY_MS = 5000;
const RETRY_CAP_MS = 60_000;
const TRANSPORT_ERRORS = new Set(['socket error', 'socket closed', 'server did not answer', 'cancelled', 'bad reply']);

interface Session {
  pc: RTCPeerConnection;
  ws: WebSocket | null;
  stream: MediaStream;
  closed: boolean;
}

type Ended = 'refused' | 'dropped';

const sessions = new Map<string, Session>();
const retries = new Map<string, number>();
const backoff = new Map<string, number>();
let wanted = new Set<string>();
let pageWants: readonly string[] = [];
let popupWants: string | null = null;

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

export function setHomePreviews(names: readonly string[]) {
  pageWants = names;
  want();
}

export function setPopupPreview(name: string | null) {
  popupWants = name;
  want();
}

function want() {
  const next = new Set(pageWants);
  if (popupWants !== null) next.add(popupWants);
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
  if (!wanted.has(name) || sessions.has(name) || document.hidden) return;
  const pc = new RTCPeerConnection();
  const stream = new MediaStream();
  const session: Session = { pc, ws: null, stream, closed: false };
  sessions.set(name, session);
  pc.addTransceiver('video', { direction: 'recvonly' });
  pc.ontrack = (event) => {
    if (session.closed || event.track.kind !== 'video') return;
    if (!stream.getVideoTracks().includes(event.track)) stream.addTrack(event.track);
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
    session.ws.onclose = () => again(name, session, 'dropped');
  } catch (err) {
    const refused = err instanceof Error && !TRANSPORT_ERRORS.has(err.message);
    if (!session.closed) again(name, session, refused ? 'refused' : 'dropped');
  }
}

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
