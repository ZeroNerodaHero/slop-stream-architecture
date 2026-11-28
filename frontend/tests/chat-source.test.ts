import assert from 'node:assert/strict';
import { test } from 'node:test';

import { bySource, emoteUrlOk, pickOf, platformsOf, sourceOf } from '../src/infra/chat-source.ts';

const twitch = { platform: 'twitch', id: 'm1', user: '41', color: '#00FF7F', badges: ['moderator', 'nope'], parts: [{ text: 'hi ' }, { emote: 'Kappa', url: 'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/1.0' }] };

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
  assert.equal(pickOf('kick', ['twitch', 'kick']), 'kick');
  assert.equal(pickOf('kick', ['twitch']), 'slop');
  assert.equal(pickOf('junk', ['twitch']), 'slop');
});

test('lines are filtered to the picked source', () => {
  const lines = [{ id: 'a' }, { id: 'b', source: sourceOf(twitch)! }, { id: 'c', source: sourceOf({ ...twitch, platform: 'kick', id: 'm2' })! }];
  assert.deepEqual(bySource(lines, 'slop', ['twitch', 'kick']).map((l) => l.id), ['a']);
  assert.deepEqual(bySource(lines, 'twitch', ['twitch', 'kick']).map((l) => l.id), ['b']);
  assert.deepEqual(bySource(lines, 'kick', ['twitch', 'kick']).map((l) => l.id), ['c']);
  assert.deepEqual(bySource(lines, 'kick', ['twitch']).map((l) => l.id), ['a'], 'a source that is off falls back to this site');
  assert.equal(bySource(lines, 'twitch', []), lines, 'no picker, no filter');
});
