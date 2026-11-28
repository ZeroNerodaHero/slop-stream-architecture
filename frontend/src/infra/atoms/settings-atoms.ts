import { atom } from 'jotai';
import { atomWithStorage } from 'jotai/utils';

import { DEBUG_KEYS, migrateDebugSettings, PERF_KEY, type PerfMode, perfModeOf } from '@/infra/debug-flag';
import { applyShapeTo, DEFAULT_SHAPE, type Shape, shapeOf } from '@/infra/shape';
import { store } from '@/infra/store';
import {
  applyPalette,
  clearPalette,
  derivePalette,
  fromHex,
  hex,
  isHex,
  type Palette,
  PRESET_NAMES,
  PRESETS,
  type PresetName,
  schemeOf,
  toCssVars
} from '@/infra/theme';

export const restreamDirectAtom = atomWithStorage<boolean>('settings.restreamDirect', true, undefined, { getOnInit: true });
export const setRestreamDirect = (on: boolean) => store.set(restreamDirectAtom, on);

export type ChatSide = 'left' | 'right' | 'modal';

export const CHAT_SIDES: readonly ChatSide[] = ['left', 'right', 'modal'];

const storedChatSideAtom = atomWithStorage<string>('settings.chatSide', 'right', undefined, { getOnInit: true });
export const chatSideAtom = atom((get) => {
  const side = get(storedChatSideAtom);
  return (CHAT_SIDES as readonly string[]).includes(side) ? (side as ChatSide) : 'right';
});

export function setChatSide(side: ChatSide) {
  store.set(storedChatSideAtom, side);
  store.set(chatModalOpenAtom, true);
}

export const chatModalOpenAtom = atom(true);

export function setChatModalOpen(open: boolean) {
  store.set(chatModalOpenAtom, open);
}

const storedChatClearAtom = atomWithStorage<unknown>('settings.chatClear', true, undefined, { getOnInit: true });
export const chatClearAtom = atom((get) => get(storedChatClearAtom) !== false);

export function setChatClear(clear: boolean) {
  store.set(storedChatClearAtom, clear);
}

export type PipChatPlace = 'bottom' | 'left' | 'right';

export const PIP_CHAT_PLACES: readonly PipChatPlace[] = ['bottom', 'left', 'right'];

const storedPipChatPlaceAtom = atomWithStorage<string>('settings.pipChatPlace', 'bottom', undefined, { getOnInit: true });
export const pipChatPlaceAtom = atom((get) => {
  const place = get(storedPipChatPlaceAtom);
  return (PIP_CHAT_PLACES as readonly string[]).includes(place) ? (place as PipChatPlace) : 'bottom';
});

export function setPipChatPlace(place: PipChatPlace) {
  store.set(storedPipChatPlaceAtom, place);
}

export type PanelSide = 'left' | 'right';

export const PANEL_SIDES: readonly PanelSide[] = ['left', 'right'];

const storedPanelSideAtom = atomWithStorage<string>('settings.panelSide', 'left', undefined, { getOnInit: true });
export const panelSideAtom = atom((get) => {
  const side = get(storedPanelSideAtom);
  return (PANEL_SIDES as readonly string[]).includes(side) ? (side as PanelSide) : 'left';
});

export function setPanelSide(side: PanelSide) {
  store.set(storedPanelSideAtom, side);
}

export type SidebarList = 'friends' | 'following' | 'groups';

export const SIDEBAR_LISTS: readonly SidebarList[] = ['friends', 'following', 'groups'];

export interface SidebarListChoice {
  list: SidebarList;
  on: boolean;
}

const DEFAULT_SIDEBAR_LISTS: readonly SidebarListChoice[] = SIDEBAR_LISTS.map((list) => ({ list, on: true }));

const storedSidebarListsAtom = atomWithStorage<unknown>('settings.sidebarLists', DEFAULT_SIDEBAR_LISTS, undefined, { getOnInit: true });
export const sidebarListsAtom = atom((get) => validSidebarLists(get(storedSidebarListsAtom)));

