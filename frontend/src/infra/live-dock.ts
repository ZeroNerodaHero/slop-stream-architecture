import { atom } from 'jotai';
import { atomWithStorage, RESET } from 'jotai/utils';

import { readStage, type Stage } from './stage.ts';
import { store } from './store.ts';

export const DOCK_PANELS = ['sources', 'source', 'sound'] as const;
const LEGACY_SOURCE = ['face', 'rig'] as const;
export type DockPanel = (typeof DOCK_PANELS)[number];
export type DockTab = DockPanel | 'chat';
export type ModuleId = DockTab;
export const MODULE_IDS: readonly ModuleId[] = [...DOCK_PANELS, 'chat'];
export type TileId = ModuleId | 'preview';
export const TILE_IDS: readonly TileId[] = ['preview', ...MODULE_IDS];

export interface LivePanels {
  hidden: ModuleId[];
}

export const DOCK_WORDS: Record<TileId, string> = {
  preview: 'preview',
  sources: 'sources',
  source: 'source settings',
  sound: 'sound',
  chat: 'chat'
};

export function readPanels(raw: unknown): LivePanels {
  const p = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  if (!Array.isArray(p.hidden)) return { hidden: [] };
  const hidden = p.hidden as unknown[];
  const legacy = LEGACY_SOURCE.every((id) => hidden.includes(id));
  return { hidden: MODULE_IDS.filter((id) => hidden.includes(id) || (id === 'source' && legacy)) };
}

export const RAIL_SECTIONS = ['studio', 'layout', 'presets', 'thumbnail', 'destinations'] as const;
export type RailSection = (typeof RAIL_SECTIONS)[number];

export const RAIL_WORDS: Record<RailSection, string> = {
  studio: 'studio',
  layout: 'layout',
  presets: 'presets',
  thumbnail: 'thumbnail',
  destinations: 'destinations'
};

export const SLOT_IDS = ['c1', 'c2', 'c3', 'c4'] as const;
export type SlotId = (typeof SLOT_IDS)[number];
export const LAYOUT_IDS = ['obs', ...SLOT_IDS] as const;
export type LayoutId = (typeof LAYOUT_IDS)[number];

export const LAYOUT_WORDS: Record<LayoutId, string> = {
  obs: 'obs left',
  c1: 'custom 1',
  c2: 'custom 2',
  c3: 'custom 3',
  c4: 'custom 4'
};

export const LAYOUT_MARKS: Record<LayoutId, string> = {
  obs: '1',
  c1: 'c1',
  c2: 'c2',
  c3: 'c3',
  c4: 'c4'
};

export function isSlot(id: unknown): id is SlotId {
  return SLOT_IDS.some((slot) => slot === id);
}

export function readLayout(raw: unknown): LayoutId {
  return LAYOUT_IDS.find((id) => id === raw) ?? 'obs';
}

export type Place = 'column' | 'row' | 'under' | 'side' | 'tile' | 'phone';

export interface Arrangement {
  left: ModuleId[];
  right: ModuleId[];
  below: ModuleId[];
  under: ModuleId[];
  side: ModuleId[];
}

const OBS_LEFT: Arrangement = { left: ['sources', 'source', 'sound'], right: [], below: [], under: ['chat'], side: [] };

export function arrange(hidden: readonly ModuleId[], skip: readonly ModuleId[] = []): Arrangement {
  const keep = (ids: ModuleId[]) => ids.filter((id) => !hidden.includes(id) && !skip.includes(id));
  const a = OBS_LEFT;
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
  source: { x: 3, y: 7, w: 6, h: 5 },
  sound: { x: 9, y: 7, w: 3, h: 5 }
};

export const START_GRID: Grid = {
  chat: { x: 0, y: 0, w: 3, h: 4 },
  sources: { x: 3, y: 0, w: 3, h: 4 },
  source: { x: 6, y: 0, w: 3, h: 4 },
  sound: { x: 9, y: 0, w: 3, h: 4 },
  preview: { x: 0, y: 4, w: 12, h: 8 }
};

export type Slots = Record<SlotId, Grid | null>;

export function readSlots(raw: unknown): Slots {
  const s = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const slots = {} as Slots;
  for (const id of SLOT_IDS) slots[id] = s[id] && typeof s[id] === 'object' ? readGrid(s[id]) : null;
  return slots;
}

