/**
 * The preferences this browser keeps (localstorage, like the nick): where the chat sits on a
 * page, where it sits on the corner player, which corner the you panel sits in, which lists
 * it shows in what order and which of them are folded, whether the bots' lines show, whether
 * the lines wear faces, the shape of the lines in a chat with a friend, whether a link asks
 * before it opens, the theme, and how big the pages are. Not part of the account: a
 * laptop and a phone can each have their own. Same shape as the other
 * atom modules: atoms for what renders, action functions to change it. The modal that edits
 * them is user-modal-atoms.ts.
 */

import { atom } from 'jotai';
import { atomWithStorage } from 'jotai/utils';

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

// ---- layout -------------------------------------------------------------------------------

/**
 * Where the chat sits on the watch page and the go live page: a column on the left, a column
 * on the right (the default), or in a window over the page. `below` used to be a choice; a
 * browser that still has it stored reads as `right`. The corner player's chat is the setting
 * below this one.
 */
export type ChatSide = 'left' | 'right' | 'modal';

export const CHAT_SIDES: readonly ChatSide[] = ['left', 'right', 'modal'];

const storedChatSideAtom = atomWithStorage<string>('settings.chatSide', 'right', undefined, { getOnInit: true });
/** Read: always one of CHAT_SIDES, whatever localstorage holds. */
export const chatSideAtom = atom((get) => {
  const side = get(storedChatSideAtom);
  return (CHAT_SIDES as readonly string[]).includes(side) ? (side as ChatSide) : 'right';
});

export function setChatSide(side: ChatSide) {
  store.set(storedChatSideAtom, side);
  // picking a place shows the chat there, so the page behind follows at once
  store.set(chatModalOpenAtom, true);
}

/**
 * The chat is showing, in whichever place the layout setting says. Not kept: a new visit starts
 * with it open, and closing it lasts the visit. A column slides shut; a window fades shut.
 */
export const chatModalOpenAtom = atom(true);

export function setChatModalOpen(open: boolean) {
  store.set(chatModalOpenAtom, open);
}

/**
 * Where the corner player's chat opens: under the picture (the default), or in a column on
 * its left or its right. The watch page's chat side is the setting above; this one is only
 * the picture in picture player.
 */
export type PipChatPlace = 'bottom' | 'left' | 'right';

export const PIP_CHAT_PLACES: readonly PipChatPlace[] = ['bottom', 'left', 'right'];

const storedPipChatPlaceAtom = atomWithStorage<string>('settings.pipChatPlace', 'bottom', undefined, { getOnInit: true });
/** Read: always one of PIP_CHAT_PLACES, whatever localstorage holds. */
export const pipChatPlaceAtom = atom((get) => {
  const place = get(storedPipChatPlaceAtom);
  return (PIP_CHAT_PLACES as readonly string[]).includes(place) ? (place as PipChatPlace) : 'bottom';
});

export function setPipChatPlace(place: PipChatPlace) {
  store.set(storedPipChatPlaceAtom, place);
}

/**
 * Which bottom corner the you panel sits in. Left, unless this browser says right. The corner
 * players stay on the right and lift when the panel joins them there.
 */
export type PanelSide = 'left' | 'right';

export const PANEL_SIDES: readonly PanelSide[] = ['left', 'right'];

const storedPanelSideAtom = atomWithStorage<string>('settings.panelSide', 'left', undefined, { getOnInit: true });
/** Read: always one of PANEL_SIDES, whatever localstorage holds. */
export const panelSideAtom = atom((get) => {
  const side = get(storedPanelSideAtom);
  return (PANEL_SIDES as readonly string[]).includes(side) ? (side as PanelSide) : 'left';
});

export function setPanelSide(side: PanelSide) {
  store.set(storedPanelSideAtom, side);
}

/**
 * The sidebar's lists (docs/follows.md): friends (they follow you back), the rest of who you
 * follow, and the groups you are in. Which of them the column shows, and in what order top to
 * bottom, is this browser's: the sidebar tab drags them into an order and switches each on or
 * off. One stays on, whatever is asked.
 */
export type SidebarList = 'friends' | 'following' | 'groups';

export const SIDEBAR_LISTS: readonly SidebarList[] = ['friends', 'following', 'groups'];

export interface SidebarListChoice {
  list: SidebarList;
  on: boolean;
}

