/**
 * Groups: the list from `GET /api/groups`, which of them are mine, and the actions on them.
 * See docs/groups.md. The user modal's groups tab edits them and the profile tab shows mine.
 * The chat needs nothing from here: the server puts each speaker's badges on the line itself.
 * Same shape as the other atom modules: atoms for what renders, action functions to change it.
 */

import { atom } from 'jotai';

import { api, type Group, type NewGroup, messageOf } from '@/infra/api';
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

/**
 * One action, then the list as the server has it now (counts, `mine`), then the status.
 * When my badges changed, the open chat says hello again so its lines wear them at once:
 * the server reads a socket's groups once, at the hello.
 */
async function act(doing: string, call: () => Promise<unknown>, done: string, wearing: boolean): Promise<boolean> {
  store.set(groupsBusyAtom, true);
  store.set(groupsStatusAtom, '');
  try {
    await call();
    await loadGroups();
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

export function createGroup(group: NewGroup): Promise<boolean> {
  return act('made', () => api.createGroup(group), `made ${group.name}. you are in it`, true);
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
