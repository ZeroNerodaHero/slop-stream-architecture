export type WindowId = 'messages' | 'timings' | 'quality';
export type WindowsOpen = Record<WindowId, boolean>;

export const WINDOWS_KEY = 'settings.debugWindows';
export const WINDOW_IDS: readonly WindowId[] = ['messages', 'timings', 'quality'];

export const pick = <T>(f: (id: WindowId) => T) => Object.fromEntries(WINDOW_IDS.map((id) => [id, f(id)])) as Record<WindowId, T>;

export function parseWindows(raw: string | null): WindowsOpen {
  let v: Partial<Record<WindowId, unknown>> | null = null;
  try {
    v = JSON.parse(raw ?? '');
  } catch {
  }
  return pick((id) => v?.[id] === true);
}

export const serialize = (open: WindowsOpen): string => JSON.stringify(open);

export const restoreOpen = (stored: WindowsOpen, switches: WindowsOpen): WindowsOpen => pick((id) => stored[id] && switches[id]);
