/**
 * The preferences this browser keeps (localstorage, like the nick): where the chat sits,
 * whether the bots' lines show, and the theme. Not part of the account: a laptop and a phone
 * can each have their own. Same shape as the other atom modules: atoms for what renders,
 * action functions to change it. The modal that edits them is user-modal-atoms.ts.
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

/** Where the chat sits next to a stream: at its right (the default), or under it. */
export type ChatSide = 'right' | 'below';

export const CHAT_SIDES: readonly ChatSide[] = ['right', 'below'];

const storedChatSideAtom = atomWithStorage<string>('settings.chatSide', 'right', undefined, { getOnInit: true });
/** Read: always one of CHAT_SIDES, whatever localstorage holds. */
export const chatSideAtom = atom((get) => {
  const side = get(storedChatSideAtom);
  return (CHAT_SIDES as readonly string[]).includes(side) ? (side as ChatSide) : 'right';
});

export function setChatSide(side: ChatSide) {
  store.set(storedChatSideAtom, side);
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
  if (choice.kind === 'preset' && choice.name === 'dark') {
    clearPalette();
    try {
      localStorage.removeItem(THEME_VARS_KEY);
    } catch {
      // private mode: the inline script has nothing to read either, which is fine
    }
    return;
  }
  const palette = paletteOf(choice);
  applyPalette(palette);
  try {
    localStorage.setItem(THEME_VARS_KEY, JSON.stringify({ vars: toCssVars(palette), scheme: schemeOf(palette) }));
  } catch {
    // same
  }
}

// one subscriber for the life of the page: every change of the choice reaches the document,
// this tab's and (through localstorage's `storage` event, which the subscription is what
// installs) another tab's. main.tsx calls applyStoredTheme once before rendering.
store.sub(themeAtom, () => applyTheme(store.get(themeAtom)));

export function applyStoredTheme() {
  applyTheme(store.get(themeAtom));
}
