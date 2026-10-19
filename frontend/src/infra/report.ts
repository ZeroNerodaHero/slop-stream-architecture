/**
 * The pages report their own failures to the api: one json line to POST /api/errors, same
 * origin, through sendBeacon so it still goes out of a page that is dying. The api keeps
 * them in the debug database and /admin shows them. See docs/debugging.md.
 *
 * Nothing in here may break the page: every call swallows its own errors, the same message
 * is not sent twice inside 30s, and each kind has a budget per page load (20, `api` 5),
 * then that kind goes quiet. A render loop, or an api that is down for an hour, otherwise
 * produces thousands and crowds out the one crash that mattered.
 */

export type ReportKind = 'crash' | 'error' | 'rejection' | 'soft' | 'api';

export type Extra = Record<string, string | number | boolean | null | undefined>;

interface ReportOptions extends Extra {
  stream?: string;
  phase?: string;
  /** Appended after the error's own stack (a crash passes react's component stack along). */
  componentStack?: string;
}

const ENDPOINT = '/api/errors';
const DEDUPE_MS = 30_000;
const MAX_PER_LOAD: Record<ReportKind, number> = { crash: 20, error: 20, rejection: 20, soft: 20, api: 5 };
const MAX_MESSAGE = 500;
const MAX_STACK = 8000;
const STATS_WAIT_MS = 300;

const lastSent = new Map<string, number>();
const sent: Record<ReportKind, number> = { crash: 0, error: 0, rejection: 0, soft: 0, api: 0 };

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}

function stackOf(err: unknown): string | undefined {
  return err instanceof Error ? err.stack : undefined;
}

/** sendBeacon queues it even when the page is going away. A string body goes as text/plain. */
function send(body: string): void {
  if (typeof navigator.sendBeacon === 'function' && navigator.sendBeacon(ENDPOINT, body)) return;
  fetch(ENDPOINT, { method: 'POST', body, keepalive: true, headers: { 'content-type': 'text/plain' } }).catch(() => undefined);
}

export function report(kind: ReportKind, err: unknown, options: ReportOptions = {}): void {
  try {
    const message = messageOf(err).slice(0, MAX_MESSAGE);
    if (!message) return;
    const key = `${kind}:${message}`;
    const now = Date.now();
    const last = lastSent.get(key);
    if (last !== undefined && now - last < DEDUPE_MS) return;
    if (sent[kind] >= MAX_PER_LOAD[kind]) return;
    lastSent.set(key, now);
    sent[kind] += 1;

    const { stream, phase, componentStack, ...rest } = options;
    const stack = [stackOf(err), componentStack && `component stack:${componentStack}`].filter(Boolean).join('\n\n');
    const extra = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
    send(
      JSON.stringify({
        kind,
        message,
        stack: stack ? stack.slice(0, MAX_STACK) : undefined,
        page: location.pathname,
        stream,
        phase,
        build: __BUILD__,
        ua: navigator.userAgent,
        extra: Object.keys(extra).length ? extra : undefined
      })
    );
  } catch {
    // reporting must never be the thing that breaks
  }
}

/** The throws react never sees (handlers, timers) and the promises nobody caught. Call once. */
export function installReporting(): void {
  addEventListener('error', (e) => {
    // not in capture mode, so a stylesheet or image that failed to load does not land here
    if (!(e instanceof ErrorEvent)) return;
    report('error', e.error ?? e.message, { source: e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : undefined });
  });
  addEventListener('unhandledrejection', (e) => report('rejection', e.reason));
}

type Stat = Record<string, unknown>;

function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/**
 * What the peer connection looked like when it failed. The sync states always; the selected
 * candidate pair from getStats() when it answers inside 300ms. Bytes in and out, the rtt and
 * the candidate types are what tell "udp blocked" from "video is dead".
 */
export async function peerSnapshot(pc: RTCPeerConnection | null): Promise<Extra> {
  if (!pc) return {};
  const snap: Extra = {
    connection: pc.connectionState,
    ice: pc.iceConnectionState,
    gathering: pc.iceGatheringState,
    signaling: pc.signalingState
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const stats = await Promise.race([
      pc.getStats(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), STATS_WAIT_MS);
      })
    ]);
    if (!stats) return snap;
    const all = new Map<string, Stat>();
    let selectedId: string | undefined;
    let pairs = 0;
    stats.forEach((s: Stat) => {
      all.set(String(s.id), s);
      if (s.type === 'transport' && str(s.selectedCandidatePairId)) selectedId = str(s.selectedCandidatePairId);
      if (s.type === 'candidate-pair') pairs += 1;
      if (s.type === 'inbound-rtp') {
        snap[`${str(s.kind) ?? 'rtp'}In`] = num(s.packetsReceived);
        if (s.kind === 'video') snap.framesDecoded = num(s.framesDecoded);
      }
      if (s.type === 'outbound-rtp') snap[`${str(s.kind) ?? 'rtp'}Out`] = num(s.packetsSent);
    });
    snap.pairs = pairs;
    const pair =
      (selectedId && all.get(selectedId)) ||
      [...all.values()].find((s) => s.type === 'candidate-pair' && (s.nominated === true || s.state === 'succeeded')) ||
      [...all.values()].find((s) => s.type === 'candidate-pair');
    if (pair) {
      snap.pairState = str(pair.state);
      snap.bytesIn = num(pair.bytesReceived);
      snap.bytesOut = num(pair.bytesSent);
      const rtt = num(pair.currentRoundTripTime);
      snap.rttMs = rtt === undefined ? undefined : Math.round(rtt * 1000);
      const local = all.get(String(pair.localCandidateId));
      const remote = all.get(String(pair.remoteCandidateId));
      snap.local = local && `${str(local.candidateType) ?? '?'}/${str(local.protocol) ?? '?'}`;
      snap.remote = remote && `${str(remote.candidateType) ?? '?'}/${str(remote.protocol) ?? '?'}:${num(remote.port) ?? '?'}`;
    }
  } catch {
    // a closed connection has no stats. the sync states still say plenty
  } finally {
    clearTimeout(timer);
  }
  return snap;
}

/**
 * A watch or publish that ended in `failed`. Call it before the peer connection is closed;
 * it resolves once the stats are read (300ms at most), so the caller can close after that.
 */
export function reportPeerFailure(role: 'watch' | 'publish', stream: string, message: string, pc: RTCPeerConnection | null): Promise<void> {
  return peerSnapshot(pc).then((snap) => report('soft', message, { ...snap, role, stream, phase: 'failed' }));
}
