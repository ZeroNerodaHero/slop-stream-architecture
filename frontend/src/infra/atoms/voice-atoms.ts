/**
 * Being in a voice channel (docs/voice.md). One call at a time, for the whole tab: a join asks
 * the api for a grant (`POST /api/groups/:group/voice/:channel/join`), opens `/voice`, and its
 * first frame is `{role: 'voice', grant, sdp}` with an offer of 1 sendrecv mic and 15 recvonly
 * audio m-lines (video/src/voice.rs). The voice server answers `{sdp}` or `{error}`, then
 * `{event: 'seats', seats: [{seat, user, line}]}` on every join and leave: `line` is the m-line
 * that person is heard on. Who is in which channel is the room's (`voice` in room-atoms.ts,
 * kept by the `voice` and `voice_left` facts); this module is only this tab's own call, and who
 * is speaking in it, from each m-line's `audioLevel` (getStats). Same shape as the other atom
 * modules: atoms for what renders, module handles, action functions.
 */

import { atom } from 'jotai';

import { api, messageOf } from '@/infra/api';
import { socketUrl } from '@/infra/frames';
import { store } from '@/infra/store';

/** How many m-lines hear the others: a room's 16 seats less your own. */
const HEARD_LINES = 15;
/** How long the offer waits for its candidates: there is no trickle, the join frame carries them. */
const GATHER_MS = 3000;
/** How often the levels are read. */
const LEVEL_MS = 150;
/** An `audioLevel` (0 to 1) at or over this is speaking. */
const SPEAKING = 0.03;

export interface VoiceSeat {
  seat: number;
  user: string;
  line: number;
}

/**
 * This tab's call. `joining` from the click to the answer; `linked` once the audio itself is
 * through (the peer connected over udp), which can lag the answer or never come; `error` is a
 * quiet line under the list, '' for none.
 */
export interface VoiceCall {
  phase: 'idle' | 'joining' | 'connected';
  server: string;
  channel: string;
  linked: boolean;
  error: string;
}

const IDLE: VoiceCall = { phase: 'idle', server: '', channel: '', linked: false, error: '' };

/** A call whose audio never got through: the answer came over the socket, the udp did not. */
const NO_AUDIO_PATH = 'no audio path: nothing got through to the voice server over udp, a firewall is closing it';

export const voiceCallAtom = atom<VoiceCall>(IDLE);
/** Who sits where in the room, as the last seats frame said. Your own seat is not in it. */
export const voiceSeatsAtom = atom<VoiceSeat[]>([]);
/** The names speaking now, your own among them while your mic is. */
export const voiceSpeakingAtom = atom<ReadonlySet<string>>(new Set<string>());
/** Your mic is off: the track is still there, sending silence. */
export const voiceMutedAtom = atom(false);
/** You hear nobody, and your mic is off with it. */
export const voiceDeafAtom = atom(false);

/** The live call's handles, null while idle. */
interface Live {
  pc: RTCPeerConnection;
  ws: WebSocket | null;
  mic: MediaStream;
  audios: HTMLAudioElement[];
  timer: ReturnType<typeof setInterval> | null;
}

let live: Live | null = null;
/** Which join is the current one: anything an older one finishes after a leave is dropped. */
let attempt = 0;

function setCall(next: Partial<VoiceCall>): void {
  store.set(voiceCallAtom, { ...store.get(voiceCallAtom), ...next });
}

/** Puts everything down: socket, peer, mic, players, the level reader. Nothing is said to anyone: the voice server frees the seat when the socket closes. */
function teardown(): void {
  const was = live;
  live = null;
  store.set(voiceSeatsAtom, []);
  store.set(voiceSpeakingAtom, new Set<string>());
  if (!was) return;
  if (was.timer) clearInterval(was.timer);
  if (was.ws) {
    was.ws.onclose = null;
    was.ws.onmessage = null;
    was.ws.close();
  }
  was.pc.onconnectionstatechange = null;
  was.pc.close();
  for (const track of was.mic.getTracks()) track.stop();
  for (const audio of was.audios) {
    audio.pause();
    audio.srcObject = null;
  }
}

/** The call went wrong: down, with the word under the list. */
function fail(mine: number, error: string): void {
  if (mine !== attempt) return;
  teardown();
  store.set(voiceCallAtom, { ...IDLE, error });
}

/** Out of the call, if in one. Clicked, or the page going away. */
export function leaveVoice(): void {
  attempt++;
  teardown();
  store.set(voiceCallAtom, IDLE);
}

/** The mic on or off. Off while deafened, whatever was asked. */
function applyMic(): void {
  const on = !store.get(voiceMutedAtom) && !store.get(voiceDeafAtom);
  for (const track of live?.mic.getAudioTracks() ?? []) track.enabled = on;
}

export function setVoiceMuted(muted: boolean): void {
  store.set(voiceMutedAtom, muted);
  applyMic();
}

export function setVoiceDeaf(deaf: boolean): void {
  store.set(voiceDeafAtom, deaf);
  for (const audio of live?.audios ?? []) audio.muted = deaf;
  applyMic();
}

