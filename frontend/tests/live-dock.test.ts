import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  arrange,
  clampCell,
  DEFAULT_GRID,
  fits,
  freeCell,
  GRID_COLS,
  GRID_ROWS,
  LAYOUT_IDS,
  overlaps,
  placeIn,
  placeShown,
  migratedPreset,
  migratedPresets,
  nextPresetName,
  PRESETS_MAX,
  presetForKey,
  presetName,
  railOpen,
  readRailWidth,
  fitRailWidth,
  RAIL_W_DEFAULT,
  RAIL_W_MAX,
  RAIL_W_MIN,
  readGrid,
  readLayout,
  readPanels,
  readPreset,
  readPresets,
  readRail,
  readSlots,
  seedSlots,
  START_GRID,
  starterPresets,
  withActive,
  withPresetAdded,
  withPresetDeleted,
  withPresetMoved,
  withPresetRenamed,
  withPresetStage,
  TILE_IDS,
  typingInto,
  unreadAfter,
  unreadWords,
  wasRetiredPreset
} from '../src/infra/live-dock.ts';

const ALL = { hidden: [] };

test('every module is shown until it is closed, and old fold flags are dropped', () => {
  assert.deepEqual(readPanels(null), ALL);
  assert.deepEqual(readPanels('junk'), ALL);
  assert.deepEqual(readPanels({ rig: false, chat: false, thumbnail: false, dock: false }), ALL);
  assert.deepEqual(readPanels({ sources: false, hidden: ['source', 'nope', 'chat', 3] }), { hidden: ['source', 'chat'] });
  assert.deepEqual(readPanels({ hidden: 'rig' }), ALL);
});

test('the old face and rigging modules fold into source settings', () => {
  assert.deepEqual(readPanels({ hidden: ['rig', 'chat'] }), { hidden: ['chat'] });
  assert.deepEqual(readPanels({ hidden: ['face', 'chat'] }), { hidden: ['chat'] });
  assert.deepEqual(readPanels({ hidden: ['face', 'rig', 'sound'] }), { hidden: ['source', 'sound'] });
  assert.deepEqual(readGrid({ face: { x: 0, y: 3, w: 3, h: 3 }, rig: { x: 0, y: 6, w: 3, h: 3 } }).source, { x: 0, y: 3, w: 3, h: 6 });
  assert.deepEqual(readGrid({ rig: { x: 5, y: 8, w: 2, h: 4 }, face: { x: 3, y: 8, w: 2, h: 4 } }).source, { x: 3, y: 8, w: 4, h: 4 });
  assert.deepEqual(readGrid({ face: { x: 0, y: 0, w: 3, h: 3 }, rig: { x: 6, y: 6, w: 3, h: 3 } }).source, { x: 0, y: 0, w: 3, h: 3 });
  assert.deepEqual(readGrid({ rig: { x: 6, y: 6, w: 3, h: 3 } }).source, { x: 6, y: 6, w: 3, h: 3 });
  assert.deepEqual(readGrid({ source: { x: 1, y: 1, w: 2, h: 2 }, face: { x: 0, y: 0, w: 3, h: 3 } }).source, { x: 1, y: 1, w: 2, h: 2 });
  assert.deepEqual(readGrid(null).source, DEFAULT_GRID.source);
  assert.deepEqual(readPanels({ hidden: ['rig', 'face'] }), { hidden: ['source'] });
  assert.equal(TILE_IDS.includes('face' as never), false);
  assert.equal(TILE_IDS.includes('rig' as never), false);
});

test('nothing saved reads as the one default starter, and a saved list keeps its own order', () => {
  assert.deepEqual(readPresets(null), { list: [{ id: 'default' }], active: 'default' });
  assert.deepEqual(readPresets('junk'), { list: [{ id: 'default' }], active: 'default' });
  assert.deepEqual(readPresets({ list: [], active: 'p2' }), starterPresets());
  const read = readPresets({ list: [{ id: 'p2', name: 'two' }, { id: 'default', name: 'main' }, { id: 'p2' }, { id: 'bad' }, 7], active: 'p9' });
  assert.deepEqual(read, {
    list: [
      { id: 'p2', name: 'two' },
      { id: 'default', name: 'main' }
    ],
    active: 'p2'
  });
  assert.deepEqual(readPresets({ list: [{ id: 'p2' }], active: 'p2' }), { list: [{ id: 'p2' }], active: 'p2' });
  const many = Array.from({ length: 14 }, (_, i) => ({ id: `p${i + 2}` }));
  assert.equal(readPresets({ list: many }).list.length, PRESETS_MAX);
  assert.equal(readPreset(null), null);
  assert.deepEqual(readPreset({}), {});
});

