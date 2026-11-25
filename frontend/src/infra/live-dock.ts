import { atom } from 'jotai';
import { atomWithStorage } from 'jotai/utils';

import { store } from './store.ts';

export const DOCK_PANELS = ['sources', 'face', 'rig', 'sound'] as const;
export type DockPanel = (typeof DOCK_PANELS)[number];
export type DockTab = DockPanel | 'chat';
export type ModuleId = DockTab;
export const MODULE_IDS: readonly ModuleId[] = [...DOCK_PANELS, 'chat'];
export type TileId = ModuleId | 'preview';
export const TILE_IDS: readonly TileId[] = ['preview', ...MODULE_IDS];

export interface LivePanels {
  sources: boolean;
  face: boolean;
  rig: boolean;
  sound: boolean;
  chat: boolean;
  thumbnail: boolean;
  hidden: ModuleId[];
}

export type FoldKey = Exclude<keyof LivePanels, 'hidden'>;
export const PANEL_KEYS: readonly FoldKey[] = [...DOCK_PANELS, 'chat', 'thumbnail'];

export const DOCK_WORDS: Record<TileId | 'thumbnail', string> = {
  preview: 'preview',
  sources: 'sources',
  face: 'face',
  rig: 'rigging',
  sound: 'sound',
  chat: 'chat',
  thumbnail: 'thumbnail'
};

export function readPanels(raw: unknown): LivePanels {
  const p = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const open = {} as LivePanels;
  for (const key of PANEL_KEYS) open[key] = p[key] !== false;
  open.hidden = Array.isArray(p.hidden) ? MODULE_IDS.filter((id) => (p.hidden as unknown[]).includes(id)) : [];
  return open;
}

export const LAYOUT_IDS = [1, 2, 3, 4, 5] as const;
export type LayoutId = (typeof LAYOUT_IDS)[number];

export const LAYOUT_WORDS: Record<LayoutId, string> = {
  1: 'obs left',
  2: 'obs right',
  3: 'bottom dock',
  4: 'split',
  5: 'custom'
};

export function readLayout(raw: unknown): LayoutId {
  return LAYOUT_IDS.find((id) => id === raw) ?? 1;
}

export type Place = 'column' | 'row' | 'under' | 'side' | 'tile' | 'phone';

export interface Arrangement {
  left: ModuleId[];
  right: ModuleId[];
  below: ModuleId[];
  under: ModuleId[];
  side: ModuleId[];
}

const ARRANGEMENTS: Record<Exclude<LayoutId, 5>, Arrangement> = {
  1: { left: ['sources', 'face', 'rig', 'sound'], right: [], below: [], under: ['chat'], side: [] },
  2: { left: [], right: ['sources', 'face', 'rig', 'sound'], below: [], under: ['chat'], side: [] },
  3: { left: [], right: [], below: ['sources', 'face', 'rig', 'sound'], under: [], side: ['chat'] },
  4: { left: ['sources', 'face'], right: [], below: ['rig', 'sound'], under: [], side: ['chat'] }
};

export function arrange(layout: Exclude<LayoutId, 5>, hidden: readonly ModuleId[], skip: readonly ModuleId[] = []): Arrangement {
  const keep = (ids: ModuleId[]) => ids.filter((id) => !hidden.includes(id) && !skip.includes(id));
  const a = ARRANGEMENTS[layout];
  return { left: keep(a.left), right: keep(a.right), below: keep(a.below), under: keep(a.under), side: keep(a.side) };
}

export function placeIn(arrangement: Arrangement, id: ModuleId): Place | null {
  if (arrangement.left.includes(id) || arrangement.right.includes(id)) return 'column';
  if (arrangement.below.includes(id)) return 'row';
  if (arrangement.under.includes(id)) return 'under';
  if (arrangement.side.includes(id)) return 'side';
  return null;
}

export const GRID_COLS = 12;
export const GRID_ROWS = 12;

export interface Cell {
  x: number;
  y: number;
  w: number;
  h: number;
}
export type Grid = Record<TileId, Cell>;

