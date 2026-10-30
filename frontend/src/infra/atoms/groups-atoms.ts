/**
 * Groups: the list from `GET /api/groups`, which of them are mine, and the actions on them.
 * See docs/groups.md. The user modal's groups tab edits them and the profile tab shows mine;
 * the sidebar lists the ones I am in as servers (`GET /api/explore`'s `yours`, which has each
 * one's picture and who in it is live). The chat needs nothing from here: the server puts each
 * speaker's badges on the line itself. Same shape as the other atom modules: atoms for what
 * renders, action functions to change it.
 */

import { atom } from 'jotai';

import { api, type Group, type NewGroup, type Server, messageOf } from '@/infra/api';
import { meAtom } from '@/infra/atoms/auth-atoms';
import { reconnectChat } from '@/infra/atoms/chat-atoms';
import { store } from '@/infra/store';

export const groupsAtom = atom<Group[]>([]);
/** `undefined` until the first answer, then whether the list is the server's. */
export const groupsLoadedAtom = atom<boolean | undefined>(undefined);
export const groupsBusyAtom = atom(false);
/** What the last action did: `joined vip`, or `not joined: <why>`. */
export const groupsStatusAtom = atom('');
/** The groups the login is in, in the list's order: the badges its chat lines wear. */
export const myGroupsAtom = atom((get) => get(groupsAtom).filter((g) => g.mine));
/** The servers the login is in, as the sidebar lists them (docs/follows.md). `undefined` until asked once this page load; `[]` for nobody. */
export const myServersAtom = atom<Server[] | undefined>(undefined);

let askingServers: Promise<void> | null = null;
/** Bumped by `forgetMyServers`: an ask carries the stamp it was made under and lands only while that is still the current one. */
let serversStamp = 0;

/** Cheap, so every mount asks: `mine` depends on who is logged in, and others make groups too. */
export async function loadGroups(): Promise<void> {
  try {
    store.set(groupsAtom, await api.groups());
    store.set(groupsLoadedAtom, true);
  } catch (err) {
    store.set(groupsLoadedAtom, false);
    store.set(groupsStatusAtom, `not loaded: ${messageOf(err)}`);
  }
}

/** The sidebar's list again, with who is live in each now. One ask at a time; a second caller waits for the first. An answer for a login since forgotten is dropped. Nobody: an empty list, no request. */
export function loadMyServers(): Promise<void> {
  if (!store.get(meAtom)) {
    store.set(myServersAtom, []);
    return Promise.resolve();
  }
  if (!askingServers) {
    const stamp = serversStamp;
    askingServers = api
      .explore()
      .then((found) => {
        if (stamp === serversStamp) store.set(myServersAtom, found.yours);
      })
      .catch(() => {
        // the api is away: what is shown stays (nothing, for a first ask that failed: the column must not wait on it), the next open asks again
        if (stamp === serversStamp && store.get(myServersAtom) === undefined) store.set(myServersAtom, []);
      })
      .finally(() => {
        // a later login's ask may be in flight by now: only this stamp's own is cleared
        if (stamp === serversStamp) askingServers = null;
      });
  }
  return askingServers;
}

/** The login changed (in, out, renamed): the servers shown were theirs, and so is an ask still in flight: its answer is dropped and the next ask is a fresh one. */
export function forgetMyServers() {
  serversStamp += 1;
  askingServers = null;
  store.set(myServersAtom, undefined);
}

/**
 * One action, then the list as the server has it now (counts, `mine`), then the status.
 * When my badges changed, the open chat says hello again so its lines wear them at once:
 * the server reads a socket's groups once, at the hello. The sidebar's servers follow too.
 */
async function act(doing: string, call: () => Promise<unknown>, done: string, wearing: boolean): Promise<boolean> {
  store.set(groupsBusyAtom, true);
  store.set(groupsStatusAtom, '');
  try {
    await call();
    await loadGroups();
    void loadMyServers();
    store.set(groupsStatusAtom, done);
    if (wearing) reconnectChat();
    return true;
  } catch (err) {
    store.set(groupsStatusAtom, `not ${doing}: ${messageOf(err)}`);
    return false;
  } finally {
    store.set(groupsBusyAtom, false);
  }
}

/** The group as made, its `name` the address with the digits, or null when the api refused (the status says why). */
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

/** Public is on the lists. Private is on the lists only for someone in it. */
export function setGroupListed(name: string, isPublic: boolean, label: string): Promise<boolean> {
  return act(isPublic ? 'public' : 'private', () => api.setGroupPublic(name, isPublic), isPublic ? `${label} is public` : `${label} is private`, false);
}

export function joinGroup(name: string): Promise<boolean> {
  return act('joined', () => api.joinGroup(name), `joined ${name}`, true);
}

export function leaveGroup(name: string): Promise<boolean> {
  return act('left', () => api.leaveGroup(name), `left ${name}`, true);
}

/** `mine`: I was in it, so my lines lose its badge. */
export function deleteGroup(name: string, mine: boolean): Promise<boolean> {
  return act('deleted', () => api.deleteGroup(name), `deleted ${name}`, mine);
}

export function clearGroupsStatus() {
  store.set(groupsStatusAtom, '');
}