export function seedSlots(oldGrid: unknown, mine: unknown): Slots {
  const slots = readSlots(null);
  const m = mine && typeof mine === 'object' ? (mine as Record<string, unknown>) : {};
  const seed = oldGrid && typeof oldGrid === 'object' ? oldGrid : m.layout === 5 && m.grid && typeof m.grid === 'object' ? m.grid : null;
  if (seed) slots.c1 = readGrid(seed);
  return slots;
}

const MIN_CELL: Record<TileId, { w: number; h: number }> = {
  preview: { w: 3, h: 3 },
  sources: { w: 2, h: 2 },
  source: { w: 2, h: 2 },
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

function cellOf(raw: unknown): Cell | null {
  const c = raw as Partial<Cell> | undefined;
  return c && [c.x, c.y, c.w, c.h].every((n) => typeof n === 'number' && Number.isFinite(n)) ? (c as Cell) : null;
}

function legacySourceCell(g: Record<string, unknown>): Cell | null {
  const face = cellOf(g.face);
  const rig = cellOf(g.rig);
  if (face && rig) {
    const [a, b] = face.y < rig.y || (face.y === rig.y && face.x <= rig.x) ? [face, rig] : [rig, face];
    if (a.x === b.x && a.w === b.w && a.y + a.h === b.y) return { x: a.x, y: a.y, w: a.w, h: a.h + b.h };
    if (a.y === b.y && a.h === b.h && a.x + a.w === b.x) return { x: a.x, y: a.y, w: a.w + b.w, h: a.h };
  }
  return face ?? rig;
}

export function readGrid(raw: unknown): Grid {
  const g = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const grid = {} as Grid;
  for (const id of TILE_IDS) {
    const c = cellOf(g[id]) ?? (id === 'source' ? legacySourceCell(g) : null);
    grid[id] = c ? clampCell(id, c) : DEFAULT_GRID[id];
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

export const PRESET_IDS = ['default'] as const;
export type PresetId = (typeof PRESET_IDS)[number];
export const HOTKEY_PRESETS: readonly PresetId[] = ['default'];

export const PRESET_NAME_MAX = 32;

export interface Preset {
  name?: string;
  stage?: Stage;
}

export const PRESET_WORDS: Record<PresetId, { name: string }> = {
  default: { name: 'default' }
};

export function readPreset(raw: unknown): Preset | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  const preset: Preset = {};
  const name = readPresetName(p.name);
  if (name) preset.name = name;
  const stage = readStage(p.stage);
  if (stage) preset.stage = stage;
  return preset;
}

export function readPresetName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const name = raw.trim().slice(0, PRESET_NAME_MAX);
  return name || undefined;
}

export function presetName(id: PresetId, preset: Preset | null): string {
  return preset?.name || PRESET_WORDS[id].name;
}

export function migratedPreset(saved: unknown, mine: unknown): Preset | null {
  if (saved !== null && saved !== undefined) return null;
  const old = readPreset(mine);
  return old && (old.stage || old.name) ? old : null;
}

const RETIRED_PRESETS: readonly (readonly string[])[] = [
  ['sources', 'sound'],
  ['face', 'rig'],
  ['source'],
  ['sources', 'face', 'rig', 'sound'],
  ['sources', 'source', 'sound']
];

export function wasRetiredPreset(raw: unknown): boolean {
  const p = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  if (!Array.isArray(p.hidden)) return false;
  const hidden = new Set(p.hidden.filter((id): id is string => typeof id === 'string'));
  return RETIRED_PRESETS.some((ids) => ids.length === hidden.size && ids.every((id) => hidden.has(id)));
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
const storedLayoutAtom = atomWithStorage<unknown>('settings.liveLayout', 'obs', undefined, json);
const storedGridAtom = atomWithStorage<unknown>('settings.liveGrid', null, undefined, json);
const storedSlotsAtom = atomWithStorage<unknown>('settings.liveSlots', null, undefined, json);
const storedMineAtom = atomWithStorage<unknown>('settings.livePresetMine', null, undefined, json);
const storedPresetAtom = atomWithStorage<unknown>('settings.livePreset', null, undefined, json);
const storedPresetsDefaultAtom = atomWithStorage<unknown>('settings.livePresetsDefault', false, undefined, json);
const storedRailAtom = atomWithStorage<unknown>('settings.liveRail', null, undefined, json);

export const livePanelsAtom = atom<LivePanels>((get) => readPanels(get(storedPanelsAtom)));
export const liveLayoutAtom = atom<LayoutId>((get) => readLayout(get(storedLayoutAtom)));
export const liveSlotsAtom = atom<Slots>((get) => readSlots(get(storedSlotsAtom)));
export const liveGridAtom = atom<Grid>((get) => {
  const layout = get(liveLayoutAtom);
  return (isSlot(layout) && get(liveSlotsAtom)[layout]) || START_GRID;
});
export const liveDefaultAtom = atom<Preset | null>((get) => readPreset(get(storedPresetAtom)));
export const livePresetAtom = atom<PresetId>(() => 'default');
export const liveRailAtom = atom<RailState>((get) => readRail(get(storedRailAtom)));
export const liveEditingAtom = atom(false);

function setPanels(panels: LivePanels) {
  store.set(storedPanelsAtom, panels);
}

export function setHidden(id: ModuleId, hidden: boolean) {
  const rest = store.get(livePanelsAtom).hidden.filter((h) => h !== id);
  setPanels({ hidden: hidden ? [...rest, id] : rest });
}

export function setLayout(layout: LayoutId) {
  store.set(storedLayoutAtom, layout);
}

export function setGrid(grid: Grid) {
  const layout = store.get(liveLayoutAtom);
  if (!isSlot(layout)) return;
  store.set(storedSlotsAtom, { ...store.get(liveSlotsAtom), [layout]: grid });
}

export function setRail(open: boolean) {
  store.set(storedRailAtom, open ? 'open' : 'shut');
}

export function placeShown(grid: Grid, was: readonly ModuleId[], hidden: readonly ModuleId[]): { grid: Grid; hidden: ModuleId[] } {
  const next = { ...grid };
  const placed: TileId[] = TILE_IDS.filter((t) => t === 'preview' || (!was.includes(t) && !hidden.includes(t)));
  const still = [...hidden];
  for (const id of MODULE_IDS) {
    if (hidden.includes(id) || placed.includes(id)) continue;
    const cell = fits(next, placed, id, next[id]) ? next[id] : freeCell(next, placed, id);
    if (cell) {
      next[id] = cell;
      placed.push(id);
    } else still.push(id);
  }
  return { grid: next, hidden: still };
}

export function applyPreset(id: PresetId): Preset | null {
  return id === 'default' ? store.get(liveDefaultAtom) : null;
}

export function savePresetStage(stage: Stage) {
  const name = store.get(liveDefaultAtom)?.name;
  const next: Preset = { stage };
  if (name) next.name = name;
  store.set(storedPresetAtom, next);
}

export function renamePreset(raw: string) {
  const next: Preset = { ...store.get(liveDefaultAtom) };
  const name = readPresetName(raw);
  if (name) next.name = name;
  else delete next.name;
  store.set(storedPresetAtom, next);
}

export function migratePresets() {
  const moved = migratedPreset(store.get(storedPresetAtom), store.get(storedMineAtom));
  if (moved) store.set(storedPresetAtom, moved);
  if (store.get(storedPresetsDefaultAtom) === true) return;
  if (wasRetiredPreset(store.get(storedPanelsAtom))) store.set(storedPanelsAtom, readPanels(null));
  store.set(storedPresetsDefaultAtom, true);
}

export function migrateLayouts() {
  if (store.get(storedSlotsAtom) !== null) return;
  store.set(storedSlotsAtom, seedSlots(store.get(storedGridAtom), store.get(storedMineAtom)));
  store.set(storedGridAtom, RESET);
}

export function pickLayout(id: LayoutId) {
  store.set(storedLayoutAtom, id);
  if (isSlot(id) && !store.get(liveSlotsAtom)[id]) startEditing();
  else stopEditing();
}

export function startEditing() {
  const layout = store.get(liveLayoutAtom);
  if (!isSlot(layout)) return;
  if (!store.get(liveSlotsAtom)[layout]) setGrid(START_GRID);
  store.set(liveEditingAtom, true);
}

export function stopEditing() {
  store.set(liveEditingAtom, false);
}

export function resetGrid() {
  setGrid(START_GRID);
}

export function showInGrid(id: ModuleId): boolean {
  const grid = store.get(liveGridAtom);
  const panels = store.get(livePanelsAtom);
  const shown = TILE_IDS.filter((t) => t === 'preview' || !panels.hidden.includes(t));
  const cell = fits(grid, shown, id, grid[id]) ? grid[id] : freeCell(grid, shown, id);
  if (!cell) return false;
  setGrid({ ...grid, [id]: cell });
  setHidden(id, false);
  return true;
}