export const DEFAULT_GRID: Grid = {
  preview: { x: 0, y: 0, w: 8, h: 7 },
  chat: { x: 8, y: 0, w: 4, h: 7 },
  sources: { x: 0, y: 7, w: 3, h: 5 },
  face: { x: 3, y: 7, w: 3, h: 5 },
  rig: { x: 6, y: 7, w: 3, h: 5 },
  sound: { x: 9, y: 7, w: 3, h: 5 }
};

export const LAYOUT_GRIDS: Record<Exclude<LayoutId, 5>, Grid> = {
  1: {
    sources: { x: 0, y: 0, w: 3, h: 3 },
    face: { x: 0, y: 3, w: 3, h: 3 },
    rig: { x: 0, y: 6, w: 3, h: 3 },
    sound: { x: 0, y: 9, w: 3, h: 3 },
    preview: { x: 3, y: 0, w: 9, h: 8 },
    chat: { x: 3, y: 8, w: 9, h: 4 }
  },
  2: {
    preview: { x: 0, y: 0, w: 9, h: 8 },
    chat: { x: 0, y: 8, w: 9, h: 4 },
    sources: { x: 9, y: 0, w: 3, h: 3 },
    face: { x: 9, y: 3, w: 3, h: 3 },
    rig: { x: 9, y: 6, w: 3, h: 3 },
    sound: { x: 9, y: 9, w: 3, h: 3 }
  },
  3: {
    preview: { x: 0, y: 0, w: 9, h: 8 },
    chat: { x: 9, y: 0, w: 3, h: 12 },
    sources: { x: 0, y: 8, w: 3, h: 4 },
    face: { x: 3, y: 8, w: 2, h: 4 },
    rig: { x: 5, y: 8, w: 2, h: 4 },
    sound: { x: 7, y: 8, w: 2, h: 4 }
  },
  4: {
    sources: { x: 0, y: 0, w: 3, h: 6 },
    face: { x: 0, y: 6, w: 3, h: 6 },
    preview: { x: 3, y: 0, w: 6, h: 8 },
    rig: { x: 3, y: 8, w: 3, h: 4 },
    sound: { x: 6, y: 8, w: 3, h: 4 },
    chat: { x: 9, y: 0, w: 3, h: 12 }
  }
};

const MIN_CELL: Record<TileId, { w: number; h: number }> = {
  preview: { w: 3, h: 3 },
  sources: { w: 2, h: 2 },
  face: { w: 2, h: 2 },
  rig: { w: 2, h: 2 },
  sound: { w: 2, h: 2 },
  chat: { w: 2, h: 3 }
};

export function clampCell(id: TileId, cell: Cell): Cell {
  const min = MIN_CELL[id];
  const w = Math.max(min.w, Math.min(GRID_COLS, Math.round(cell.w)));
  const h = Math.max(min.h, Math.min(GRID_ROWS, Math.round(cell.h)));
  const x = Math.max(0, Math.min(GRID_COLS - w, Math.round(cell.x)));
  const y = Math.max(0, Math.min(GRID_ROWS - h, Math.round(cell.y)));
  return { x, y, w, h };
}

export function overlaps(a: Cell, b: Cell): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export function fits(grid: Grid, shown: readonly TileId[], id: TileId, cell: Cell): boolean {
  return shown.every((other) => other === id || !overlaps(cell, grid[other]));
}

export function readGrid(raw: unknown): Grid {
  const g = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const grid = {} as Grid;
  for (const id of TILE_IDS) {
    const c = g[id] as Partial<Cell> | undefined;
    const ok = c && [c.x, c.y, c.w, c.h].every((n) => typeof n === 'number' && Number.isFinite(n));
    grid[id] = ok ? clampCell(id, c as Cell) : DEFAULT_GRID[id];
  }
  return grid;
}