function validSidebarLists(raw: unknown): SidebarListChoice[] {
  const out: SidebarListChoice[] = [];
  const seen = new Set<SidebarList>();
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!item || typeof item !== 'object') continue;
    const { list, on } = item as Record<string, unknown>;
    if (typeof list !== 'string' || !(SIDEBAR_LISTS as readonly string[]).includes(list) || seen.has(list as SidebarList)) continue;
    seen.add(list as SidebarList);
    out.push({ list: list as SidebarList, on: on !== false });
  }
  for (const list of SIDEBAR_LISTS) if (!seen.has(list)) out.push({ list, on: true });
  return out.some((c) => c.on) ? out : out.map((c, i) => (i === 0 ? { ...c, on: true } : c));
}

export function moveSidebarList(list: SidebarList, to: number) {
  const current = store.get(sidebarListsAtom);
  const from = current.findIndex((c) => c.list === list);
  const at = Math.min(current.length - 1, Math.max(0, to));
  if (from < 0 || from === at) return;
  const next = [...current];
  const [moved] = next.splice(from, 1);
  if (moved) next.splice(at, 0, moved);
  store.set(storedSidebarListsAtom, next);
}

export function setSidebarListOn(list: SidebarList, on: boolean) {
  const current = store.get(sidebarListsAtom);
  if (!on && current.filter((c) => c.on).length <= 1 && current.some((c) => c.list === list && c.on)) return;
  store.set(
    storedSidebarListsAtom,
    current.map((c) => (c.list === list ? { ...c, on } : c))
  );
}

export type SidebarShares = Record<SidebarList, number>;

const DEFAULT_SIDEBAR_SHARES: SidebarShares = { friends: 1, following: 1, groups: 1 };

const storedSidebarSharesAtom = atomWithStorage<unknown>('settings.sidebarShares', DEFAULT_SIDEBAR_SHARES, undefined, { getOnInit: true });
export const sidebarSharesAtom = atom((get): SidebarShares => {
  const raw = get(storedSidebarSharesAtom);
  const kept = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out = { ...DEFAULT_SIDEBAR_SHARES };
  for (const list of SIDEBAR_LISTS) {
    const w = kept[list];
    if (typeof w === 'number' && Number.isFinite(w) && w > 0) out[list] = w;
  }
  return out;
});

export function setSidebarShares(shares: Partial<SidebarShares>) {
  store.set(storedSidebarSharesAtom, { ...store.get(sidebarSharesAtom), ...shares });
}

export type SidebarFolds = Record<SidebarList, boolean>;

const DEFAULT_SIDEBAR_FOLDS: SidebarFolds = { friends: false, following: false, groups: false };

const storedSidebarFoldsAtom = atomWithStorage<unknown>('settings.sidebarFolds', DEFAULT_SIDEBAR_FOLDS, undefined, { getOnInit: true });
export const sidebarFoldsAtom = atom((get): SidebarFolds => {
  const raw = get(storedSidebarFoldsAtom);
  const kept = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out = { ...DEFAULT_SIDEBAR_FOLDS };
  for (const list of SIDEBAR_LISTS) out[list] = kept[list] === true;
  return out;
});

export function setSidebarFolded(list: SidebarList, folded: boolean) {
  store.set(storedSidebarFoldsAtom, { ...store.get(sidebarFoldsAtom), [list]: folded });
}

export const roomMembersOpenAtom = atomWithStorage('settings.roomMembersOpen', true, undefined, { getOnInit: true });

try {
  migrateDebugSettings(localStorage);
} catch {
}

const storedMessagesAtom = atomWithStorage<unknown>(DEBUG_KEYS.messages, false, undefined, { getOnInit: true });
export const messagesEnabledAtom = atom((get) => get(storedMessagesAtom) === true);