const DEFAULT_SIDEBAR_LISTS: readonly SidebarListChoice[] = SIDEBAR_LISTS.map((list) => ({ list, on: true }));

const storedSidebarListsAtom = atomWithStorage<unknown>('settings.sidebarLists', DEFAULT_SIDEBAR_LISTS, undefined, { getOnInit: true });
/** Read: every list once, in the kept order, each on or off, at least one on; whatever localstorage holds. */
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
  // a list the kept order does not name (a browser from before it existed): at the end, on
  for (const list of SIDEBAR_LISTS) if (!seen.has(list)) out.push({ list, on: true });
  // none on: the first is, so the column is never empty by setting
  return out.some((c) => c.on) ? out : out.map((c, i) => (i === 0 ? { ...c, on: true } : c));
}

/** The list named, moved to that place in the order (0 is the top). The others keep their order around it. */
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

/** One list on or off. Off is refused for the last one on. */
export function setSidebarListOn(list: SidebarList, on: boolean) {
  const current = store.get(sidebarListsAtom);
  if (!on && current.filter((c) => c.on).length <= 1 && current.some((c) => c.list === list && c.on)) return;
  store.set(
    storedSidebarListsAtom,
    current.map((c) => (c.list === list ? { ...c, on } : c))
  );
}

/**
 * How the sidebar's rows are shared when the lists shown are longer than the room together
 * (docs/follows.md): a weight per list, equal to start, so two lists split the rows half and
 * half (30 rows: 15 and 15) and three in thirds; a list shorter than its share takes what it
 * has, and the rows it leaves go to the others by the same weights. Dragging the line between
 * two lists moves a row from one to the other, and the weights are then kept as the rows
 * stood, as fractions of the room, so a taller window keeps the proportion.
 */
export type SidebarShares = Record<SidebarList, number>;

const DEFAULT_SIDEBAR_SHARES: SidebarShares = { friends: 1, following: 1, groups: 1 };

const storedSidebarSharesAtom = atomWithStorage<unknown>('settings.sidebarShares', DEFAULT_SIDEBAR_SHARES, undefined, { getOnInit: true });
/** Read: a positive number per list, whatever localstorage holds. */
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

/** The weights given, over the kept ones. */
export function setSidebarShares(shares: Partial<SidebarShares>) {
  store.set(storedSidebarSharesAtom, { ...store.get(sidebarSharesAtom), ...shares });
}

/**
 * Which of the sidebar's lists are folded to their icon line (docs/follows.md): the caret before
 * each icon, while the panel is open, folds that list and unfolds it. Folded, the icon keeps its
 * place in the stack and the word its count, and the rows under it go to the other lists. This
 * browser's; none folded to start.
 */
export type SidebarFolds = Record<SidebarList, boolean>;

const DEFAULT_SIDEBAR_FOLDS: SidebarFolds = { friends: false, following: false, groups: false };

const storedSidebarFoldsAtom = atomWithStorage<unknown>('settings.sidebarFolds', DEFAULT_SIDEBAR_FOLDS, undefined, { getOnInit: true });
/** Read: a boolean per list, whatever localstorage holds. Anything but a stored `true` is unfolded. */
export const sidebarFoldsAtom = atom((get): SidebarFolds => {
  const raw = get(storedSidebarFoldsAtom);
  const kept = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out = { ...DEFAULT_SIDEBAR_FOLDS };
  for (const list of SIDEBAR_LISTS) out[list] = kept[list] === true;
  return out;
});

/** One list folded or unfolded. */
export function setSidebarFolded(list: SidebarList, folded: boolean) {
  store.set(storedSidebarFoldsAtom, { ...store.get(sidebarFoldsAtom), [list]: folded });
}

// ---- debugging -------------------------------------------------------------------------------

/** The messages inspector (docs/status.md): the frames this browser gets, in the browser. Off, it costs one boolean per frame. */
const storedInspectorAtom = atomWithStorage<unknown>('settings.inspector', false, undefined, { getOnInit: true });
/** Read: a boolean, whatever localstorage holds. */
export const inspectorEnabledAtom = atom((get) => get(storedInspectorAtom) === true);

export function setInspectorEnabled(on: boolean) {
  store.set(storedInspectorAtom, on);
}

// ---- chat ----------------------------------------------------------------------------------