export function freeCell(grid: Grid, shown: readonly TileId[], id: TileId): Cell | null {
  const min = MIN_CELL[id];
  for (const [w, h] of [
    [4, 4],
    [3, 3],
    [min.w, min.h]
  ] as const) {
    for (let y = 0; y + h <= GRID_ROWS; y++)
      for (let x = 0; x + w <= GRID_COLS; x++) {
        const cell = { x, y, w, h };
        if (fits(grid, shown, id, cell)) return cell;
      }
  }
  return null;
}

export const PRESET_IDS = ['full', 'camera', 'sources', 'chat', 'safe', 'mine'] as const;
export type PresetId = (typeof PRESET_IDS)[number];
export const HOTKEY_PRESETS: readonly PresetId[] = ['full', 'camera', 'sources', 'chat', 'safe'];

export interface Preset {
  layout: LayoutId;
  panels: LivePanels;
}

const ALL_OPEN: LivePanels = { sources: true, face: true, rig: true, sound: true, chat: true, thumbnail: true, hidden: [] };

export const PRESETS: Record<Exclude<PresetId, 'mine'>, Preset> = {
  full: { layout: 1, panels: ALL_OPEN },
  camera: { layout: 1, panels: { ...ALL_OPEN, sources: false, sound: false } },
  sources: { layout: 1, panels: { ...ALL_OPEN, face: false, rig: false } },
  chat: { layout: 4, panels: { ...ALL_OPEN, hidden: ['sources', 'face', 'rig', 'sound'] } },
  safe: { layout: 1, panels: { ...ALL_OPEN, hidden: ['sources', 'face', 'rig', 'sound'] } }
};

export const PRESET_WORDS: Record<PresetId, { name: string; what: string }> = {
  full: { name: 'full edit', what: 'everything open' },
  camera: { name: 'camera only', what: 'face · rigging' },
  sources: { name: 'sources only', what: 'sources · sound' },
  chat: { name: 'chat focus', what: 'chat · preview' },
  safe: { name: 'live safe', what: 'start · chat, locked' },
  mine: { name: 'yours', what: 'saved by you' }
};

export function readPreset(raw: unknown): Preset | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  if (!LAYOUT_IDS.some((id) => id === p.layout)) return null;
  return { layout: readLayout(p.layout), panels: readPanels(p.panels) };
}

export function samePanels(a: LivePanels, b: LivePanels): boolean {
  return PANEL_KEYS.every((k) => k === 'thumbnail' || a[k] === b[k]) && a.hidden.length === b.hidden.length && a.hidden.every((id) => b.hidden.includes(id));
}

export function presetOf(layout: LayoutId, panels: LivePanels, mine: Preset | null): PresetId | null {
  for (const id of HOTKEY_PRESETS) {
    const p = PRESETS[id as Exclude<PresetId, 'mine'>];
    if (p.layout === layout && samePanels(p.panels, panels)) return id;
  }
  if (mine && mine.layout === layout && samePanels(mine.panels, panels)) return 'mine';
  return null;
}

export function presetForKey(key: string): PresetId | null {
  const n = Number(key);
  return Number.isInteger(n) && n >= 1 && n <= HOTKEY_PRESETS.length && key.length === 1 ? HOTKEY_PRESETS[n - 1]! : null;
}

export function typingInto(target: EventTarget | null): boolean {
  if (!target || typeof target !== 'object') return false;
  const el = target as { tagName?: string; isContentEditable?: boolean; closest?: (s: string) => unknown };
  if (el.isContentEditable) return true;
  const tag = (el.tagName ?? '').toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = ((target as { type?: string }).type ?? 'text').toLowerCase();
    return !['button', 'checkbox', 'radio', 'range', 'color', 'file', 'submit', 'reset', 'image'].includes(type);
  }
  return Boolean(el.closest?.('[contenteditable=""], [contenteditable="true"], [role="textbox"]'));
}

export type RailState = 'open' | 'shut' | null;
export const RAIL_OPEN_MIN = 1200;

export function readRail(raw: unknown): RailState {
  return raw === 'open' || raw === 'shut' ? raw : null;
}

