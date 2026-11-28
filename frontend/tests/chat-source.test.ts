import assert from 'node:assert/strict';
import { test } from 'node:test';

import { bySource, emoteUrlOk, picksOf, platformsOf, sourceOf, togglePick } from '../src/infra/chat-source.ts';

const twitch = {
  platform: 'twitch',
  id: 'm1',
  user: '41',
  color: '#00FF7F',
  badges: ['moderator', 'nope'],
  parts: [{ text: 'hi ' }, { emote: 'Kappa', url: 'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/1.0' }]
};

test('a platform line is read and checked', () => {
  const s = sourceOf(twitch)!;
  assert.equal(s.platform, 'twitch');
  assert.deepEqual(s.badges, ['moderator']);
  assert.equal(s.parts.length, 2);
  assert.equal(sourceOf({ ...twitch, platform: 'myspace' }), undefined);
  assert.equal(sourceOf({ ...twitch, id: 3 }), undefined);
  assert.equal(sourceOf(null), undefined);
  assert.equal(sourceOf({ ...twitch, color: 'red' })!.color, null);
});

test('emotes only come from the platform cdns', () => {
  assert.ok(emoteUrlOk('https://files.kick.com/emotes/37226/fullsize'));
  assert.ok(!emoteUrlOk('https://evil.example/x.png'));
  assert.ok(!emoteUrlOk('javascript:alert(1)'));
  assert.ok(!emoteUrlOk('https://files.kick.com/emotes/1" onerror="x'));
  const s = sourceOf({ ...twitch, parts: [{ text: 'a' }, { emote: 'x', url: 'https://evil.example/x.png' }] })!;
  assert.deepEqual(s.parts, [], 'no safe emote left, so the plain text is used');
});

test('the picker only offers what the streamer has on', () => {
  assert.deepEqual(platformsOf(['kick', 'youtube', 'twitch']), ['twitch', 'kick']);
  assert.deepEqual(platformsOf('twitch'), []);
  assert.deepEqual(picksOf(['kick', 'slop'], ['twitch', 'kick']), ['slop', 'kick']);
  assert.deepEqual(picksOf(['kick'], ['twitch']), ['slop', 'twitch'], 'nothing left on falls back to everything');
  assert.deepEqual(picksOf(['junk'], ['twitch']), ['slop', 'twitch']);
});

test('nothing saved means every source is on', () => {
  assert.deepEqual(picksOf(null, ['twitch', 'kick']), ['slop', 'twitch', 'kick']);
  assert.deepEqual(picksOf(undefined, []), ['slop']);
  assert.deepEqual(picksOf(42, ['kick']), ['slop', 'kick']);
});

test('an old single pick becomes a set of one', () => {
  assert.deepEqual(picksOf('slop', ['twitch', 'kick']), ['slop']);
  assert.deepEqual(picksOf('kick', ['twitch', 'kick']), ['kick']);
  assert.deepEqual(picksOf('kick', ['twitch']), ['slop', 'twitch']);
});

test('each source toggles on its own and the last one stays on', () => {
  const both: ['twitch', 'kick'] = ['twitch', 'kick'];
  assert.deepEqual(togglePick(['slop'], 'kick', both), ['slop', 'kick']);
  assert.deepEqual(togglePick(['slop', 'kick'], 'twitch', both), ['slop', 'twitch', 'kick']);
  assert.deepEqual(togglePick(['slop', 'twitch', 'kick'], 'slop', both), ['twitch', 'kick']);
  assert.deepEqual(togglePick(['twitch', 'kick'], 'twitch', both), ['kick']);
  assert.deepEqual(togglePick(['kick'], 'kick', both), ['kick'], 'the last one cannot be turned off');
  assert.deepEqual(togglePick(['kick'], 'slop', both), ['slop', 'kick']);
});

test('lines are filtered to the picked sources', () => {
  const lines = [{ id: 'a' }, { id: 'b', source: sourceOf(twitch)! }, { id: 'c', source: sourceOf({ ...twitch, platform: 'kick', id: 'm2' })! }, { id: 'd' }];
  const both: ['twitch', 'kick'] = ['twitch', 'kick'];
  assert.deepEqual(
    bySource(lines, ['slop'], both).map((l) => l.id),
    ['a', 'd']
  );
  assert.deepEqual(
    bySource(lines, ['twitch'], both).map((l) => l.id),
    ['b']
  );
  assert.deepEqual(
    bySource(lines, ['kick'], both).map((l) => l.id),
    ['c']
  );
  assert.deepEqual(
    bySource(lines, ['slop', 'kick'], both).map((l) => l.id),
    ['a', 'c', 'd'],
    'merged lines keep their order'
  );
  assert.deepEqual(
    bySource(lines, ['twitch', 'kick'], both).map((l) => l.id),
    ['b', 'c']
  );
  assert.equal(bySource(lines, ['slop', 'twitch', 'kick'], both), lines, 'everything on, nothing filtered');
  assert.deepEqual(
    bySource(lines, ['kick'], ['twitch']).map((l) => l.id),
    ['a', 'b', 'd'],
    'a source that is off falls back to everything'
  );
  assert.equal(bySource(lines, ['twitch'], []), lines, 'no picker, no filter');
});
