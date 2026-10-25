/**
 * How the stream is doing, read from the peer connection once a second. Two pipes, read apart:
 * a watcher measures the copy arriving here (loss, freezes, the picture on screen); a publisher
 * measures the upload to the box (the encoder's limit, the loss the box reports). The box copies
 * one picture, so a watcher's bad link never shows up on the publisher's numbers.
 *
 * The peer connection stays a module handle. `startSampler` is the timer; it writes a snapshot
 * the page renders, and nothing renders from the connection itself.
 */

const SAMPLE_MS = 1000;
/** A sample further apart than this was a hidden tab, not a frozen picture. */
const STALL_DT_MAX = 2.5;
/** Under this for a stretch, with the mic open, is a dead mic rather than a pause in talking. */
const SILENT_LEVEL = 0.005;
const SILENT_SAMPLES = 8;
const HIST = 10;
const SMOOTH = 3;
/** Freezes counted across this long a window. */
const FREEZE_WINDOW_MS = 10_000;

export type QualityWord = 'clear' | 'rough' | 'breaking' | 'sending' | 'upload limited' | 'cpu limited';
type Reason = 'none' | 'cpu' | 'bandwidth' | 'other';
type Stat = Record<string, unknown>;

export interface VideoLine {
  /** Set on the pictures that are not the big one (a shared screen, the camera beside it). */
  label: string | null;
  width: number;
  height: number;
  fps: number;
  /** Bits per second over the last few samples. */
  bitrate: number;
  lossPct: number | null;
  nackPerSec: number | null;
  pliPerSec: number | null;
  droppedPerSec: number | null;
  keyframesPerSec: number | null;
  /** This picture's own encoder limit. Null for a watcher, and when the encoder didn't say. */
  reason: Reason | null;
  jitterMs: number | null;
}

export interface AudioLine {
  /** 0..1. Null when the browser didn't report a level. */
  level: number | null;
  bitrate: number;
  lossPct: number | null;
  /** Share of samples the player invented to cover a hole. Watchers only. */
  concealmentPct: number | null;
  muted: boolean;
  /** The mic has sat near zero long enough that it isn't someone pausing. Publishers only. */
  silent: boolean;
}

export interface StreamStats {
  word: QualityWord;
  /** The picture on the big video: the one the watcher is showing, or the publisher's camera. */
  video: VideoLine;
  others: VideoLine[];
  audio: AudioLine | null;
  rttMs: number | null;
  /** Publisher: room the congestion controller says the upload has. Null when it didn't say. */
  availableBps: number | null;
  path: 'direct' | 'relay' | null;
  /** The cap the camera was given. Null for a watcher, and when this line isn't the camera. */
  capBps: number | null;
  /** Why the word says limited. Null when it doesn't, or when the limit is the loss by itself. */
  reason: Reason | null;
}

export interface SamplerSource {
  role: 'watch' | 'publish';
  pc: () => RTCPeerConnection | null;
  /** The big picture's track. The word is about that one; the other live pictures are `others`. */
  videoTrackId: () => string | undefined;
  /** The mic (publisher) or the incoming track (watcher) is muted. No track is not muted. */
  audioMuted: () => boolean;
  capBps: () => number | null;
  labelOf: (trackId: string) => string | undefined;
  write: (stats: StreamStats | null) => void;
}

interface Counters {
  bytes?: number;
  packets?: number;
  packetsLost?: number;
  frames?: number;
  framesDropped?: number;
  nack?: number;
  pli?: number;
  keyframes?: number;
  concealed?: number;
  samples?: number;
  energy?: number;
  duration?: number;
  freezes?: number;
}

interface Memory {
  at: number;
  counters: Map<string, Counters>;
  trackId: string | undefined;
  fps: number[];
  bitrate: number[];
  loss: number[];
  /** Worst encoder reason each sample, so one blip doesn't stick and one good sample doesn't clear it. */
  reasons: Reason[];
  /** Worst loss the box reported, each sample. */
  remoteLoss: number[];
  stall: number;
  silent: number;
  freezes: { t: number; delta: number }[];
}

