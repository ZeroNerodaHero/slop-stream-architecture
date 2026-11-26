import { atom } from 'jotai';

import { api, type DmCallAnswer, type GroupRoom, messageOf } from '@/infra/api';
import { meAtom } from '@/infra/atoms/auth-atoms';
import { dmsAtom, showDmNotice } from '@/infra/atoms/dm-atoms';
import { followingAtom } from '@/infra/atoms/follow-atoms';
import { voiceCallAtom } from '@/infra/atoms/voice-state';
import { BRIEF_MS, briefPhase, type DmCallPhase, RING_MS } from '@/infra/dm-call';
import { onEvents } from '@/infra/events';
import type { CallChange } from '@/infra/frames';
import { store } from '@/infra/store';

export interface DmCall {
  id: string;
  peer: string;
  server: string;
  channel: string;
  phase: DmCallPhase;
  since: number | null;
}

export interface DmRing {
  id: string;
  from: string;
  avatar: number | null;
  server: string;
  channel: string;
}

export const dmCallAtom = atom<DmCall | null>(null);
export const dmRingAtom = atom<DmRing | null>(null);
export const dmCallBusyAtom = atom(false);

let ringTimer: ReturnType<typeof setTimeout> | null = null;
let briefTimer: ReturnType<typeof setTimeout> | null = null;
let lastId = '';

const voice = () => import('@/infra/atoms/voice-atoms');

function avatarOf(name: string): number | null {
  return store.get(dmsAtom).find((d) => d.name === name)?.avatar ?? store.get(followingAtom)?.find((f) => f.name === name)?.avatar ?? null;
}

export function dmCallRoom(call: Pick<DmCall, 'server' | 'channel' | 'peer'>, me: string, myAvatar: number | null): GroupRoom {
  return {
    name: call.server,
    badge: '',
    color: '',
    about: '',
    members: 2,
    mine: true,
    owner: false,
    icon: null,
    banner: null,
    perms: { appearance: false, roles: false, channels: false, kick: false, ban: false },
    roles: [],
    channels: [{ name: call.channel, about: '', can_delete: false, kind: 'voice' }],
    roster: [
      { name: me, owner: false, roles: [], avatar: myAvatar },
      { name: call.peer, owner: false, roles: [], avatar: avatarOf(call.peer) }
    ]
  };
}

function inRoom(call: Pick<DmCall, 'server'>): boolean {
  const now = store.get(voiceCallAtom);
  return now.server === call.server && (now.phase === 'joining' || now.phase === 'connected');
}

function setCall(next: DmCall | null) {
  if (briefTimer) clearTimeout(briefTimer);
  briefTimer = null;
  if (next) lastId = next.id;
  store.set(dmCallAtom, next);
}

function brief(call: DmCall, phase: 'declined' | 'no answer') {
  setCall({ ...call, phase });
  briefTimer = setTimeout(() => {
    briefTimer = null;
    if (store.get(dmCallAtom)?.id === call.id) store.set(dmCallAtom, null);
  }, BRIEF_MS);
}

async function enter(answer: DmCallAnswer, phase: DmCallPhase): Promise<void> {
  const me = store.get(meAtom);
  if (!me) return;
  const { joinVoice } = await voice();
  const joined = joinVoice(answer.server, answer.channel, me);
  setCall({ id: answer.id, peer: answer.peer, server: answer.server, channel: answer.channel, phase, since: phase === 'live' ? Date.now() : null });
  await joined;
}

export async function startDmCall(peer: string): Promise<void> {
  if (store.get(dmCallBusyAtom)) return;
  store.set(dmCallBusyAtom, true);
  try {
    const answer = await api.startDmCall(peer);
    if (store.get(dmRingAtom)?.id === answer.id) stopRing();
    await enter(answer, answer.state === 'accepted' ? 'live' : 'calling');
  } catch (err) {
    showDmNotice(messageOf(err));
  } finally {
    store.set(dmCallBusyAtom, false);
  }
}

export async function acceptDmCall(): Promise<void> {
  const ring = store.get(dmRingAtom);
  if (!ring) return;
  stopRing();
  try {
    const answer = await api.acceptDmCall(ring.from, ring.id);
    await enter(answer, 'live');
  } catch (err) {
    showDmNotice(messageOf(err));
  }
}

export function declineDmCall(): void {
  const ring = store.get(dmRingAtom);
  if (!ring) return;
  stopRing();
  api.declineDmCall(ring.from, ring.id).catch(() => undefined);
}

