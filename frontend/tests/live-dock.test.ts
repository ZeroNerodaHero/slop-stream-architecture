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
  LAYOUT_GRIDS,
  overlaps,
  placeIn,
  PRESETS,
  presetForKey,
  presetOf,
  railOpen,
  readGrid,
  readLayout,
  readPanels,
  readPreset,
  readRail,
  TILE_IDS,
  typingInto,
  unreadAfter,
  unreadWords
} from '../src/infra/live-dock.ts';

const ALL = { sources: true, face: true, rig: true, sound: true, chat: true, thumbnail: true, hidden: [] };

test('every panel is open and shown until it is folded or closed', () => {
  assert.deepEqual(readPanels(null), ALL);
  assert.deepEqual(readPanels('junk'), ALL);
  assert.deepEqual(readPanels({ rig: false, chat: false, dock: false }), { ...ALL, rig: false, chat: false });
  assert.deepEqual(readPanels({ hidden: ['rig', 'nope', 'chat', 3] }), { ...ALL, hidden: ['rig', 'chat'] });
  assert.deepEqual(readPanels({ hidden: 'rig' }), ALL);
});

test('a kept layout that is not one of the five falls back to obs left', () => {
  assert.equal(readLayout(3), 3);
  assert.equal(readLayout(5), 5);
  assert.equal(readLayout('3'), 1);
  assert.equal(readLayout(9), 1);
  assert.equal(readLayout(undefined), 1);
});

test('each layout puts every module in one place, and closed ones nowhere', () => {
  for (const layout of [1, 2, 3, 4] as const) {
    const a = arrange(layout, []);
    const all = [...a.left, ...a.right, ...a.below, ...a.under, ...a.side].sort();
    assert.deepEqual(all, ['chat', 'face', 'rig', 'sound', 'sources'], `layout ${layout}`);
  }
  assert.deepEqual(arrange(1, ['rig']).left, ['sources', 'face', 'sound']);
  assert.deepEqual(arrange(3, [], ['chat']).side, []);
  assert.equal(placeIn(arrange(1, []), 'chat'), 'under');
  assert.equal(placeIn(arrange(3, []), 'chat'), 'side');
  assert.equal(placeIn(arrange(3, []), 'rig'), 'row');
  assert.equal(placeIn(arrange(2, []), 'face'), 'column');
  assert.equal(placeIn(arrange(1, ['face']), 'face'), null);
});

test('the grids every layout opens edit mode with have no overlaps and stay in bounds', () => {
  for (const grid of [DEFAULT_GRID, ...Object.values(LAYOUT_GRIDS)]) {
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
  assert.deepEqual(readGrid({ chat: { x: 'a' }, rig: { x: 1, y: 2, w: 3, h: 4 } }).chat, DEFAULT_GRID.chat);
  assert.deepEqual(readGrid({ rig: { x: 1, y: 2, w: 3, h: 4 } }).rig, { x: 1, y: 2, w: 3, h: 4 });
});

test('a module put back finds a free cell, or none when the grid is full', () => {
  const shown = TILE_IDS.filter((t) => t !== 'rig');
  const grid = { ...DEFAULT_GRID, sound: { x: 6, y: 7, w: 6, h: 5 } };
  assert.equal(fits(grid, shown, 'rig', grid.rig), false);
  assert.equal(freeCell(grid, shown, 'rig'), null);
  const roomy = { ...DEFAULT_GRID, sound: { x: 9, y: 7, w: 3, h: 5 } };
  const cell = freeCell(roomy, shown, 'rig');
  assert.ok(cell && fits(roomy, shown, 'rig', cell) && cell.x + cell.w <= GRID_COLS && cell.y + cell.h <= GRID_ROWS);
});

test('a preset is found again from the layout and the folds, whatever the thumbnail does', () => {
  assert.equal(presetOf(1, ALL, null), 'full');
  assert.equal(presetOf(1, { ...ALL, thumbnail: false }, null), 'full');
  assert.equal(presetOf(2, ALL, null), null);
  assert.equal(presetOf(PRESETS.safe.layout, PRESETS.safe.panels, null), 'safe');
  assert.equal(presetOf(PRESETS.chat.layout, { ...PRESETS.chat.panels, hidden: ['sound', 'rig', 'face', 'sources'] }, null), 'chat');
  assert.equal(presetOf(3, { ...ALL, rig: false }, { layout: 3, panels: { ...ALL, rig: false } }), 'mine');
  assert.equal(readPreset({ layout: 7, panels: {} }), null);
  assert.deepEqual(readPreset({ layout: 4, panels: { chat: false } }), { layout: 4, panels: { ...ALL, chat: false } });
});

test('only the keys 1 to 5 pick a preset', () => {
  assert.equal(presetForKey('1'), 'full');
  assert.equal(presetForKey('5'), 'safe');
  assert.equal(presetForKey('6'), null);
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
const NAMES = ['Sources', 'Face', 'Rigging', 'Sound', 'Chat', 'Presets', 'Thumbnail', 'Studio', 'LayoutSwitcher'];

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