test('only obs left is built in, then four custom slots, and an old built in layout falls back to obs left', () => {
  assert.deepEqual(LAYOUT_IDS, ['obs', 'c1', 'c2', 'c3', 'c4']);
  assert.equal(readLayout('c3'), 'c3');
  assert.equal(readLayout('obs'), 'obs');
  for (const old of [1, 2, 3, 4, 5, '3', 9, undefined, null]) assert.equal(readLayout(old), 'obs', String(old));
});

test('obs left puts every module in one place, and closed ones nowhere', () => {
  const a = arrange([]);
  assert.deepEqual([...a.left, ...a.right, ...a.below, ...a.under, ...a.side].sort(), ['chat', 'sound', 'source', 'sources']);
  assert.deepEqual(arrange(['source']).left, ['sources', 'sound']);
  assert.deepEqual(arrange([], ['chat']).under, []);
  assert.equal(placeIn(arrange([]), 'chat'), 'under');
  assert.equal(placeIn(arrange([]), 'source'), 'column');
  assert.equal(placeIn(arrange(['source']), 'source'), null);
});

test('the grids every layout opens edit mode with have no overlaps and stay in bounds', () => {
  for (const grid of [DEFAULT_GRID, START_GRID]) {
    for (const id of TILE_IDS) {
      const c = grid[id];
      assert.deepEqual(clampCell(id, c), c, id);
      for (const other of TILE_IDS) if (other !== id) assert.equal(overlaps(c, grid[other]), false, `${id} ${other}`);
    }
  }
});

test('a cell is clamped into the 12 by 12 grid and never under its smallest size', () => {
  assert.deepEqual(clampCell('sources', { x: 11, y: -3, w: 4, h: 1 }), { x: 8, y: 0, w: 4, h: 2 });
  assert.deepEqual(clampCell('preview', { x: 0.4, y: 0.6, w: 40, h: 2 }), { x: 0, y: 1, w: GRID_COLS, h: 3 });
  assert.deepEqual(readGrid({ chat: { x: 'a' }, sound: { x: 1, y: 2, w: 3, h: 4 } }).chat, DEFAULT_GRID.chat);
  assert.deepEqual(readGrid({ sound: { x: 1, y: 2, w: 3, h: 4 } }).sound, { x: 1, y: 2, w: 3, h: 4 });
});

test('a module put back finds a free cell, or none when the grid is full', () => {
  const shown = TILE_IDS.filter((t) => t !== 'source');
  const grid = { ...DEFAULT_GRID, sound: { x: 3, y: 7, w: 9, h: 5 } };
  assert.equal(fits(grid, shown, 'source', grid.source), false);
  assert.equal(freeCell(grid, shown, 'source'), null);
  const roomy = { ...DEFAULT_GRID, sound: { x: 9, y: 7, w: 3, h: 5 } };
  const cell = freeCell(roomy, shown, 'source');
  assert.ok(cell && fits(roomy, shown, 'source', cell) && cell.x + cell.w <= GRID_COLS && cell.y + cell.h <= GRID_ROWS);
});

test('a preset never keeps a layout or shown modules, even from an old save', () => {
  const custom = { ...DEFAULT_GRID, chat: { x: 8, y: 0, w: 4, h: 5 } };
  assert.deepEqual(readPreset({ layout: 'c3', panels: ALL }), {});
  assert.deepEqual(readPreset({ layout: 5, grid: custom, panels: { hidden: ['source', 'chat'] }, name: 'stream' }), { name: 'stream' });
  assert.equal(readPreset('junk'), null);
  assert.equal(readPreset([]), null);
});

test('an old yours preset moves into default once, keeping its name and setup', () => {
  const stage = { scene: { cam: { box: { x: 0, y: 0, w: 0.5, h: 0.5 }, shown: true } } };
  const moved = migratedPreset(null, { panels: ALL, layout: 'c2', name: 'stream', stage });
  assert.equal(moved?.name, 'stream');
  assert.deepEqual(moved?.stage?.scene.cam?.box, { x: 0, y: 0, w: 0.5, h: 0.5 });
  assert.equal('layout' in (moved ?? {}), false);
  assert.equal('panels' in (moved ?? {}), false);
  assert.equal(migratedPreset({ name: 'kept' }, { name: 'stream', stage }), null);
  assert.equal(migratedPreset(null, { panels: ALL, layout: 'obs' }), null);
  assert.equal(migratedPreset(null, null), null);
});

