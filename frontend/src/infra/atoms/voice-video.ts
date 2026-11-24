import { atom } from 'jotai';

import { store } from '@/infra/store';
import { trimOffer } from '@/infra/voice-offer';

import { openVoiceCamera, voiceCameraAtom, type VoiceSeat } from './voice-atoms';

export type VideoKind = 'camera' | 'screen';

export interface VoicePicture {
  seat: number;
  user: string;
  kind: VideoKind;
  stream: MediaStream;
}

export const voicePicturesAtom = atom<VoicePicture[]>([]);
export const voiceLocalVideoAtom = atom<{ camera: MediaStream | null; screen: MediaStream | null }>({ camera: null, screen: null });
export const voiceVideoErrorAtom = atom('');

export const SCREEN_SUPPORTED = typeof navigator !== 'undefined' && !!navigator.mediaDevices && 'getDisplayMedia' in navigator.mediaDevices;

const CAMERA: MediaTrackConstraints = { width: { ideal: 640, max: 640 }, height: { ideal: 360, max: 360 }, frameRate: { ideal: 24, max: 24 } };
const SCREEN: MediaTrackConstraints = { width: { max: 1920 }, height: { max: 1080 }, frameRate: { ideal: 15, max: 15 } };
const ENCODING: Record<VideoKind, RTCRtpEncodingParameters> = {
  camera: { maxBitrate: 600_000, maxFramerate: 24 },
  screen: { maxBitrate: 1_500_000, maxFramerate: 15 }
};
const ANSWER_MS = 10_000;

interface Wire {
  pc: RTCPeerConnection;
  send: (frame: object) => void;
  fail: (error: string) => void;
}

let wire: Wire | null = null;
const sending: Record<VideoKind, RTCRtpTransceiver | null> = { camera: null, screen: null };
let seeing: RTCRtpTransceiver[] = [];
let chain: Promise<void> = Promise.resolve();
let waiting: ((sdp: string) => void) | null = null;
const streams = new Map<string, MediaStream>();
const opening: Record<VideoKind, boolean> = { camera: false, screen: false };

function vp8Only(t: RTCRtpTransceiver): void {
  const codecs = (RTCRtpReceiver.getCapabilities?.('video')?.codecs ?? []).filter((c) => /^video\/vp8$/i.test(c.mimeType));
  if (codecs.length && 'setCodecPreferences' in t) {
    try {
      t.setCodecPreferences(codecs);
    } catch {
    }
  }
}

export function startVideo(pc: RTCPeerConnection, send: (frame: object) => void, fail: (error: string) => void): void {
  wire = { pc, send, fail };
  chain = Promise.resolve();
  waiting = null;
}

export function stopVideo(): void {
  wire = null;
  waiting = null;
  chain = Promise.resolve();
  seeing = [];
  streams.clear();
  for (const kind of ['camera', 'screen'] as const) {
    for (const t of local(kind)?.getTracks() ?? []) t.stop();
    sending[kind] = null;
    opening[kind] = false;
  }
  store.set(voiceLocalVideoAtom, { camera: null, screen: null });
  store.set(voicePicturesAtom, []);
  store.set(voiceVideoErrorAtom, '');
}

const local = (kind: VideoKind) => store.get(voiceLocalVideoAtom)[kind];

export function takeVideoAnswer(sdp: string): boolean {
  if (!waiting) return false;
  const done = waiting;
  waiting = null;
  done(sdp);
  return true;
}

function labels(): Record<string, VideoKind> {
  const out: Record<string, VideoKind> = {};
  for (const kind of ['camera', 'screen'] as const) {
    const t = sending[kind];
    if (t?.mid && t.direction === 'sendonly') out[t.mid] = kind;
  }
  return out;
}

function offer(): Promise<void> {
  const w = wire;
  chain = chain.then(async () => {
    if (!w || wire !== w) return;
    try {
      await w.pc.setLocalDescription(await w.pc.createOffer());
      const answered = new Promise<string>((done, fail) => {
        waiting = done;
        setTimeout(() => fail(new Error('no answer')), ANSWER_MS);
      });
      w.send({ sdp: trimOffer(w.pc.localDescription?.sdp ?? ''), video: labels() });
      const sdp = await answered;
      if (wire !== w) return;
      await w.pc.setRemoteDescription({ type: 'answer', sdp });
    } catch {
      if (wire === w) w.fail('video could not be set up: the voice server did not answer');
    }
  });
  return chain;
}

