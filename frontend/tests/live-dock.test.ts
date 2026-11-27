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
  PRESETS,
  presetForKey,
  presetName,
  presetOf,
  railOpen,
  readGrid,
  readLayout,
  readPanels,
  readPreset,
  readRail,
  readSlots,
  seedSlots,
  START_GRID,
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
  assert.equal(presetOf({ panels: readPanels({ hidden: ['rig', 'face'] }), layout: 'obs' }, { panels: { hidden: ['source'] } }), 'mine');
  assert.equal(TILE_IDS.includes('face' as never), false);
  assert.equal(TILE_IDS.includes('rig' as never), false);
});

test('the one built in preset is default: everything open on obs left', () => {
  assert.deepEqual(Object.keys(PRESETS), ['default']);
  assert.deepEqual(PRESETS.default, { panels: { hidden: [] }, layout: 'obs' });
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

test('a preset is found from its modules and layout, and the picked one wins a tie', () => {
  const look = (layout: 'obs' | 'c1' | 'c2' | 'c3' | 'c4', hidden: string[] = []) => ({ panels: readPanels({ hidden }), layout });
  const yours = { panels: ALL, layout: 'c2' as const };
  assert.equal(presetOf(look('obs'), null), 'default');
  assert.equal(presetOf(look('c2'), null), null);
  assert.equal(presetOf(look('obs', ['sound', 'sources']), null), null);
  assert.equal(presetOf(look('c2'), yours), 'mine');
  assert.equal(presetOf(look('obs'), yours), 'default');
  assert.equal(presetOf(look('obs'), { panels: ALL }), 'default');
  assert.equal(presetOf(look('obs'), { panels: ALL }, 'mine'), 'mine');
  assert.equal(presetOf(look('c2'), yours, 'default'), 'mine');
  assert.equal(presetOf(look('obs', ['source']), { panels: { hidden: ['source'] } }), 'mine');
  assert.equal(readPreset(null), null);
  assert.equal(readPreset({ layout: 4 }), null);
  assert.deepEqual(readPreset({ layout: 7, panels: { hidden: ['source', 'chat'] } }), { panels: { hidden: ['source', 'chat'] } });
  assert.deepEqual(readPreset({ layout: 'c3', panels: ALL }), { panels: ALL, layout: 'c3' });
});

test('a preset saved with an old layout maps to obs left, and old custom 5 maps to custom slot 1', () => {
  const custom = { ...DEFAULT_GRID, chat: { x: 8, y: 0, w: 4, h: 5 } };
  assert.deepEqual(readPreset({ layout: 1, panels: ALL }), { panels: ALL, layout: 'obs' });
  for (const old of [2, 3, 4]) assert.deepEqual(readPreset({ layout: old, grid: custom, panels: ALL }), { panels: ALL, layout: 'obs' });
  assert.deepEqual(readPreset({ layout: 4, panels: { chat: false, rig: false } }), { panels: ALL, layout: 'obs' });
  assert.deepEqual(readPreset({ layout: 5, grid: custom, panels: ALL }), { panels: ALL, layout: 'c1' });
  assert.deepEqual(readPreset({ layout: 'nope', panels: ALL }), { panels: ALL });
});

test('an empty custom slot starts with the stream across the bottom and every module in a row along the top', () => {
  const modules = TILE_IDS.filter((id) => id !== 'preview');
  for (const id of modules) assert.equal(START_GRID[id].y, 0, id);
  assert.equal(modules.reduce((w, id) => w + START_GRID[id].w, 0), GRID_COLS);
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

test('only your preset takes a name, trimmed, and an empty one falls back to yours', () => {
  assert.deepEqual(readPreset({ panels: ALL, name: '  stream  ' }), { panels: ALL, name: 'stream' });
  assert.deepEqual(readPreset({ panels: ALL, name: '   ' }), { panels: ALL });
  assert.equal(readPreset({ panels: ALL, name: 'x'.repeat(40) })?.name?.length, 32);
  assert.equal(presetName('mine', { panels: ALL, name: 'stream' }), 'stream');
  assert.equal(presetName('mine', { panels: ALL }), 'yours');
  assert.equal(presetName('mine', null), 'yours');
  assert.equal(presetName('default', { panels: ALL, name: 'stream' }), 'default');
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

test('only the key 1 picks a preset', () => {
  assert.equal(presetForKey('1'), 'default');
  assert.equal(presetForKey('2'), null);
  assert.equal(presetForKey('5'), null);
  assert.equal(presetForKey('0'), null);
  assert.equal(presetForKey('a'), null);
  assert.equal(presetForKey('F1'), null);
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

test('the rail opens by itself only with room, and a choice sticks', () => {
  assert.equal(readRail('open'), 'open');
  assert.equal(readRail('x'), null);
  assert.equal(railOpen(null, 1024), false);
  assert.equal(railOpen(null, 1366), true);
  assert.equal(railOpen('open', 1024), true);
  assert.equal(railOpen('shut', 1920), false);
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