export function setMessagesEnabled(on: boolean) {
  store.set(storedMessagesAtom, on);
}

const storedTimingsAtom = atomWithStorage<unknown>(DEBUG_KEYS.timings, false, undefined, { getOnInit: true });
export const timingsEnabledAtom = atom((get) => get(storedTimingsAtom) === true);

export function setTimingsEnabled(on: boolean) {
  store.set(storedTimingsAtom, on);
}

const storedQualityAtom = atomWithStorage<unknown>(DEBUG_KEYS.quality, false, undefined, { getOnInit: true });
export const qualityEnabledAtom = atom((get) => get(storedQualityAtom) === true);

export function setQualityEnabled(on: boolean) {
  store.set(storedQualityAtom, on);
}

const storedPerfAtom = atomWithStorage<unknown>(PERF_KEY, 'off', undefined, { getOnInit: true });
export const perfModeAtom = atom((get) => perfModeOf(get(storedPerfAtom)));

export function setPerfMode(mode: PerfMode) {
  store.set(storedPerfAtom, mode);
}

const storedHideBotsAtom = atomWithStorage<unknown>('settings.hideBots', false, undefined, { getOnInit: true });
export const hideBotsAtom = atom((get) => get(storedHideBotsAtom) === true);

export function setHideBots(hide: boolean) {
  store.set(storedHideBotsAtom, hide);
}

export type ChatStyle = 'log' | 'bubbles' | 'blocks';

export const CHAT_STYLES: readonly ChatStyle[] = ['log', 'bubbles', 'blocks'];

const storedChatStyleAtom = atomWithStorage<string>('settings.chatStyle', 'bubbles', undefined, { getOnInit: true });
export const chatStyleAtom = atom((get) => {
  const style = get(storedChatStyleAtom);
  return (CHAT_STYLES as readonly string[]).includes(style) ? (style as ChatStyle) : 'bubbles';
});

export function setChatStyle(style: ChatStyle) {
  store.set(storedChatStyleAtom, style);
}

const storedLinkWarningAtom = atomWithStorage<unknown>('settings.linkWarning', true, undefined, { getOnInit: true });
export const linkWarningAtom = atom((get) => get(storedLinkWarningAtom) !== false);

export function setLinkWarning(on: boolean) {
  store.set(storedLinkWarningAtom, on);
}

const storedShowEmbedsAtom = atomWithStorage<unknown>('settings.showEmbeds', true, undefined, { getOnInit: true });
export const showEmbedsAtom = atom((get) => get(storedShowEmbedsAtom) !== false);

export function setShowEmbeds(on: boolean) {
  store.set(storedShowEmbedsAtom, on);
}

const storedProfilePopupAtom = atomWithStorage<unknown>('settings.profilePopup', true, undefined, { getOnInit: true });
export const profilePopupEnabledAtom = atom((get) => get(storedProfilePopupAtom) !== false);

export function setProfilePopupEnabled(on: boolean) {
  store.set(storedProfilePopupAtom, on);
}

export interface CustomTheme {
  kind: 'custom';
  background: string;
  accent: string;
  text: string | null;
}
export type ThemeChoice = { kind: 'preset'; name: PresetName } | CustomTheme;

const DEFAULT_THEME: ThemeChoice = { kind: 'preset', name: 'dark' };
const THEME_VARS_KEY = 'settings.themeVars';

const storedThemeAtom = atomWithStorage<unknown>('settings.theme', DEFAULT_THEME, undefined, { getOnInit: true });

export const themeAtom = atom<ThemeChoice>((get) => validTheme(get(storedThemeAtom)));