test('an empty custom slot starts with the stream across the bottom and every module in a row along the top', () => {
  const modules = TILE_IDS.filter((id) => id !== 'preview');
  for (const id of modules) assert.equal(START_GRID[id].y, 0, id);
  assert.equal(
    modules.reduce((w, id) => w + START_GRID[id].w, 0),
    GRID_COLS
  );
  const top = Math.max(...modules.map((id) => START_GRID[id].h));
  assert.deepEqual(START_GRID.preview, { x: 0, y: top, w: GRID_COLS, h: GRID_ROWS - top });
});

test('custom slots are read one by one, junk is empty, and an old custom grid seeds slot 1 once', () => {
  const custom = { ...DEFAULT_GRID, chat: { x: 8, y: 0, w: 4, h: 5 } };
  const empty = { c1: null, c2: null, c3: null, c4: null };
  assert.deepEqual(readSlots(null), empty);
  assert.deepEqual(readSlots('junk'), empty);
  assert.deepEqual(readSlots({ c2: custom, c3: 4, c9: custom }), { ...empty, c2: custom });
  assert.deepEqual(readSlots({ c1: { chat: { x: 'a' } } }).c1, DEFAULT_GRID);
  assert.deepEqual(seedSlots(null, null), empty);
  assert.deepEqual(seedSlots(custom, null), { ...empty, c1: custom });
  assert.deepEqual(seedSlots(null, { layout: 5, grid: custom, panels: ALL }), { ...empty, c1: custom });
  assert.deepEqual(seedSlots(null, { layout: 3, grid: custom, panels: ALL }), empty);
  assert.deepEqual(seedSlots('junk', 'junk'), empty);
});

test('default takes a name, trimmed, and an empty one falls back to default', () => {
  assert.deepEqual(readPreset({ name: '  stream  ' }), { name: 'stream' });
  assert.deepEqual(readPreset({ name: '   ' }), {});
  assert.equal(readPreset({ name: 'x'.repeat(40) })?.name?.length, 32);
  assert.equal(presetName({ id: 'default', name: 'stream' }), 'stream');
  assert.equal(presetName({ id: 'default' }), 'default');
  assert.equal(presetName(null), 'default');
  assert.equal(presetName({ id: 'p3' }), 'preset');
});

test('modules kept by a retired built in preset are recognised, a hand picked set is not', () => {
  assert.equal(wasRetiredPreset({ hidden: ['sound', 'sources'] }), true);
  assert.equal(wasRetiredPreset({ hidden: ['rig', 'face'] }), true);
  assert.equal(wasRetiredPreset({ hidden: ['sources', 'face', 'rig', 'sound'] }), true);
  assert.equal(wasRetiredPreset({ hidden: ['sources', 'source', 'sound'] }), true);
  assert.equal(wasRetiredPreset({ hidden: [] }), false);
  assert.equal(wasRetiredPreset({ hidden: ['rig'] }), false);
  assert.equal(wasRetiredPreset({ hidden: ['sources', 'sound', 'chat'] }), false);
  assert.equal(wasRetiredPreset(null), false);
});

test('showing modules on a custom grid keeps every placed tile and only moves one that would overlap', () => {
  const grid = { ...DEFAULT_GRID, sound: { x: 3, y: 7, w: 9, h: 5 } };
  const out = placeShown(grid, ['source', 'sources'], []);
  for (const id of TILE_IDS.filter((t) => t !== 'source')) assert.deepEqual(out.grid[id], grid[id]);
  assert.deepEqual(out.hidden, ['source']);
  assert.deepEqual(placeShown(DEFAULT_GRID, ['source'], []), { grid: DEFAULT_GRID, hidden: [] });
});

test('keys 1 to 9 pick presets in order', () => {
  const list = [{ id: 'default' }, { id: 'p2' }, { id: 'p5' }];
  assert.equal(presetForKey('1', list), 'default');
  assert.equal(presetForKey('2', list), 'p2');
  assert.equal(presetForKey('3', list), 'p5');
  assert.equal(presetForKey('4', list), null);
  assert.equal(presetForKey('0', list), null);
  assert.equal(presetForKey('a', list), null);
  assert.equal(presetForKey('F1', list), null);
  assert.equal(presetForKey('10', list), null);
});

