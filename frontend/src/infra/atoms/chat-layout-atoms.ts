/**
 * Where this browser left its chat windows, kept over a refresh: the stream chat's window
 * (ChatSlot.tsx, the layout setting's "window") and the friends' chat window (FriendChat.tsx),
 * each where it was dragged and how big, and whether the friends' chat was on screen and which
 * tab it showed. One versioned key; nothing said in a chat is in it. Whatever localstorage
 * holds is read through a check: a box that is not four finite numbers is the default place,
 * and the windows pull a kept box back on screen themselves (`fitted`), so a smaller window
 * than the one it was left in never hides a chat.
 */

import { atom } from 'jotai';
import { atomWithStorage } from 'jotai/utils';

import { store } from '@/infra/store';

/** Where a window was dragged, and how big, in px of the page. */
export interface ChatBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The friends' chat as it was left, for the login it belongs to: another login gets none of it. `active`: the tab shown, `null` for the friends to pick from. */
export interface DmWindow {
  me: string;
  open: boolean;
  active: string | null;
}

interface ChatLayout {
  stream: ChatBox | null;
  dm: ChatBox | null;
  dmWindow: DmWindow | null;
}

const EMPTY: ChatLayout = { stream: null, dm: null, dmWindow: null };

const storedChatLayoutAtom = atomWithStorage<unknown>('settings.chatLayout.v1', EMPTY, undefined, { getOnInit: true });

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function validBox(raw: unknown): ChatBox | null {
  if (!raw || typeof raw !== 'object') return null;
  const { x, y, w, h } = raw as Record<string, unknown>;
  if (!finite(x) || !finite(y) || !finite(w) || !finite(h) || w <= 0 || h <= 0) return null;
  return { x, y, w, h };
}

function validDmWindow(raw: unknown): DmWindow | null {
  if (!raw || typeof raw !== 'object') return null;
  const { me, open, active } = raw as Record<string, unknown>;
  if (typeof me !== 'string' || !me) return null;
  return { me, open: open === true, active: typeof active === 'string' && active ? active : null };
}

/** Read: each part checked on its own, so one bad part does not lose the others. */
const chatLayoutAtom = atom((get): ChatLayout => {
  const raw = get(storedChatLayoutAtom);
  const kept = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return { stream: validBox(kept.stream), dm: validBox(kept.dm), dmWindow: validDmWindow(kept.dmWindow) };
});

function keep(part: Partial<ChatLayout>) {
  store.set(storedChatLayoutAtom, { ...store.get(chatLayoutAtom), ...part });
}

/** The stream chat's window as it was left; `null` for the default place. */
export const keptStreamBox = () => store.get(chatLayoutAtom).stream;
export const keepStreamBox = (box: ChatBox | null) => keep({ stream: box });

/** The friends' chat window as it was left; `null` for the default place. */
export const keptDmBox = () => store.get(chatLayoutAtom).dm;
export const keepDmBox = (box: ChatBox | null) => keep({ dm: box });

/** The friends' chat on screen and its tab, as `me` left them; `null` for another login, or none kept. */
export function keptDmWindow(me: string): DmWindow | null {
  const kept = store.get(chatLayoutAtom).dmWindow;
  return kept?.me === me ? kept : null;
}
export const keepDmWindow = (dmWindow: DmWindow) => keep({ dmWindow });
