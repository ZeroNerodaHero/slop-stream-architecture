export const DOCK_PANELS = ['sources', 'face', 'rig', 'thumbnail', 'sound'] as const;
export type DockPanel = (typeof DOCK_PANELS)[number];
export type DockTab = DockPanel | 'chat';

export interface LivePanels {
  sources: boolean;
  face: boolean;
  rig: boolean;
  thumbnail: boolean;
  sound: boolean;
  chat: boolean;
  dock: boolean;
}

export const PANEL_KEYS: readonly (keyof LivePanels)[] = [...DOCK_PANELS, 'chat', 'dock'];

export const DOCK_WORDS: Record<DockTab, string> = {
  sources: 'sources',
  face: 'face',
  rig: 'rigging',
  thumbnail: 'thumbnail',
  sound: 'sound',
  chat: 'chat'
};

export const SIDE_BY_SIDE_MIN = 1240;
export const CHAT_BESIDE_MIN = 1280;
export const CHAT_COLUMN = 352;

export function readPanels(raw: unknown): LivePanels {
  const p = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const open = {} as LivePanels;
  for (const key of PANEL_KEYS) open[key] = p[key] !== false;
  return open;
}

export function dockTabs(chatTab: boolean): DockTab[] {
  return chatTab ? [...DOCK_PANELS, 'chat'] : [...DOCK_PANELS];
}

export function readDockTab(raw: unknown, tabs: readonly DockTab[]): DockTab {
  return tabs.find((t) => t === raw) ?? tabs[0]!;
}

export function sideBySide(width: number): boolean {
  return width >= SIDE_BY_SIDE_MIN;
}

export function unreadAfter(lines: readonly { id: string; from: string }[], seen: string | null, me: string | null): number {
  if (seen === null) return 0;
  const at = lines.findIndex((line) => line.id === seen);
  let count = 0;
  for (let i = at + 1; i < lines.length; i++) if (lines[i]!.from !== me) count++;
  return count;
}

export function unreadWords(count: number): string {
  return count > 99 ? '99+' : String(count);
}