const stage = (x: number) => ({
  scene: { cam: { box: { x, y: 0, w: 0.5, h: 0.5 }, shown: true } },
  images: {},
  levels: {},
  sounds: {},
  names: {},
  camera: '',
  mic: '',
  mirror: true,
  expressions: false,
  background: '',
  model: null,
  solo: false
});

test('a new preset gets the next free name, becomes active, and the list stops at nine', () => {
  let presets = readPresets(null);
  presets = withPresetAdded(presets, stage(0.1))!;
  assert.deepEqual(presets.list[1], { id: 'p2', name: 'preset 2', stage: stage(0.1) });
  assert.equal(presets.active, 'p2');
  presets = withPresetAdded(presets, stage(0.2))!;
  assert.equal(presets.list[2]!.name, 'preset 3');
  presets = withPresetDeleted(presets, 'p2');
  presets = withPresetAdded(presets, stage(0.3))!;
  assert.deepEqual(
    presets.list.map((p) => [p.id, p.name]),
    [
      ['default', undefined],
      ['p3', 'preset 3'],
      ['p4', 'preset 2']
    ]
  );
  while (presets.list.length < PRESETS_MAX) presets = withPresetAdded(presets, stage(0))!;
  assert.equal(withPresetAdded(presets, stage(0)), null);
  assert.equal(nextPresetName([{ id: 'default' }]), 'preset 2');
});

test('renaming, deleting and saving touch only the named preset', () => {
  let presets = withPresetAdded(readPresets(null), stage(0.1))!;
  presets = withPresetRenamed(presets, 'p2', '  intro  ');
  assert.equal(presets.list[1]!.name, 'intro');
  assert.equal(withPresetRenamed(presets, 'p2', '   ').list[1]!.name, undefined);
  presets = withPresetStage(presets, 'default', stage(0.7));
  assert.deepEqual(presets.list[0]!.stage, stage(0.7));
  assert.deepEqual(presets.list[1]!.stage, stage(0.1));
  assert.equal(withPresetDeleted(presets, 'p9'), presets);
  const gone = withPresetDeleted(presets, 'p2');
  assert.deepEqual(
    gone.list.map((p) => p.id),
    ['default']
  );
  assert.equal(gone.active, 'default');
  assert.equal(withActive(presets, 'default').active, 'default');
  assert.equal(withActive(presets, 'p9').active, 'p2');
});

test('the old single default and the older mine preset move into the list without loss', () => {
  assert.deepEqual(migratedPresets(null, { name: 'main', stage: stage(0.4) }, null), {
    list: [{ id: 'default', name: 'main', stage: stage(0.4) }],
    active: 'default'
  });
  assert.deepEqual(migratedPresets(null, null, { panels: { hidden: [] }, layout: 'c2', name: 'stream', stage: stage(0.5) }), {
    list: [{ id: 'default', name: 'stream', stage: stage(0.5) }],
    active: 'default'
  });
  assert.equal(migratedPresets({ list: [] }, { name: 'main' }, null), null);
  assert.equal(migratedPresets(null, null, null), null);
  assert.equal(migratedPresets(null, {}, null), null);
});

test('hotkeys stay out of the way while typing', () => {
  assert.equal(typingInto({ tagName: 'INPUT', type: 'text' } as unknown as EventTarget), true);
  assert.equal(typingInto({ tagName: 'INPUT', type: 'search' } as unknown as EventTarget), true);
  assert.equal(typingInto({ tagName: 'INPUT', type: 'range' } as unknown as EventTarget), false);
  assert.equal(typingInto({ tagName: 'TEXTAREA' } as unknown as EventTarget), true);
  assert.equal(typingInto({ tagName: 'DIV', isContentEditable: true } as unknown as EventTarget), true);
  assert.equal(typingInto({ tagName: 'SPAN', closest: (s: string) => (s.includes('contenteditable') ? {} : null) } as unknown as EventTarget), true);
  assert.equal(typingInto({ tagName: 'BUTTON', closest: () => null } as unknown as EventTarget), false);
  assert.equal(typingInto(null), false);
});

test('the rail is open until it is collapsed, and a choice sticks', () => {
  assert.equal(readRail('open'), 'open');
  assert.equal(readRail('x'), null);
  assert.equal(railOpen(null), true);
  assert.equal(railOpen('open'), true);
  assert.equal(railOpen('shut'), false);
});