function validTheme(raw: unknown): ThemeChoice {
  if (!raw || typeof raw !== 'object') return DEFAULT_THEME;
  const t = raw as Record<string, unknown>;
  if (t.kind === 'preset' && typeof t.name === 'string' && (PRESET_NAMES as string[]).includes(t.name)) {
    return { kind: 'preset', name: t.name as PresetName };
  }
  if (t.kind === 'custom' && isHex(t.background) && isHex(t.accent) && (t.text === null || isHex(t.text))) {
    return { kind: 'custom', background: t.background, accent: t.accent, text: t.text };
  }
  return DEFAULT_THEME;
}

export function paletteOf(choice: ThemeChoice): Palette {
  if (choice.kind === 'preset') return PRESETS[choice.name];
  return derivePalette({
    background: fromHex(choice.background),
    accent: fromHex(choice.accent),
    text: choice.text === null ? undefined : fromHex(choice.text)
  });
}

export const paletteAtom = atom((get) => paletteOf(get(themeAtom)));

export function setTheme(choice: ThemeChoice) {
  store.set(storedThemeAtom, choice);
}

export function setCustomColor(slot: 'background' | 'accent' | 'text', value: string | null) {
  const current = store.get(themeAtom);
  const base: CustomTheme = current.kind === 'custom' ? current : customFrom(paletteOf(current));
  if (slot === 'text') setTheme({ ...base, text: value });
  else if (isHex(value)) setTheme({ ...base, [slot]: value });
}

export function customFrom(p: Palette): CustomTheme {
  return { kind: 'custom', background: hex(p.background), accent: hex(p.primaryColor), text: null };
}

function applyTheme(choice: ThemeChoice) {
  applyThemeTo(document.documentElement);
  if (choice.kind === 'preset' && choice.name === 'dark') {
    try {
      localStorage.removeItem(THEME_VARS_KEY);
    } catch {
    }
    return;
  }
  const palette = paletteOf(choice);
  try {
    localStorage.setItem(THEME_VARS_KEY, JSON.stringify({ vars: toCssVars(palette), scheme: schemeOf(palette) }));
  } catch {
  }
}

export function applyThemeTo(root: HTMLElement) {
  const choice = store.get(themeAtom);
  if (choice.kind === 'preset' && choice.name === 'dark') clearPalette(root);
  else applyPalette(paletteOf(choice), root);
}

store.sub(themeAtom, () => applyTheme(store.get(themeAtom)));

export function applyStoredTheme() {
  applyTheme(store.get(themeAtom));
}

export { SHAPES, type Shape } from '@/infra/shape';

const storedShapeAtom = atomWithStorage<unknown>('settings.shape', DEFAULT_SHAPE, undefined, { getOnInit: true });
export const shapeAtom = atom((get): Shape => shapeOf(get(storedShapeAtom)));

export function setShape(shape: Shape) {
  store.set(storedShapeAtom, shape);
}

export function applyShapeOf(root: HTMLElement) {
  applyShapeTo(root, store.get(shapeAtom));
}

store.sub(shapeAtom, () => applyShapeOf(document.documentElement));

export function applyStoredShape() {
  applyShapeOf(document.documentElement);
}

export type TextSize = 80 | 90 | 100 | 110 | 125;

export const TEXT_SIZES: readonly TextSize[] = [80, 90, 100, 110, 125];

const storedTextSizeAtom = atomWithStorage<unknown>('settings.textSize', 100, undefined, { getOnInit: true });
export const textSizeAtom = atom((get): TextSize => {
  const size = get(storedTextSizeAtom);
  return (TEXT_SIZES as readonly unknown[]).includes(size) ? (size as TextSize) : 100;
});

export function setTextSize(size: TextSize) {
  store.set(storedTextSizeAtom, size);
}

export function applyTextSizeTo(root: HTMLElement) {
  const size = store.get(textSizeAtom);
  if (size === 100) root.style.removeProperty('font-size');
  else root.style.fontSize = `${size}%`;
}

store.sub(textSizeAtom, () => applyTextSizeTo(document.documentElement));

export function applyStoredTextSize() {
  applyTextSizeTo(document.documentElement);
}
