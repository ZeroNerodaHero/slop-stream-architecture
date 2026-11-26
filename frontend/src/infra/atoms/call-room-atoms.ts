import { atom } from 'jotai';

import { api, type GroupRoom } from '@/infra/api';
import { MEMBER_ROW_PX, pageFor, roomAtom, withVoiceChange } from '@/infra/atoms/room-atoms';
import { voiceCallAtom, voiceUidsAtom } from '@/infra/atoms/voice-state';
import { holdPresence, onEvents, releasePresence } from '@/infra/events';
import { type GroupChange, groupTopic } from '@/infra/frames';
import { store } from '@/infra/store';

export const callRoomAtom = atom<GroupRoom | null>(null);

let held = '';
let asked = 0;

function callServer(): string {
  const call = store.get(voiceCallAtom);
  return call.phase === 'joining' || call.phase === 'connected' ? call.server : '';
}

function onPage(server: string): boolean {
  return store.get(roomAtom)?.name === server;
}

async function loadCallRoom(server: string): Promise<void> {
  const mine = ++asked;
  try {
    const room = await api.group(server, pageFor(MEMBER_ROW_PX));
    if (mine === asked && callServer() === server && !onPage(server)) store.set(callRoomAtom, room);
  } catch {
    return;
  }
}

function sync(): void {
  const server = callServer();
  if (held !== server) {
    if (held) releasePresence(groupTopic(held));
    held = server;
    if (server) holdPresence(groupTopic(server));
  }
  const room = store.get(roomAtom);
  if (server && room?.name === server) {
    asked++;
    if (store.get(callRoomAtom) !== room) store.set(callRoomAtom, room);
    return;
  }
  if (server && store.get(callRoomAtom)?.name === server) return;
  asked++;
  if (store.get(callRoomAtom)) store.set(callRoomAtom, null);
  if (server) void loadCallRoom(server);
}

function renamed(room: GroupRoom, from: string, to: string): GroupRoom {
  return {
    ...room,
    channels: (room.channels ?? []).filter((c) => c.name !== to).map((c) => (c.name === from ? { ...c, name: to } : c)),
    voice: room.voice && from in room.voice ? Object.fromEntries(Object.entries(room.voice).map(([c, people]) => [c === from ? to : c, people])) : room.voice
  };
}

function apply(change: GroupChange): void {
  const room = store.get(callRoomAtom);
  if (!room) return;
  if (change.what === 'channel_renamed') {
    if (change.channel === change.name || !(room.channels ?? []).some((c) => c.name === change.channel)) return;
    store.set(callRoomAtom, renamed(room, change.channel, change.name));
    const call = store.get(voiceCallAtom);
    if (call.server === room.name && call.channel === change.channel) store.set(voiceCallAtom, { ...call, channel: change.name });
    return;
  }
  if (change.what === 'unchannel') {
    const voice = room.voice ? Object.fromEntries(Object.entries(room.voice).filter(([c]) => c !== change.channel)) : room.voice;
    store.set(callRoomAtom, { ...room, channels: (room.channels ?? []).filter((c) => c.name !== change.channel), voice });
    return;
  }
  const next = withVoiceChange(room, change);
  if (next) store.set(callRoomAtom, next);
}

store.sub(voiceCallAtom, sync);
store.sub(roomAtom, sync);
sync();

store.sub(callRoomAtom, () => {
  const people = Object.values(store.get(callRoomAtom)?.voice ?? {}).flat();
  const was = store.get(voiceUidsAtom);
  if (people.length === was.size && people.every((p) => was.get(p.name) === p.uid)) return;
  store.set(voiceUidsAtom, new Map(people.map((p) => [p.name, p.uid])));
});

onEvents((event) => {
  const server = callServer();
  if (!server || onPage(server)) return;
  if (event.type === 'link') {
    if (event.phase === 'open') void loadCallRoom(server);
  } else if (event.type === 'group' && event.group === server) apply(event);
});