test('the rail width stays in its clamps and falls back to the default', () => {
  assert.equal(readRailWidth(null), RAIL_W_DEFAULT);
  assert.equal(readRailWidth('300'), RAIL_W_DEFAULT);
  assert.equal(readRailWidth(Number.NaN), RAIL_W_DEFAULT);
  assert.equal(readRailWidth(300.4), 300);
  assert.equal(readRailWidth(10), RAIL_W_MIN);
  assert.equal(readRailWidth(9000), RAIL_W_MAX);
  assert.equal(fitRailWidth(219), RAIL_W_MIN);
  assert.equal(fitRailWidth(481), RAIL_W_MAX);
});

test('unread counts lines after the last one seen, not your own', () => {
  const lines = [
    { id: 'a', from: 'ann' },
    { id: 'b', from: 'me' },
    { id: 'c', from: 'bob' },
    { id: 'd', from: 'cat' }
  ];
  assert.equal(unreadAfter(lines, null, 'me'), 0);
  assert.equal(unreadAfter(lines, 'd', 'me'), 0);
  assert.equal(unreadAfter(lines, 'a', 'me'), 2);
  assert.equal(unreadAfter(lines, '', 'me'), 3);
  assert.equal(unreadAfter(lines, 'gone', null), 4);
});

test('the badge stops at 99+', () => {
  assert.equal(unreadWords(7), '7');
  assert.equal(unreadWords(99), '99');
  assert.equal(unreadWords(100), '99+');
});

const MODULES = join(import.meta.dirname, '../src/shared-components/live/modules');
const NAMES = ['Sources', 'Source', 'Sound', 'Chat', 'Presets', 'Thumbnail', 'Studio', 'LayoutSwitcher', 'Destinations'];

test('every go live module has its own file and none imports another', () => {
  const files = readdirSync(MODULES).filter((f) => f.endsWith('.tsx'));
  assert.deepEqual(files.map((f) => f.replace('.tsx', '')).sort(), [...NAMES].sort());
  for (const f of files) {
    const src = readFileSync(join(MODULES, f), 'utf8');
    assert.doesNotMatch(src, /from '(@\/shared-components\/live\/modules\/|\.\/|\.\.\/modules)/, f);
  }
});

test('the page wraps every module in its own boundary', () => {
  const page = readFileSync(join(import.meta.dirname, '../src/app/live/LivePage.tsx'), 'utf8');
  for (const id of ['studio', 'layout', 'presets', 'thumbnail']) assert.match(page, new RegExp(`<ModuleBoundary id="${id}"`), id);
  assert.match(page, /MODULE_IDS\.map\(\(id\) =>\s*createPortal\(\s*<ModuleBoundary id=\{id\}/);
});

test('default can be deleted like any other, the active one falls to the first left, and deleting the last brings the starter back', () => {
  let presets = withPresetAdded(withPresetAdded(readPresets(null), stage(0.1))!, stage(0.2))!;
  presets = withActive(presets, 'default');
  presets = withPresetDeleted(presets, 'default');
  assert.deepEqual(
    presets.list.map((p) => p.id),
    ['p2', 'p3']
  );
  assert.equal(presets.active, 'p2');
  presets = withActive(presets, 'p3');
  presets = withPresetDeleted(presets, 'p2');
  assert.equal(presets.active, 'p3');
  presets = withPresetDeleted(presets, 'p3');
  assert.deepEqual(presets, starterPresets());
  assert.equal(presetName(presets.list[0]), 'default');
  assert.equal(presets.list[0]!.stage, undefined);
  assert.deepEqual(readPresets(JSON.parse(JSON.stringify(presets))), starterPresets());
});

test('a preset moved by drag keeps its place through storage and the hotkeys follow the new order', () => {
  let presets = withPresetAdded(withPresetAdded(readPresets(null), stage(0.1))!, stage(0.2))!;
  const active = presets.active;
  presets = withPresetMoved(presets, 'p3', 0);
  assert.deepEqual(
    presets.list.map((p) => p.id),
    ['p3', 'default', 'p2']
  );
  assert.equal(presets.active, active);
  presets = withPresetMoved(presets, 'default', 9);
  assert.deepEqual(
    presets.list.map((p) => p.id),
    ['p3', 'p2', 'default']
  );
  assert.equal(withPresetMoved(presets, 'p2', 1), presets);
  assert.equal(withPresetMoved(presets, 'p9', 0), presets);
  const stored = readPresets(JSON.parse(JSON.stringify(presets)));
  assert.deepEqual(
    stored.list.map((p) => p.id),
    ['p3', 'p2', 'default']
  );
  assert.equal(presetForKey('1', stored.list), 'p3');
  assert.equal(presetForKey('3', stored.list), 'default');
});
