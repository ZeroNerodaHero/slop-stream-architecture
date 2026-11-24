import { atom } from 'jotai';

import { api, type Explore, type Group, type NewGroup, type Server, messageOf } from '@/infra/api';
import { meAtom } from '@/infra/atoms/auth-atoms';
import { reconnectChat } from '@/infra/atoms/chat-atoms';
import { loadMyEmotes } from '@/infra/emotes';
import { roomAtom } from '@/infra/atoms/room-atoms';
import { queryClient } from '@/infra/query-client';
import { store } from '@/infra/store';

export const groupsAtom = atom<Group[]>([]);
export const groupsLoadedAtom = atom<boolean | undefined>(undefined);
export const groupsBusyAtom = atom(false);
export const groupsStatusAtom = atom('');
export const myGroupsAtom = atom((get) => get(groupsAtom).filter((g) => g.mine));
export const myBadgesAtom = atom((get) => {
  const mine = get(myGroupsAtom);
  const primary = mine.find((g) => g.primary);
  return primary ? [primary] : mine.slice(0, 1);
});
export const myServersAtom = atom<Server[] | undefined>(undefined);
export const publicServersAtom = atom<Server[] | undefined>(undefined);
export const groupIconsAtom = atom((get) => {
  const icons = new Map<string, number | null>();
  const heard = (name: string, icon: number | null | undefined) => {
    if (icon !== undefined) icons.set(name, icon);
  };
  for (const group of get(groupsAtom)) heard(group.name, group.icon);
  for (const server of get(publicServersAtom) ?? []) heard(server.name, server.icon);
  for (const server of get(myServersAtom) ?? []) heard(server.name, server.icon);
  const room = get(roomAtom);
  if (room) heard(room.name, room.icon);
  return icons;
});
export const groupColorsAtom = atom((get) => {
  const colors = new Map<string, string>();
  for (const group of get(groupsAtom)) colors.set(group.name, group.color);
  for (const server of get(publicServersAtom) ?? []) colors.set(server.name, server.color);
  for (const server of get(myServersAtom) ?? []) colors.set(server.name, server.color);
  const room = get(roomAtom);
  if (room?.color) colors.set(room.name, room.color);
  return colors;
});

function recolor(name: string, color: string) {
  const paint = <T extends { name: string; color: string }>(list: T[]): T[] =>
    list.some((g) => g.name === name && g.color !== color) ? list.map((g) => (g.name === name ? { ...g, color } : g)) : list;
  store.set(groupsAtom, paint(store.get(groupsAtom)));
  const mine = store.get(myServersAtom);
  if (mine) store.set(myServersAtom, paint(mine));
  const others = store.get(publicServersAtom);
  if (others) store.set(publicServersAtom, paint(others));
  queryClient.setQueryData<Explore>(['explore'], (found) => found && { ...found, yours: paint(found.yours), discover: paint(found.discover) });
}

let roomColor: { name: string; color: string } | null = null;
store.sub(roomAtom, () => {
  const room = store.get(roomAtom);
  const was = roomColor;
  roomColor = room ? { name: room.name, color: room.color } : null;
  if (room && was?.name === room.name && was.color !== room.color && room.color) recolor(room.name, room.color);
});

let askingServers: Promise<void> | null = null;
let serversStamp = 0;
let serversAt = 0;
export const SERVERS_FRESH_MS = 10_000;

export async function loadGroups(): Promise<void> {
  try {
    store.set(groupsAtom, await api.groups());
    store.set(groupsLoadedAtom, true);
  } catch (err) {
    store.set(groupsLoadedAtom, false);
    store.set(groupsStatusAtom, `not loaded: ${messageOf(err)}`);
  }
}

export function loadServers(maxAgeMs = 0): Promise<void> {
  if (maxAgeMs > 0 && serversAt > 0 && Date.now() - serversAt < maxAgeMs) return Promise.resolve();
  if (!askingServers) {
    const stamp = serversStamp;
    askingServers = api
      .explore()
      .then((found) => {
        if (stamp !== serversStamp) return;
        serversAt = Date.now();
        store.set(myServersAtom, found.yours);
        store.set(
          publicServersAtom,
          found.discover.filter((server) => server.public !== false)
        );
      })
      .catch(() => {
        if (stamp === serversStamp && store.get(myServersAtom) === undefined) store.set(myServersAtom, []);
      })
      .finally(() => {
        if (stamp === serversStamp) askingServers = null;
      });
  }
  return askingServers;
}

export function loadMyServers(): Promise<void> {
  if (!store.get(meAtom)) {
    store.set(myServersAtom, []);
    return Promise.resolve();
  }
  return loadServers();
}

export function forgetMyServers() {
  serversStamp += 1;
  askingServers = null;
  serversAt = 0;
  store.set(myServersAtom, undefined);
  store.set(publicServersAtom, undefined);
}

async function act(doing: string, call: () => Promise<unknown>, done: string, wearing: boolean): Promise<boolean> {
  store.set(groupsBusyAtom, true);
  store.set(groupsStatusAtom, '');
  try {
    await call();
    await loadGroups();
    void loadMyServers();
    store.set(groupsStatusAtom, done);
    if (wearing) {
      reconnectChat();
      void loadMyEmotes();
    }
    return true;
  } catch (err) {
    store.set(groupsStatusAtom, `not ${doing}: ${messageOf(err)}`);
    return false;
  } finally {
    store.set(groupsBusyAtom, false);
  }
}

export async function createGroup(group: NewGroup): Promise<Group | null> {
  let made = null as Group | null;
  const ok = await act(
    'made',
    async () => {
      made = await api.createGroup(group);
    },
    `made ${group.name}. you are in it`,
    true
  );
  return ok ? made : null;
}

export function setGroupListed(name: string, isPublic: boolean, label: string): Promise<boolean> {
  return act(isPublic ? 'public' : 'private', () => api.setGroupPublic(name, isPublic), isPublic ? `${label} is public` : `${label} is private`, false);
}

export function joinGroup(name: string): Promise<boolean> {
  return act('joined', () => api.joinGroup(name), `joined ${name}`, true);
}

export function leaveGroup(name: string): Promise<boolean> {
  return act('left', () => api.leaveGroup(name), `left ${name}`, true);
}

export function setPrimaryGroup(name: string, on: boolean): Promise<boolean> {
  return act(
    on ? 'set' : 'cleared',
    () => (on ? api.setPrimaryGroup(name) : api.clearPrimaryGroup(name)),
    on ? `${name} is your primary group` : 'no primary group: your first group\'s badge again',
    true
  );
}

export function deleteGroup(name: string, mine: boolean): Promise<boolean> {
  return act('deleted', () => api.deleteGroup(name), `deleted ${name}`, mine);
}

export function clearGroupsStatus() {
  store.set(groupsStatusAtom, '');
}
