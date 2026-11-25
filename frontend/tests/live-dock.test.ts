import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CHAT_COLUMN, dockTabs, readDockTab, readPanels, SIDE_BY_SIDE_MIN, sideBySide, unreadAfter, unreadWords } from '../src/infra/live-dock.ts';

test('every panel is open until it is folded', () => {
  const all = { sources: true, face: true, rig: true, thumbnail: true, sound: true, chat: true, dock: true };
  assert.deepEqual(readPanels(null), all);
  assert.deepEqual(readPanels('junk'), all);
  assert.deepEqual(readPanels({ sources: true, rig: true, sound: true }), all);
  assert.deepEqual(readPanels({ rig: false, chat: false, dock: 0 }), { ...all, rig: false, chat: false });
});

test('chat is a dock tab only when it has no column', () => {
  assert.deepEqual(dockTabs(false), ['sources', 'face', 'rig', 'thumbnail', 'sound']);
  assert.deepEqual(dockTabs(true), ['sources', 'face', 'rig', 'thumbnail', 'sound', 'chat']);
});

test('a kept tab that is not on offer falls back to the first', () => {
  assert.equal(readDockTab('rig', dockTabs(false)), 'rig');
  assert.equal(readDockTab('chat', dockTabs(true)), 'chat');
  assert.equal(readDockTab('chat', dockTabs(false)), 'sources');
  assert.equal(readDockTab(undefined, dockTabs(false)), 'sources');
});

test('panels sit side by side only with room for all of them', () => {
  assert.equal(sideBySide(SIDE_BY_SIDE_MIN - 1), false);
  assert.equal(sideBySide(SIDE_BY_SIDE_MIN), true);
  assert.equal(sideBySide(1366 - 64 - 40 - CHAT_COLUMN), false);
  assert.equal(sideBySide(1920 - 64 - 40 - CHAT_COLUMN), true);
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