function emptyMemory(): Memory {
  return {
    at: 0,
    counters: new Map(),
    trackId: undefined,
    fps: [],
    bitrate: [],
    loss: [],
    reasons: [],
    remoteLoss: [],
    stall: 0,
    silent: 0,
    freezes: []
  };
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function delta(now: number | undefined, prev: number | undefined): number | null {
  if (now === undefined || prev === undefined) return null;
  const d = now - prev;
  return d < 0 ? null : d;
}

function perSec(d: number | null, dt: number): number | null {
  if (d === null || dt <= 0) return null;
  return d / dt;
}

function percent(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.min(100, Math.max(0, (part / whole) * 100));
}

function push<T>(values: T[], value: T): void {
  values.push(value);
  if (values.length > HIST) values.shift();
}

function mean(values: readonly number[], n: number): number {
  const slice = values.slice(-n);
  if (slice.length === 0) return 0;
  let sum = 0;
  for (const v of slice) sum += v;
  return sum / slice.length;
}

const REASON_RANK: Record<Reason, number> = { none: 0, other: 1, bandwidth: 2, cpu: 3 };

function reasonOf(value: unknown): Reason | null {
  if (value === 'none' || value === 'cpu' || value === 'bandwidth' || value === 'other') return value;
  return null;
}

function worse(a: Reason, b: Reason): Reason {
  return REASON_RANK[a] >= REASON_RANK[b] ? a : b;
}

function readReport(report: RTCStatsReport): Map<string, Stat> {
  const all = new Map<string, Stat>();
  report.forEach((value, id) => {
    if (value && typeof value === 'object') all.set(id, value as Stat);
  });
  return all;
}

function grab(stat: Stat, direction: 'in' | 'out'): Counters {
  return {
    bytes: num(direction === 'in' ? stat.bytesReceived : stat.bytesSent),
    packets: num(direction === 'in' ? stat.packetsReceived : stat.packetsSent),
    packetsLost: num(stat.packetsLost),
    frames: num(direction === 'in' ? stat.framesDecoded : stat.framesEncoded),
    framesDropped: num(stat.framesDropped),
    nack: num(stat.nackCount),
    pli: num(stat.pliCount),
    keyframes: num(stat.keyFramesEncoded),
    concealed: num(stat.concealedSamples),
    samples: num(stat.totalSamplesReceived),
    energy: num(stat.totalAudioEnergy),
    duration: num(stat.totalSamplesDuration),
    freezes: num(stat.totalFreezesDuration)
  };
}

function collect(all: Map<string, Stat>, direction: 'in' | 'out'): Map<string, Counters> {
  const out = new Map<string, Counters>();
  for (const [id, stat] of all) {
    if (stat.type === 'inbound-rtp' || stat.type === 'outbound-rtp' || stat.type === 'remote-inbound-rtp') out.set(id, grab(stat, direction));
    else if (stat.type === 'media-source') out.set(id, { energy: num(stat.totalAudioEnergy), duration: num(stat.totalSamplesDuration) });
  }
  return out;
}

function trackIdOf(stat: Stat, all: Map<string, Stat>): string | undefined {
  const direct = str(stat.trackIdentifier);
  if (direct) return direct;
  const sourceId = str(stat.mediaSourceId);
  const source = sourceId ? all.get(sourceId) : undefined;
  return source ? str(source.trackIdentifier) : undefined;
}

function selectedPair(all: Map<string, Stat>): Stat | undefined {
  let selectedId: string | undefined;
  let fallback: Stat | undefined;
  for (const stat of all.values()) {
    if (stat.type === 'transport') {
      const id = str(stat.selectedCandidatePairId);
      if (id) selectedId = id;
    }
    if (stat.type === 'candidate-pair' && (stat.nominated === true || stat.state === 'succeeded') && !fallback) fallback = stat;
  }
  return (selectedId ? all.get(selectedId) : undefined) ?? fallback;
}

function pathOf(all: Map<string, Stat>, pair: Stat | undefined): 'direct' | 'relay' | null {
  if (!pair) return null;
  const localId = str(pair.localCandidateId);
  const remoteId = str(pair.remoteCandidateId);
  const local = localId ? str(all.get(localId)?.candidateType) : undefined;
  const remote = remoteId ? str(all.get(remoteId)?.candidateType) : undefined;
  if (local === 'relay' || remote === 'relay') return 'relay';
  if (local || remote) return 'direct';
  return null;
}

interface BuiltVideo {
  id: string;
  trackId: string | undefined;
  line: VideoLine;
  remoteLoss: number | null;
  freezeDelta: number | null;
  frameDelta: number | null;
}

function videoOf(stat: Stat, id: string, all: Map<string, Stat>, prev: Map<string, Counters>, dt: number, direction: 'in' | 'out', remotes: Stat[]): BuiltVideo | null {
  const mediaId = str(stat.mediaSourceId);
  const media = mediaId ? all.get(mediaId) : undefined;
  const width = num(stat.frameWidth) ?? num(media?.width) ?? 0;
  const height = num(stat.frameHeight) ?? num(media?.height) ?? 0;
  if (width <= 0 || height <= 0) return null;
  const old = prev.get(id);
  const bytes = perSec(delta(num(direction === 'in' ? stat.bytesReceived : stat.bytesSent), old?.bytes), dt);
  if (bytes === null) return null;
  const frames = delta(num(direction === 'in' ? stat.framesDecoded : stat.framesEncoded), old?.frames);
  const reportedFps = num(stat.framesPerSecond);
  const fps = reportedFps !== undefined ? reportedFps : frames !== null && dt <= STALL_DT_MAX ? frames / dt : 0;
  const lost = delta(num(stat.packetsLost), old?.packetsLost);
  const received = delta(num(stat.packetsReceived), old?.packets);
  let lossPct: number | null = lost !== null && received !== null ? percent(lost, lost + received) : null;
  let remoteLoss: number | null = null;
  let jitterMs = num(stat.jitter);
  if (direction === 'out') {
    const remote = remotes.find((s) => str(s.localId) === id);
    const remoteOld = remote ? prev.get(str(remote.id) ?? '') : undefined;
    const fraction = remote ? num(remote.fractionLost) : undefined;
    const sent = delta(num(stat.packetsSent), old?.packets);
    const remoteLost = remote ? delta(num(remote.packetsLost), remoteOld?.packetsLost) : null;
    if (fraction !== undefined) remoteLoss = Math.min(100, Math.max(0, fraction * 100));
    else if (remoteLost !== null && sent !== null && sent > 0) remoteLoss = percent(remoteLost, sent);
    lossPct = remoteLoss;
    const remoteJitter = remote ? num(remote.jitter) : undefined;
    if (remoteJitter !== undefined) jitterMs = remoteJitter;
  }
  const reason = direction === 'out' ? reasonOf(stat.qualityLimitationReason) : null;
  return {
    id,
    trackId: trackIdOf(stat, all),
    remoteLoss,
    freezeDelta: delta(num(stat.totalFreezesDuration), old?.freezes),
    frameDelta: frames,
    line: {
      label: null,
      width,
      height,
      fps,
      bitrate: bytes * 8,
      lossPct,
      nackPerSec: perSec(delta(num(stat.nackCount), old?.nack), dt),
      pliPerSec: perSec(delta(num(stat.pliCount), old?.pli), dt),
      droppedPerSec: perSec(delta(num(stat.framesDropped), old?.framesDropped), dt),
      keyframesPerSec: perSec(delta(num(stat.keyFramesEncoded), old?.keyframes), dt),
      reason,
      jitterMs: jitterMs === undefined ? null : jitterMs * 1000
    }
  };
}

function audioLevel(stat: Stat, all: Map<string, Stat>, prev: Map<string, Counters>): number | null {
  const direct = num(stat.audioLevel);
  if (direct !== undefined) return direct;
  const sourceId = str(stat.mediaSourceId);
  const linked = sourceId ? all.get(sourceId) : undefined;
  const media = linked?.type === 'media-source' ? linked : [...all.values()].find((s) => s.type === 'media-source' && s.kind === 'audio');
  if (!media) return null;
  const level = num(media.audioLevel);
  if (level !== undefined) return level;
  const old = prev.get(str(media.id) ?? '');
  const dEnergy = delta(num(media.totalAudioEnergy), old?.energy);
  const dDuration = delta(num(media.totalSamplesDuration), old?.duration);
  if (dEnergy === null || dDuration === null || dDuration <= 0) return null;
  return Math.sqrt(dEnergy / dDuration);
}

function audioOf(
  stat: Stat,
  all: Map<string, Stat>,
  prev: Map<string, Counters>,
  dt: number,
  direction: 'in' | 'out',
  muted: boolean,
  remotes: Stat[]
): AudioLine | null {
  const id = str(stat.id) ?? '';
  const old = prev.get(id);
  const bytes = perSec(delta(num(direction === 'in' ? stat.bytesReceived : stat.bytesSent), old?.bytes), dt);
  const packets = num(direction === 'in' ? stat.packetsReceived : stat.packetsSent) ?? 0;
  const level = audioLevel(stat, all, prev);
  if (bytes === null && packets === 0 && level === null) return null;
  const lost = delta(num(stat.packetsLost), old?.packetsLost);
  const received = delta(num(stat.packetsReceived), old?.packets);
  const concealed = delta(num(stat.concealedSamples), old?.concealed);
  const samples = delta(num(stat.totalSamplesReceived), old?.samples);
  let concealmentPct: number | null = null;
  if (concealed !== null && samples !== null && concealed + samples > 0) concealmentPct = percent(concealed, concealed + samples);
  let lossPct: number | null = direction === 'in' && lost !== null && received !== null ? percent(lost, lost + received) : null;
  if (direction === 'out') {
    const remote = remotes.find((s) => s.kind === 'audio' && str(s.localId) === id);
    const fraction = remote ? num(remote.fractionLost) : undefined;
    if (fraction !== undefined) lossPct = Math.min(100, Math.max(0, fraction * 100));
  }
  return {
    level,
    bitrate: (bytes ?? 0) * 8,
    lossPct,
    concealmentPct: direction === 'in' ? concealmentPct : null,
    muted,
    silent: false
  };
}

/**
 * Watcher: a stalled picture, heavy loss, or a run of freezes is breaking; a little loss or a
 * picture well under what it just was is rough. Publisher: the encoder saying cpu or bandwidth,
 * or the box losing the upload, and it has to hold for more than one sample.
 */
function watchWord(m: Memory, freezeSec: number): QualityWord {
  const loss = mean(m.loss, SMOOTH);
  const fps = mean(m.fps, SMOOTH);
  const peakFps = m.fps.reduce((hi, v) => Math.max(hi, v), 0);
  const bitrate = mean(m.bitrate, SMOOTH);
  const peakBitrate = m.bitrate.reduce((hi, v) => Math.max(hi, v), 0);
  if (m.stall >= 1 || loss > 5 || freezeSec > 2) return 'breaking';
  const fpsDrop = m.fps.length >= SMOOTH && peakFps >= 8 && fps < peakFps * 0.7;
  const bitrateDrop = m.bitrate.length >= SMOOTH && peakBitrate >= 80_000 && bitrate < peakBitrate * 0.4;
  if (loss > 1 || fpsDrop || bitrateDrop) return 'rough';
  return 'clear';
}

function publishWord(m: Memory): { word: QualityWord; reason: Reason | null } {
  const reasons = m.reasons.slice(-SMOOTH);
  const recentLoss = m.remoteLoss.slice(-SMOOTH);
  const lossNow = recentLoss[recentLoss.length - 1] ?? 0;
  const lossMean = mean(recentLoss, SMOOTH);
  if (reasons.includes('cpu')) return { word: 'cpu limited', reason: 'cpu' };
  if (reasons.includes('bandwidth') || (recentLoss.length >= 2 && lossNow > 3 && lossMean > 3)) {
    return { word: 'upload limited', reason: reasons.includes('bandwidth') ? 'bandwidth' : null };
  }
  return { word: 'sending', reason: null };
}

function nextStats(m: Memory, report: RTCStatsReport, source: SamplerSource): StreamStats | undefined {
  const now = performance.now();
  const all = readReport(report);
  const direction = source.role === 'watch' ? 'in' : 'out';
  const rtpType = source.role === 'watch' ? 'inbound-rtp' : 'outbound-rtp';
  const counters = collect(all, direction);
  const dt = m.at === 0 ? 0 : (now - m.at) / 1000;
  // The first sample has no rate yet. A hidden tab, or a gap from a throttled timer, is not a stall
  // and must not land in the averages: keep the counters current and leave the last snapshot up.
  if (m.at === 0 || dt < 0.2 || dt > STALL_DT_MAX || document.hidden) {
    m.at = now;
    m.counters = counters;
    if (document.hidden || dt > STALL_DT_MAX) m.stall = 0;
    return undefined;
  }

  const prev = m.counters;
  const remotes = [...all.values()].filter((s) => s.type === 'remote-inbound-rtp');
  const videos: BuiltVideo[] = [];
  let audio: AudioLine | null = null;
  for (const [id, stat] of all) {
    if (stat.type !== rtpType) continue;
    if (stat.kind === 'video') {
      const built = videoOf(stat, id, all, prev, dt, direction, remotes);
      if (built) videos.push(built);
    } else if (stat.kind === 'audio' && !audio) {
      audio = audioOf(stat, all, prev, dt, direction, source.audioMuted(), remotes);
    }
  }

  const want = source.videoTrackId();
  if (want && want !== m.trackId) {
    m.trackId = want;
    m.fps = [];
    m.bitrate = [];
    m.loss = [];
    m.stall = 0;
    m.freezes = [];
  }
  const primary =
    videos.find((v) => want && v.trackId === want) ??
    videos.reduce<BuiltVideo | undefined>((best, v) => (!best || v.line.bitrate > best.line.bitrate ? v : best), undefined);

  m.at = now;
  m.counters = counters;
  if (!primary) return undefined;

  const matched = !!(want && primary.trackId === want);
  if (dt <= STALL_DT_MAX && primary.frameDelta === 0 && m.fps.length > 0) m.stall += 1;
  else if (primary.frameDelta !== null && primary.frameDelta > 0) m.stall = 0;
  push(m.fps, primary.line.fps);
  push(m.bitrate, primary.line.bitrate);
  if (primary.line.lossPct !== null && source.role === 'watch') push(m.loss, primary.line.lossPct);

  let worstRemote = primary.remoteLoss;
  let worstReason: Reason = primary.line.reason ?? 'none';
  for (const v of videos) {
    if (v.remoteLoss !== null && (worstRemote === null || v.remoteLoss > worstRemote)) worstRemote = v.remoteLoss;
    if (v.line.reason) worstReason = worse(worstReason, v.line.reason);
  }
  if (source.role === 'publish') {
    push(m.reasons, worstReason);
    if (worstRemote !== null) push(m.remoteLoss, worstRemote);
  }

  if (primary.freezeDelta !== null) m.freezes.push({ t: now, delta: primary.freezeDelta });
  m.freezes = m.freezes.filter((f) => now - f.t <= FREEZE_WINDOW_MS);
  const freezeSec = m.freezes.reduce((sum, f) => sum + f.delta, 0);

  if (audio && source.role === 'publish') {
    if (audio.muted || audio.level === null || audio.level >= SILENT_LEVEL) m.silent = 0;
    else m.silent += 1;
    audio.silent = !audio.muted && m.silent >= SILENT_SAMPLES;
  }

  const smooth = (value: number, values: number[]) => (values.length ? mean(values, SMOOTH) : value);
  primary.line.fps = smooth(primary.line.fps, m.fps);
  primary.line.bitrate = smooth(primary.line.bitrate, m.bitrate);
  if (source.role === 'watch' && m.loss.length) primary.line.lossPct = mean(m.loss, SMOOTH);

  const pair = selectedPair(all);
  const pairRtt = pair ? num(pair.currentRoundTripTime) : undefined;
  const judged = source.role === 'watch' ? { word: watchWord(m, freezeSec), reason: null } : publishWord(m);
  const others = videos
    .filter((v) => v !== primary)
    .map((v) => {
      v.line.label = (v.trackId && source.labelOf(v.trackId)) || 'video';
      return v.line;
    });

  return {
    word: judged.word,
    video: primary.line,
    others,
    audio,
    rttMs: pairRtt !== undefined ? pairRtt * 1000 : null,
    availableBps: pair ? (num(source.role === 'publish' ? pair.availableOutgoingBitrate : pair.availableIncomingBitrate) ?? null) : null,
    path: pathOf(all, pair),
    capBps: source.role === 'publish' && (matched || videos.length === 1) ? source.capBps() : null,
    reason: judged.reason
  };
}

/** Sample `source` until the returned function runs. The first sample only arms the rates; the next one writes. */
export function startSampler(source: SamplerSource): () => void {
  const memory = emptyMemory();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = () => {
    if (stopped) return;
    const pc = source.pc();
    if (!pc || pc.connectionState === 'closed') {
      timer = setTimeout(tick, SAMPLE_MS);
      return;
    }
    pc.getStats()
      .then((report) => {
        if (stopped) return;
        const view = nextStats(memory, report, source);
        if (view) source.write(view);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!stopped) timer = setTimeout(tick, SAMPLE_MS);
      });
  };
  tick();
  return () => {
    stopped = true;
    clearTimeout(timer);
    source.write(null);
  };
}