export function endDmCall(): void {
  const call = store.get(dmCallAtom);
  if (!call) return;
  setCall(null);
  lastId = '';
  if (briefPhase(call.phase)) return;
  api.endDmCall(call.peer, call.id).catch(() => undefined);
  if (inRoom(call)) void voice().then((v) => v.leaveVoice());
}

function ring(change: CallChange & { what: 'ringing' }, from: string) {
  const call = store.get(dmCallAtom);
  if (call && call.peer === from && !briefPhase(call.phase)) return;
  if (ringTimer) clearTimeout(ringTimer);
  store.set(dmRingAtom, { id: change.id, from, avatar: change.avatar ?? avatarOf(from), server: change.server, channel: change.channel });
  ringTimer = setTimeout(
    () => {
      if (store.get(dmRingAtom)?.id === change.id) stopRing();
    },
    Math.min(RING_MS, Math.max(1, change.ring) * 1000)
  );
  startTone();
}

function stopRing() {
  if (ringTimer) clearTimeout(ringTimer);
  ringTimer = null;
  store.set(dmRingAtom, null);
  stopTone();
}

function over(id: string, what: 'declined' | 'missed' | 'ended', peer: string, server: string, channel: string, caller: boolean) {
  if (store.get(dmRingAtom)?.id === id) stopRing();
  const call = store.get(dmCallAtom);
  const ours = call?.id === id ? call : lastId === id ? { id, peer, server, channel, phase: 'calling' as const, since: null } : null;
  if (!ours) return;
  const was = inRoom(ours);
  if (caller && what !== 'ended' && ours.phase !== 'live') brief(ours, what === 'declined' ? 'declined' : 'no answer');
  else if (call?.id === id) setCall(null);
  if (was) void voice().then((v) => v.leaveVoice());
}

onEvents((event) => {
  if (event.type !== 'call') return;
  const me = store.get(meAtom);
  if (!me || (event.caller !== me && event.callee !== me)) return;
  const peer = event.caller === me ? event.callee : event.caller;
  const caller = event.caller === me;
  switch (event.what) {
    case 'ringing':
      if (!caller) ring(event, peer);
      break;
    case 'accepted': {
      if (store.get(dmRingAtom)?.id === event.id) stopRing();
      const call = store.get(dmCallAtom);
      if (call?.id === event.id && call.phase === 'calling') setCall({ ...call, phase: 'live', since: Date.now() });
      break;
    }
    case 'declined':
    case 'missed':
    case 'ended':
      over(event.id, event.what, peer, event.server, event.channel, caller);
      break;
    default:
      break;
  }
});

store.sub(voiceCallAtom, () => {
  const call = store.get(dmCallAtom);
  if (!call || briefPhase(call.phase) || inRoom(call)) return;
  setCall(null);
  lastId = '';
  api.endDmCall(call.peer, call.id).catch(() => undefined);
});

store.sub(meAtom, () => {
  stopRing();
  setCall(null);
});

let tone: { ctx: AudioContext; timer: ReturnType<typeof setInterval> } | null = null;
const TONE_EVERY_MS = 3000;
const TONE_HZ = [440, 480];

function beep(ctx: AudioContext) {
  const t = ctx.currentTime;
  const gain = ctx.createGain();
  gain.connect(ctx.destination);
  gain.gain.setValueAtTime(0, t);
  for (const [on, off] of [
    [0, 0.4],
    [0.6, 1]
  ] as const) {
    gain.gain.setValueAtTime(0, t + on);
    gain.gain.linearRampToValueAtTime(0.12, t + on + 0.02);
    gain.gain.setValueAtTime(0.12, t + off - 0.03);
    gain.gain.linearRampToValueAtTime(0, t + off);
  }
  for (const hz of TONE_HZ) {
    const osc = ctx.createOscillator();
    osc.frequency.value = hz;
    osc.connect(gain);
    osc.start(t);
    osc.stop(t + 1.05);
    osc.onended = () => osc.disconnect();
  }
  setTimeout(() => gain.disconnect(), 1200);
}

function startTone() {
  if (tone || typeof AudioContext === 'undefined') return;
  const ctx = new AudioContext();
  void ctx.resume().catch(() => undefined);
  beep(ctx);
  tone = { ctx, timer: setInterval(() => beep(ctx), TONE_EVERY_MS) };
}

function stopTone() {
  if (!tone) return;
  clearInterval(tone.timer);
  void tone.ctx.close().catch(() => undefined);
  tone = null;
}
