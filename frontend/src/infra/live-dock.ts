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

export const OBS_GRID: Grid = {
  sources: { x: 0, y: 0, w: 3, h: 4 },
  source: { x: 0, y: 4, w: 3, h: 4 },
  sound: { x: 0, y: 8, w: 3, h: 4 },
  preview: { x: 3, y: 0, w: 9, h: 8 },
  chat: { x: 3, y: 8, w: 9, h: 4 }
};

export type Slots = Record<SlotId, Grid | null>;

export function readDefaultGrid(raw: unknown): Grid | null {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? readGrid(raw) : null;
}

export function nextEmptySlot(slots: Slots): SlotId | null {
  return SLOT_IDS.find((id) => !slots[id]) ?? null;
}

export const LAYOUT_NAME_MAX = 32;
export type LayoutNames = Partial<Record<LayoutId, string>>;

export function readLayoutName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const name = raw.trim().slice(0, LAYOUT_NAME_MAX).trim();
  return name || undefined;
}

export function readLayoutNames(raw: unknown): LayoutNames {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const names: LayoutNames = {};
  for (const id of LAYOUT_IDS) {
    const name = readLayoutName(r[id]);
    if (name) names[id] = name;
  }
  return names;
}

export function layoutName(id: LayoutId, names: LayoutNames): string {
  return names[id] ?? LAYOUT_MARKS[id];
}

export function withLayoutNamed(names: LayoutNames, id: LayoutId, raw: string): LayoutNames {
  const next = { ...names };
  const name = readLayoutName(raw);
  if (name && name !== LAYOUT_MARKS[id]) next[id] = name;
  else delete next[id];
  return next;
}

export function copyName(name: string): string {
  const tail = ' copy';
  return `${name.slice(0, LAYOUT_NAME_MAX - tail.length).trim()}${tail}`;
}

export interface Duplicated {
  slot: SlotId;
  slots: Slots;
  names: LayoutNames;
}

export function withDuplicate(slots: Slots, names: LayoutNames, from: LayoutId, grid: Grid): Duplicated | null {
  const slot = nextEmptySlot(slots);
  if (!slot) return null;
  return { slot, slots: { ...slots, [slot]: grid }, names: withLayoutNamed(names, slot, copyName(layoutName(from, names))) };
}

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

export type Corner = 'tl' | 'tr' | 'bl' | 'br';

export const CORNERS: readonly Corner[] = ['tl', 'tr', 'bl', 'br'];

function stretch(start: number, size: number, delta: number, fromStart: boolean, min: number, max: number): [number, number] {
  if (!fromStart) {
    const len = Math.max(min, Math.min(max - start, Math.round(size + delta)));
    return [start, len];
  }
  const end = start + size;
  const at = Math.max(0, Math.min(end - min, Math.round(start + delta)));
  return [at, end - at];
}