/**
 * Lines said by bots (the `bot` group: the fake streams' chatters, and any socket that says it
 * is one) are kept off the screen. The chat header has the switch too; both move this.
 */
const storedHideBotsAtom = atomWithStorage<unknown>('settings.hideBots', false, undefined, { getOnInit: true });
/** Read: a boolean, whatever localstorage holds. */
export const hideBotsAtom = atom((get) => get(storedHideBotsAtom) === true);

export function setHideBots(hide: boolean) {
  store.set(storedHideBotsAtom, hide);
}

/**
 * Each line starts with its speaker's face: the picture of a login or of the streamer, else
 * the letter the name makes (the stand-in every list uses, GeneratedAvatar.tsx). On unless
 * this browser turned it off; off, a line is the name and the words alone.
 */
const storedChatFacesAtom = atomWithStorage<unknown>('settings.chatFaces', true, undefined, { getOnInit: true });
/** Read: a boolean, whatever localstorage holds. Anything but a stored `false` is on. */
export const chatFacesAtom = atom((get) => get(storedChatFacesAtom) !== false);

export function setChatFaces(on: boolean) {
  store.set(storedChatFacesAtom, on);
}

/**
 * The shape of the lines in a chat with a friend, the chat window's (docs/dms.md,
 * FriendChat.tsx). `log`: one line each, the time, the name, then the words, nothing offset,
 * the most lines on screen. `bubbles` (the default): each line in a box of its own, yours on
 * the right and theirs on the left, no names (the sides say who). `blocks`: the face, the name
 * and the time over the words, and one person's lines in a row under one head. The room chat
 * is not this: its lines have one shape (docs/chat.md).
 */
export type DmStyle = 'log' | 'bubbles' | 'blocks';

export const DM_STYLES: readonly DmStyle[] = ['log', 'bubbles', 'blocks'];

const storedDmStyleAtom = atomWithStorage<string>('settings.dmStyle', 'bubbles', undefined, { getOnInit: true });
/** Read: always one of DM_STYLES, whatever localstorage holds. */
export const dmStyleAtom = atom((get) => {
  const style = get(storedDmStyleAtom);
  return (DM_STYLES as readonly string[]).includes(style) ? (style as DmStyle) : 'bubbles';
});

export function setDmStyle(style: DmStyle) {
  store.set(storedDmStyleAtom, style);
}

/**
 * A link somebody put in a line (the chat's, a direct message's) is drawn as one and opens in
 * a new tab; first, a word that you are leaving this site for that one (LinkedText.tsx). On
 * unless this browser turned it off: the links block of the chat tab, or `don't ask again` on
 * the word itself, which is this same switch.
 */
const storedLinkWarningAtom = atomWithStorage<unknown>('settings.linkWarning', true, undefined, { getOnInit: true });
/** Read: a boolean, whatever localstorage holds. Anything but a stored `false` is on. */
export const linkWarningAtom = atom((get) => get(storedLinkWarningAtom) !== false);

export function setLinkWarning(on: boolean) {
  store.set(storedLinkWarningAtom, on);
}

// ---- theme ---------------------------------------------------------------------------------

/** Three colours of their own (text null: derived from the background). */
export interface CustomTheme {
  kind: 'custom';
  background: string;
  accent: string;
  text: string | null;
}
/** A preset by name, or colours of their own. */
export type ThemeChoice = { kind: 'preset'; name: PresetName } | CustomTheme;

const DEFAULT_THEME: ThemeChoice = { kind: 'preset', name: 'dark' };
/** Where the derived variables are kept for the inline script in index.html, which applies them before first paint. */
const THEME_VARS_KEY = 'settings.themeVars';

const storedThemeAtom = atomWithStorage<unknown>('settings.theme', DEFAULT_THEME, undefined, { getOnInit: true });

/** Read: always a well-formed choice, whatever localstorage holds. */
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

/** The twelve colours the choice comes to. */
export function paletteOf(choice: ThemeChoice): Palette {
  if (choice.kind === 'preset') return PRESETS[choice.name];
  return derivePalette({
    background: fromHex(choice.background),
    accent: fromHex(choice.accent),
    text: choice.text === null ? undefined : fromHex(choice.text)
  });
}

/** What is on screen now. */
export const paletteAtom = atom((get) => paletteOf(get(themeAtom)));