export function railOpen(state: RailState, width: number): boolean {
  return state === null ? width >= RAIL_OPEN_MIN : state === 'open';
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

const json = { getOnInit: true } as const;
const storedPanelsAtom = atomWithStorage<unknown>('settings.livePanels', readPanels(null), undefined, json);
const storedLayoutAtom = atomWithStorage<unknown>('settings.liveLayout', 1, undefined, json);
const storedGridAtom = atomWithStorage<unknown>('settings.liveGrid', null, undefined, json);
const storedMineAtom = atomWithStorage<unknown>('settings.livePresetMine', null, undefined, json);
const storedRailAtom = atomWithStorage<unknown>('settings.liveRail', null, undefined, json);

export const livePanelsAtom = atom<LivePanels>((get) => readPanels(get(storedPanelsAtom)));
export const liveLayoutAtom = atom<LayoutId>((get) => readLayout(get(storedLayoutAtom)));
export const liveGridAtom = atom<Grid>((get) => readGrid(get(storedGridAtom)));
export const liveMineAtom = atom<Preset | null>((get) => readPreset(get(storedMineAtom)));
export const livePresetAtom = atom<PresetId | null>((get) => presetOf(get(liveLayoutAtom), get(livePanelsAtom), get(liveMineAtom)));
export const liveLockedAtom = atom((get) => get(livePresetAtom) === 'safe');
export const liveRailAtom = atom<RailState>((get) => readRail(get(storedRailAtom)));
export const liveEditingAtom = atom(false);

export function setLivePanel(name: FoldKey, open: boolean) {
  store.set(storedPanelsAtom, { ...store.get(livePanelsAtom), [name]: open });
}

export function setHidden(id: ModuleId, hidden: boolean) {
  const panels = store.get(livePanelsAtom);
  const rest = panels.hidden.filter((h) => h !== id);
  store.set(storedPanelsAtom, { ...panels, [id]: true, hidden: hidden ? [...rest, id] : rest });
}

export function setLayout(layout: LayoutId) {
  store.set(storedLayoutAtom, layout);
}

export function setGrid(grid: Grid) {
  store.set(storedGridAtom, grid);
}

export function setRail(open: boolean) {
  store.set(storedRailAtom, open ? 'open' : 'shut');
}

export function applyPreset(id: PresetId) {
  const p = id === 'mine' ? store.get(liveMineAtom) : PRESETS[id];
  if (!p) return;
  store.set(liveEditingAtom, false);
  store.set(storedLayoutAtom, p.layout);
  store.set(storedPanelsAtom, { ...p.panels, thumbnail: store.get(livePanelsAtom).thumbnail });
}

export function saveMine() {
  store.set(storedMineAtom, { layout: store.get(liveLayoutAtom), panels: store.get(livePanelsAtom) });
}

export function forgetMine() {
  store.set(storedMineAtom, null);
}

export function startEditing(from: LayoutId) {
  if (from !== 5) {
    const panels = store.get(livePanelsAtom);
    store.set(storedGridAtom, LAYOUT_GRIDS[from]);
    store.set(storedPanelsAtom, panels);
  }
  store.set(storedLayoutAtom, 5);
  store.set(liveEditingAtom, true);
}

export function stopEditing() {
  store.set(liveEditingAtom, false);
}

export function resetGrid() {
  store.set(storedGridAtom, DEFAULT_GRID);
  store.set(storedPanelsAtom, { ...store.get(livePanelsAtom), hidden: [] });
}

export function showInGrid(id: ModuleId): boolean {
  const grid = store.get(liveGridAtom);
  const panels = store.get(livePanelsAtom);
  const shown = TILE_IDS.filter((t) => t === 'preview' || !panels.hidden.includes(t));
  const cell = fits(grid, shown, id, grid[id]) ? grid[id] : freeCell(grid, shown, id);
  if (!cell) return false;
  store.set(storedGridAtom, { ...grid, [id]: cell });
  setHidden(id, false);
  return true;
}