export function resizeCell(id: TileId, from: Cell, corner: Corner, dx: number, dy: number): Cell {
  const min = MIN_CELL[id];
  const [x, w] = stretch(from.x, from.w, dx, corner[1] === 'l', min.w, GRID_COLS);
  const [y, h] = stretch(from.y, from.h, dy, corner[0] === 't', min.h, GRID_ROWS);
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

export const DEFAULT_PRESET = 'default';
export const PRESETS_MAX = 9;
export const PRESET_NAME_MAX = 32;
export type PresetId = string;

export interface Preset {
  name?: string;
  stage?: Stage;
}

export interface SavedPreset extends Preset {
  id: PresetId;
}

export interface Presets {
  list: SavedPreset[];
  active: PresetId;
}

const PRESET_ID = /^(default|p\d{1,6})$/;

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

export function starterPresets(): Presets {
  return { list: [{ id: DEFAULT_PRESET }], active: DEFAULT_PRESET };
}

export function readPresets(raw: unknown): Presets {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const list: SavedPreset[] = [];
  for (const entry of Array.isArray(r.list) ? r.list : []) {
    if (list.length >= PRESETS_MAX) break;
    const e = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : null;
    const id = e && typeof e.id === 'string' && PRESET_ID.test(e.id) ? e.id : null;
    const preset = id ? readPreset(e) : null;
    if (!id || !preset || list.some((p) => p.id === id)) continue;
    list.push({ id, ...preset });
  }
  if (!list.length) return starterPresets();
  const active = typeof r.active === 'string' && list.some((p) => p.id === r.active) ? r.active : list[0]!.id;
  return { list, active };
}

export function presetName(preset: Pick<SavedPreset, 'id' | 'name'> | null | undefined): string {
  return preset?.name || (preset?.id === DEFAULT_PRESET || !preset ? 'default' : 'preset');
}

export function nextPresetName(list: readonly SavedPreset[]): string {
  const used = new Set(list.map((p) => presetName(p)));
  let n = 2;
  while (used.has(`preset ${n}`)) n++;
  return `preset ${n}`;
}

function nextPresetId(list: readonly SavedPreset[]): PresetId {
  const top = Math.max(1, ...list.map((p) => (p.id.startsWith('p') ? Number(p.id.slice(1)) : 0)));
  return `p${top + 1}`;
}

export function withPresetAdded(presets: Presets, stage: Stage): Presets | null {
  if (presets.list.length >= PRESETS_MAX) return null;
  const id = nextPresetId(presets.list);
  return { list: [...presets.list, { id, name: nextPresetName(presets.list), stage }], active: id };
}

export function copyPresetName(list: readonly SavedPreset[], name: string): string {
  const used = new Set(list.map((p) => presetName(p)));
  const named = (tail: string) => `${name.slice(0, PRESET_NAME_MAX - tail.length).trimEnd()}${tail}`;
  let n = 2;
  let next = named(' copy');
  while (used.has(next)) next = named(` copy ${n++}`);
  return next;
}

export function withPresetDuplicated(presets: Presets, id: PresetId, stage: Stage | undefined): Presets | null {
  const from = presets.list.find((p) => p.id === id);
  if (!from || presets.list.length >= PRESETS_MAX) return null;
  const copy: SavedPreset = { id: nextPresetId(presets.list), name: copyPresetName(presets.list, presetName(from)) };
  const kept = stage ?? from.stage;
  if (kept) copy.stage = structuredClone(kept);
  return { list: [...presets.list, copy], active: copy.id };
}

export function withPresetRenamed(presets: Presets, id: PresetId, raw: string): Presets {
  const name = readPresetName(raw);
  return {
    ...presets,
    list: presets.list.map((p) => {
      if (p.id !== id) return p;
      const next: SavedPreset = { ...p };
      if (name) next.name = name;
      else delete next.name;
      return next;
    })
  };
}

export function withPresetDeleted(presets: Presets, id: PresetId): Presets {
  const list = presets.list.filter((p) => p.id !== id);
  if (list.length === presets.list.length) return presets;
  if (!list.length) return starterPresets();
  return { list, active: presets.active === id ? list[0]!.id : presets.active };
}

export function withPresetMoved(presets: Presets, id: PresetId, to: number): Presets {
  const from = presets.list.findIndex((p) => p.id === id);
  if (from < 0) return presets;
  const at = Math.max(0, Math.min(presets.list.length - 1, to));
  if (at === from) return presets;
  const list = presets.list.filter((p) => p.id !== id);
  list.splice(at, 0, presets.list[from]!);
  return { ...presets, list };
}

export function withPresetStage(presets: Presets, id: PresetId, stage: Stage): Presets {
  return { ...presets, list: presets.list.map((p) => (p.id === id ? { ...p, stage } : p)) };
}

export function withActive(presets: Presets, id: PresetId): Presets {
  return presets.list.some((p) => p.id === id) ? { ...presets, active: id } : presets;
}

export function migratedPreset(saved: unknown, mine: unknown): Preset | null {
  if (saved !== null && saved !== undefined) return null;
  const old = readPreset(mine);
  return old && (old.stage || old.name) ? old : null;
}

export function migratedPresets(saved: unknown, single: unknown, mine: unknown): Presets | null {
  if (saved !== null && saved !== undefined) return null;
  const kept = readPreset(single) ?? migratedPreset(null, mine);
  if (!kept || (!kept.stage && !kept.name)) return null;
  return { list: [{ id: DEFAULT_PRESET, ...kept }], active: DEFAULT_PRESET };
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

export function presetForKey(key: string, list: readonly Pick<SavedPreset, 'id'>[]): PresetId | null {
  const n = Number(key);
  return Number.isInteger(n) && n >= 1 && n <= list.length && key.length === 1 ? list[n - 1]!.id : null;
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

export function readRail(raw: unknown): RailState {
  return raw === 'open' || raw === 'shut' ? raw : null;
}

export function railOpen(state: RailState): boolean {
  return state !== 'shut';
}

export const RAIL_W_MIN = 220;
export const RAIL_W_MAX = 480;
export const RAIL_W_DEFAULT = 244;
export const RAIL_W_STEP = 16;

export function fitRailWidth(width: number): number {
  return Math.round(Math.min(RAIL_W_MAX, Math.max(RAIL_W_MIN, width)));
}

export function readRailWidth(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) ? fitRailWidth(raw) : RAIL_W_DEFAULT;
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
const storedDefaultGridAtom = atomWithStorage<unknown>('settings.liveDefaultGrid', null, undefined, json);
const storedLayoutNamesAtom = atomWithStorage<unknown>('settings.liveLayoutNames', null, undefined, json);
const storedMineAtom = atomWithStorage<unknown>('settings.livePresetMine', null, undefined, json);
const storedPresetAtom = atomWithStorage<unknown>('settings.livePreset', null, undefined, json);
const storedPresetsDefaultAtom = atomWithStorage<unknown>('settings.livePresetsDefault', false, undefined, json);
const storedPresetsAtom = atomWithStorage<unknown>('settings.livePresets', null, undefined, json);
const storedRailAtom = atomWithStorage<unknown>('settings.liveRail', null, undefined, json);
const storedRailWidthAtom = atomWithStorage<unknown>('settings.liveRailWidth', null, undefined, json);

export const livePanelsAtom = atom<LivePanels>((get) => readPanels(get(storedPanelsAtom)));
export const liveLayoutAtom = atom<LayoutId>((get) => readLayout(get(storedLayoutAtom)));
export const liveSlotsAtom = atom<Slots>((get) => readSlots(get(storedSlotsAtom)));
export const liveDefaultGridAtom = atom<Grid | null>((get) => readDefaultGrid(get(storedDefaultGridAtom)));
export const liveLayoutNamesAtom = atom<LayoutNames>((get) => readLayoutNames(get(storedLayoutNamesAtom)));
export const liveBuiltInAtom = atom<boolean>((get) => get(liveLayoutAtom) === 'obs' && get(liveDefaultGridAtom) === null);
export const liveGridAtom = atom<Grid>((get) => {
  const layout = get(liveLayoutAtom);
  if (layout === 'obs') return get(liveDefaultGridAtom) ?? OBS_GRID;
  return get(liveSlotsAtom)[layout] || START_GRID;
});
export const liveEmptySlotAtom = atom<SlotId | null>((get) => nextEmptySlot(get(liveSlotsAtom)));
export const livePresetsAtom = atom<Presets>((get) => readPresets(get(storedPresetsAtom)));
export const livePresetAtom = atom<PresetId>((get) => get(livePresetsAtom).active);
export const liveRailAtom = atom<RailState>((get) => readRail(get(storedRailAtom)));
export const liveRailWidthAtom = atom<number>((get) => readRailWidth(get(storedRailWidthAtom)));
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
  if (!isSlot(layout)) store.set(storedDefaultGridAtom, grid);
  else store.set(storedSlotsAtom, { ...store.get(liveSlotsAtom), [layout]: grid });
}

export function renameLayout(id: LayoutId, raw: string) {
  store.set(storedLayoutNamesAtom, withLayoutNamed(store.get(liveLayoutNamesAtom), id, raw));
}

export function duplicateLayout(): SlotId | null {
  const from = store.get(liveLayoutAtom);
  const done = withDuplicate(store.get(liveSlotsAtom), store.get(liveLayoutNamesAtom), from, store.get(liveGridAtom));
  if (!done) return null;
  store.set(storedSlotsAtom, done.slots);
  store.set(storedLayoutNamesAtom, done.names);
  store.set(storedLayoutAtom, done.slot);
  stopEditing();
  return done.slot;
}

export function setRail(open: boolean) {
  store.set(storedRailAtom, open ? 'open' : 'shut');
}

export const railFocusAtom = atom<RailSection | null>(null);

export function openRailAt(section: RailSection) {
  store.set(railFocusAtom, section);
  setRail(true);
}

export function setRailWidth(width: number | null) {
  store.set(storedRailWidthAtom, width === null ? null : fitRailWidth(width));
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

function setPresets(next: Presets) {
  store.set(storedPresetsAtom, next);
}

export function presetOf(id: PresetId): SavedPreset | null {
  return store.get(livePresetsAtom).list.find((p) => p.id === id) ?? null;
}

export function activatePreset(id: PresetId): SavedPreset | null {
  const preset = presetOf(id);
  if (preset) setPresets(withActive(store.get(livePresetsAtom), id));
  return preset;
}

export function addPreset(stage: Stage): PresetId | null {
  const next = withPresetAdded(store.get(livePresetsAtom), stage);
  if (!next) return null;
  setPresets(next);
  return next.active;
}

export function duplicatePreset(id: PresetId, stage: Stage | undefined): PresetId | null {
  const next = withPresetDuplicated(store.get(livePresetsAtom), id, stage);
  if (!next) return null;
  setPresets(next);
  return next.active;
}

export function savePresetStage(id: PresetId, stage: Stage) {
  setPresets(withPresetStage(store.get(livePresetsAtom), id, stage));
}

export function renamePreset(id: PresetId, raw: string) {
  setPresets(withPresetRenamed(store.get(livePresetsAtom), id, raw));
}

export function deletePreset(id: PresetId) {
  setPresets(withPresetDeleted(store.get(livePresetsAtom), id));
}

export function movePreset(id: PresetId, to: number) {
  setPresets(withPresetMoved(store.get(livePresetsAtom), id, to));
}

export function migratePresets() {
  const moved = migratedPresets(store.get(storedPresetsAtom), store.get(storedPresetAtom), store.get(storedMineAtom));
  if (moved) setPresets(moved);
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
  if (!isSlot(layout)) {
    if (!store.get(liveDefaultGridAtom)) setGrid(OBS_GRID);
  } else if (!store.get(liveSlotsAtom)[layout]) setGrid(START_GRID);
  store.set(liveEditingAtom, true);
}

export function stopEditing() {
  store.set(liveEditingAtom, false);
}

export function resetGrid() {
  if (isSlot(store.get(liveLayoutAtom))) {
    setGrid(START_GRID);
    return;
  }
  store.set(storedDefaultGridAtom, RESET);
  stopEditing();
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