export function setTheme(choice: ThemeChoice) {
  store.set(storedThemeAtom, choice);
}

/** The custom colours, kept as they are typed; the page follows at once. */
export function setCustomColor(slot: 'background' | 'accent' | 'text', value: string | null) {
  const current = store.get(themeAtom);
  const base: CustomTheme = current.kind === 'custom' ? current : customFrom(paletteOf(current));
  if (slot === 'text') setTheme({ ...base, text: value });
  else if (isHex(value)) setTheme({ ...base, [slot]: value });
}

/** A custom choice that starts where a palette is: its background and accent, the text left to derive. */
export function customFrom(p: Palette): CustomTheme {
  return { kind: 'custom', background: hex(p.background), accent: hex(p.primaryColor), text: null };
}

/**
 * The choice onto the document. The dark preset is the stylesheet itself, so it clears the
 * inline variables and the kept copy; everything else is written inline and kept under
 * THEME_VARS_KEY for the inline script in index.html, so the next load paints right first time.
 */
function applyTheme(choice: ThemeChoice) {
  applyThemeTo(document.documentElement);
  if (choice.kind === 'preset' && choice.name === 'dark') {
    try {
      localStorage.removeItem(THEME_VARS_KEY);
    } catch {
      // private mode: the inline script has nothing to read either, which is fine
    }
    return;
  }
  const palette = paletteOf(choice);
  try {
    localStorage.setItem(THEME_VARS_KEY, JSON.stringify({ vars: toCssVars(palette), scheme: schemeOf(palette) }));
  } catch {
    // same
  }
}

/**
 * The choice onto a document's <html>: this page's, and the popped out player's window
 * (infra/popout.ts), which has a document of its own and is dressed as this one.
 */
export function applyThemeTo(root: HTMLElement) {
  const choice = store.get(themeAtom);
  if (choice.kind === 'preset' && choice.name === 'dark') clearPalette(root);
  else applyPalette(paletteOf(choice), root);
}

// one subscriber for the life of the page: every change of the choice reaches the document,
// this tab's and (through localstorage's `storage` event, which the subscription is what
// installs) another tab's. main.tsx calls applyStoredTheme once before rendering.
store.sub(themeAtom, () => applyTheme(store.get(themeAtom)));

export function applyStoredTheme() {
  applyTheme(store.get(themeAtom));
}

// ---- size ----------------------------------------------------------------------------------

/**
 * How big the pages are: the root font size, as a percentage of the browser's own. Every
 * measure in the stylesheet is in rems (the words, the padding, the gaps, the columns; the body's
 * 20px is 1.25rem in globals.css), so a step down here is a step down for the whole page, the way
 * the browser's zoom is, kept here and for this site alone. 100 is the browser's size, the
 * default, and sets nothing; the browser's own zoom works on top of any of them.
 */
export type TextSize = 80 | 90 | 100 | 110 | 125;

/** The inline script in index.html holds this list too (less 100) and paints a kept size before the bundle runs; change both together. */
export const TEXT_SIZES: readonly TextSize[] = [80, 90, 100, 110, 125];

const storedTextSizeAtom = atomWithStorage<unknown>('settings.textSize', 100, undefined, { getOnInit: true });
/** Read: always one of TEXT_SIZES, whatever localstorage holds. */
export const textSizeAtom = atom((get): TextSize => {
  const size = get(storedTextSizeAtom);
  return (TEXT_SIZES as readonly unknown[]).includes(size) ? (size as TextSize) : 100;
});

export function setTextSize(size: TextSize) {
  store.set(storedTextSizeAtom, size);
}

/**
 * The choice onto a document's <html>: this page's, and the popped out player's window
 * (infra/popout.ts), dressed as this one. 100 clears it: the stylesheet is the browser's size.
 * The inline script in index.html reads the same key and does the same before first paint.
 */
export function applyTextSizeTo(root: HTMLElement) {
  const size = store.get(textSizeAtom);
  if (size === 100) root.style.removeProperty('font-size');
  else root.style.fontSize = `${size}%`;
}

// the theme's subscriber, for the size: this tab's changes and another tab's alike
store.sub(textSizeAtom, () => applyTextSizeTo(document.documentElement));

export function applyStoredTextSize() {
  applyTextSizeTo(document.documentElement);
}
