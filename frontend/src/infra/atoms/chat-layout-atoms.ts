import { atom } from 'jotai';
import { atomWithStorage } from 'jotai/utils';

import { store } from '@/infra/store';

export interface ChatBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

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

const chatLayoutAtom = atom((get): ChatLayout => {
  const raw = get(storedChatLayoutAtom);
  const kept = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return { stream: validBox(kept.stream), dm: validBox(kept.dm), dmWindow: validDmWindow(kept.dmWindow) };
});

function keep(part: Partial<ChatLayout>) {
  store.set(storedChatLayoutAtom, { ...store.get(chatLayoutAtom), ...part });
}

export const keptStreamBox = () => store.get(chatLayoutAtom).stream;
export const keepStreamBox = (box: ChatBox | null) => keep({ stream: box });

export const keptDmBox = () => store.get(chatLayoutAtom).dm;
export const keepDmBox = (box: ChatBox | null) => keep({ dm: box });

export function keptDmWindow(me: string): DmWindow | null {
  const kept = store.get(chatLayoutAtom).dmWindow;
  return kept?.me === me ? kept : null;
}
export const keepDmWindow = (dmWindow: DmWindow) => keep({ dmWindow });