export function videoSeats(seats: readonly VoiceSeat[]): void {
  const w = wire;
  if (!w) return;
  const wanted = seats.reduce((n, s) => n + (s.video?.length ?? 0), 0);
  if (wanted > seeing.length) {
    while (seeing.length < wanted) {
      const t = w.pc.addTransceiver('video', { direction: 'recvonly' });
      vp8Only(t);
      seeing.push(t);
    }
    void offer();
  }
  const byMid = new Map(w.pc.getTransceivers().map((t) => [t.mid, t]));
  const pictures: VoicePicture[] = [];
  for (const s of seats) {
    for (const p of s.video ?? []) {
      const t = p.mid ? byMid.get(p.mid) : undefined;
      if (!t || !p.mid) continue;
      let stream = streams.get(p.mid);
      if (!stream) {
        stream = new MediaStream([t.receiver.track]);
        streams.set(p.mid, stream);
      }
      pictures.push({ seat: s.seat, user: s.user, kind: p.kind, stream });
    }
  }
  const was = store.get(voicePicturesAtom);
  const same = was.length === pictures.length && was.every((p, i) => p.seat === pictures[i]?.seat && p.kind === pictures[i]?.kind && p.stream === pictures[i]?.stream);
  if (!same) store.set(voicePicturesAtom, pictures);
}

export function sayVoiceState(mute: boolean, deaf: boolean): void {
  wire?.send({ state: { mute, deaf } });
}

function refusal(err: unknown, kind: VideoKind): string {
  const name = (err as { name?: string } | null)?.name;
  if (name === 'NotAllowedError') return kind === 'camera' ? 'camera not allowed: allow it in the browser' : 'screen share was cancelled';
  if (name === 'NotFoundError') return 'no camera is plugged in';
  return kind === 'camera' ? 'the camera could not be opened' : 'the screen could not be shared';
}

async function open(kind: VideoKind): Promise<MediaStream> {
  if (kind === 'camera') return openVoiceCamera(store.get(voiceCameraAtom), CAMERA);
  return navigator.mediaDevices.getDisplayMedia({ video: SCREEN, audio: false });
}

export async function setVoiceVideo(kind: VideoKind, on: boolean): Promise<void> {
  const w = wire;
  if (!w || opening[kind]) return;
  store.set(voiceVideoErrorAtom, '');
  if (!on) {
    const stream = local(kind);
    if (!stream) return;
    for (const t of stream.getTracks()) t.stop();
    store.set(voiceLocalVideoAtom, { ...store.get(voiceLocalVideoAtom), [kind]: null });
    const t = sending[kind];
    if (t) {
      await t.sender.replaceTrack(null).catch(() => undefined);
      t.direction = 'inactive';
      await offer();
    }
    return;
  }
  if (local(kind)) return;
  opening[kind] = true;
  let stream: MediaStream;
  try {
    stream = await open(kind);
  } catch (err) {
    opening[kind] = false;
    if (wire === w) store.set(voiceVideoErrorAtom, refusal(err, kind));
    return;
  }
  opening[kind] = false;
  const [track] = stream.getVideoTracks();
  if (wire !== w || !track) {
    for (const t of stream.getTracks()) t.stop();
    return;
  }
  if (kind === 'screen') track.contentHint = 'detail';
  track.addEventListener('ended', () => {
    if (local(kind) === stream) void setVoiceVideo(kind, false);
  });
  store.set(voiceLocalVideoAtom, { ...store.get(voiceLocalVideoAtom), [kind]: stream });
  const was = sending[kind];
  if (was) {
    await was.sender.replaceTrack(track).catch(() => undefined);
    was.direction = 'sendonly';
  } else {
    const t = w.pc.addTransceiver(track, { direction: 'sendonly', streams: [stream], sendEncodings: [ENCODING[kind]] });
    vp8Only(t);
    sending[kind] = t;
  }
  await offer();
}

export async function switchVoiceCamera(): Promise<void> {
  const w = wire;
  const t = sending.camera;
  const was = local('camera');
  if (!w || !t || !was || opening.camera) return;
  opening.camera = true;
  let stream: MediaStream;
  try {
    stream = await open('camera');
  } catch {
    opening.camera = false;
    return;
  }
  opening.camera = false;
  const [track] = stream.getVideoTracks();
  if (wire !== w || local('camera') !== was || !track) {
    for (const x of stream.getTracks()) x.stop();
    return;
  }
  track.addEventListener('ended', () => {
    if (local('camera') === stream) void setVoiceVideo('camera', false);
  });
  await t.sender.replaceTrack(track).catch(() => undefined);
  for (const x of was.getTracks()) x.stop();
  store.set(voiceLocalVideoAtom, { ...store.get(voiceLocalVideoAtom), camera: stream });
}