/** Into `channel` of `server`. Already in it: nothing. In another: out of that one first. */
export async function joinVoice(server: string, channel: string, me: string): Promise<void> {
  const call = store.get(voiceCallAtom);
  if (call.phase !== 'idle' && call.server === server && call.channel === channel) return;
  leaveVoice();
  const mine = attempt;
  store.set(voiceCallAtom, { phase: 'joining', server, channel, linked: false, error: '' });

  let grant;
  try {
    grant = await api.joinVoice(server, channel);
  } catch (err) {
    return fail(mine, messageOf(err));
  }
  if (mine !== attempt) return;

  let mic: MediaStream;
  try {
    mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch {
    return fail(mine, 'no microphone: allow it in the browser to talk');
  }
  if (mine !== attempt) {
    for (const track of mic.getTracks()) track.stop();
    return;
  }

  const [track] = mic.getAudioTracks();
  if (!track) {
    for (const t of mic.getTracks()) t.stop();
    return fail(mine, 'no microphone: allow it in the browser to talk');
  }
  const pc = new RTCPeerConnection();
  const audios: HTMLAudioElement[] = [];
  live = { pc, ws: null, mic, audios, timer: null };
  applyMic();
  // m-line 0 is the mic; 1 to 15 are where the others are heard, in the order they were added
  pc.addTransceiver(track, { direction: 'sendrecv', streams: [mic] });
  for (let i = 0; i < HEARD_LINES; i++) {
    const t = pc.addTransceiver('audio', { direction: 'recvonly' });
    const audio = new Audio();
    audio.autoplay = true;
    audio.muted = store.get(voiceDeafAtom);
    audio.srcObject = new MediaStream([t.receiver.track]);
    audios.push(audio);
  }
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected' && mine === attempt) setCall({ linked: true });
    if (pc.connectionState === 'failed') fail(mine, store.get(voiceCallAtom).linked ? 'voice lost its connection' : NO_AUDIO_PATH);
  };

  try {
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise<void>((done) => {
      if (pc.iceGatheringState === 'complete') return done();
      pc.onicegatheringstatechange = () => pc.iceGatheringState === 'complete' && done();
      setTimeout(done, GATHER_MS);
    });
  } catch {
    return fail(mine, 'voice could not start');
  }
  if (mine !== attempt) return;

  const ws = new WebSocket(socketUrl(grant.url, location.href));
  live.ws = ws;
  ws.onopen = () => ws.send(JSON.stringify({ role: 'voice', grant: grant.grant, sdp: pc.localDescription?.sdp ?? '' }));
  // the voice server says why in an error frame when it knows (that one wins: fail tears this
  // handler down); a socket that only closes is said from what this side saw
  ws.onclose = (e: CloseEvent) => fail(mine, closedWord(store.get(voiceCallAtom), e.code));
  ws.onmessage = (e: MessageEvent) => {
    let msg: { error?: string; sdp?: string; event?: string; seats?: VoiceSeat[] };
    try {
      msg = JSON.parse(String(e.data));
    } catch {
      return;
    }
    if (msg.error) return fail(mine, msg.error);
    if (msg.sdp) {
      pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp }).then(
        () => {
          if (mine !== attempt) return;
          setCall({ phase: 'connected' });
          for (const audio of audios) void audio.play().catch(() => {});
        },
        () => fail(mine, 'bad answer')
      );
    } else if (msg.event === 'seats' && Array.isArray(msg.seats)) {
      store.set(voiceSeatsAtom, msg.seats);
    }
  };
  live.timer = setInterval(() => void readLevels(mine, me), LEVEL_MS);
}

/** Why the socket closed with no word from the voice server, from where the call had got to. */
function closedWord(call: VoiceCall, code: number): string {
  if (call.phase !== 'connected') return code === 1006 ? 'voice is unreachable: the voice server did not answer' : `voice is unreachable (${code})`;
  if (!call.linked) return NO_AUDIO_PATH;
  return code === 1006 ? 'voice dropped: the connection to the voice server broke' : `voice dropped: the voice server closed the call (${code})`;
}

/** Who is speaking: each heard m-line's `audioLevel` by its seat's name, and the mic's as `me`. Set only when the set changes. */
async function readLevels(mine: number, me: string): Promise<void> {
  const call = live;
  if (!call || mine !== attempt) return;
  let report: RTCStatsReport;
  try {
    report = await call.pc.getStats();
  } catch {
    return;
  }
  if (mine !== attempt) return;
  const lineOfTrack = new Map<string, number>();
  call.pc.getTransceivers().forEach((t, i) => lineOfTrack.set(t.receiver.track.id, i));
  const userOfLine = new Map(store.get(voiceSeatsAtom).map((s) => [s.line, s.user]));
  const speaking = new Set<string>();
  const micOn = !store.get(voiceMutedAtom) && !store.get(voiceDeafAtom);
  report.forEach((s: { type: string; kind?: string; audioLevel?: number; trackIdentifier?: string }) => {
    if (s.kind !== 'audio' || (s.audioLevel ?? 0) < SPEAKING) return;
    if (s.type === 'media-source') {
      if (micOn) speaking.add(me);
    } else if (s.type === 'inbound-rtp' && s.trackIdentifier) {
      const user = userOfLine.get(lineOfTrack.get(s.trackIdentifier) ?? -1);
      if (user) speaking.add(user);
    }
  });
  const was = store.get(voiceSpeakingAtom);
  if (was.size !== speaking.size || [...speaking].some((n) => !was.has(n))) store.set(voiceSpeakingAtom, speaking);
}
