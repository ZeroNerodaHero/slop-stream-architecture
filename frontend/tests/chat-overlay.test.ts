import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ChatLine } from '../src/infra/atoms/chat-atoms.ts';
import type { SourcePart } from '../src/infra/chat-source.ts';
import { burnablePlatforms, CHAT_BOX, CHAT_STYLE, chatLinesOf, layoutChat, type Measure, NAME_COLORS, type OverlayLine, overlayLinesOf } from '../src/infra/chat-paint.ts';
import { arrangedAfterAdd, chatPatched, chatSource, layerOf, sceneOf, type Source } from '../src/infra/scene.ts';
import { nameKey, readNames, sectionsOf } from '../src/infra/source-settings.ts';
import { readStage, stagedFrom, stagedKind, stageOf, storedStage, stageChanged, type Stage } from '../src/infra/stage.ts';
import { readChat, readTextStyle } from '../src/infra/text-paint.ts';

const cam: Source = { id: 'cam', kind: 'camera', label: 'camera', slot: 0, box: { x: 0, y: 0, w: 1, h: 1 }, shown: true };
const rest: Omit<Stage, 'scene' | 'images' | 'texts' | 'chats'> = {
  levels: {},
  sounds: {},
  names: {},
  camera: '',
  mic: '',
  mirror: true,
  expressions: true,
  background: '',
  model: null,
  solo: false
};
const newId = () => 'i9';

function line(id: string, from: string, extra: Partial<ChatLine> = {}): ChatLine {
  return { id, from, text: `hi from ${from}`, streamer: false, verified: false, groups: [], avatar: null, at: 0, images: [], ...extra };
}

const twitch = (id: string, from: string, parts: SourcePart[] = []): ChatLine =>
  line(id, from, { source: { platform: 'twitch', id, user: from, color: '#ff8800', badges: [], parts } });
const kick = (id: string, from: string): ChatLine => line(id, from, { source: { platform: 'kick', id, user: from, color: null, badges: [], parts: [] } });

test('a chat source goes out as a chat layer the video server takes: lines 1-20, a clean style, nothing else', () => {
  const c = chatSource([cam], 'soft');
  assert.equal(c.id, 'ch1');
  assert.equal(c.kind, 'chat');
  assert.deepEqual(c.box, CHAT_BOX);
  const layer = layerOf(c);
  assert.deepEqual(Object.keys(layer).sort(), ['chat', 'h', 'id', 'kind', 'style', 'w', 'x', 'y']);
  assert.deepEqual(layer, { id: 'ch1', kind: 'chat', chat: { lines: 8 }, style: { ...CHAT_STYLE, shape: 'soft' }, ...CHAT_BOX });
  if (layer.kind !== 'chat') throw new Error('not chat');
  assert.deepEqual(readChat(layer.chat), layer.chat);
  assert.deepEqual(readTextStyle(layer.style), layer.style);
  assert.deepEqual(
    sceneOf([cam, c]).layers.map((l) => l.kind),
    ['camera', 'chat']
  );
  assert.equal(chatSource([cam, c], 'bubble').id, 'ch2');
  assert.equal(nameKey(c, false), 'ch1');
  assert.deepEqual(readNames({ ch1: 'my chat', ch: 'nope' }), { ch1: 'my chat' });
  assert.deepEqual(sectionsOf('chat'), ['chat']);
});

test('chat settings are clamped to what the video server allows, and the background can go', () => {
  const c = chatSource([], 'bubble');
  assert.deepEqual(chatPatched(c, { lines: 99 }).chat, { lines: 20 });
  assert.deepEqual(chatPatched(c, { lines: 0 }).chat, { lines: 1 });
  assert.deepEqual(chatPatched(c, { lines: 4.6 }).chat, { lines: 5 });
  assert.equal(chatPatched(c, { style: { bg: undefined } }).style?.bg, undefined);
  assert.equal(chatPatched(c, { style: { size: 0.05 } }).style?.size, 0.05);
  assert.equal(chatPatched(cam, { lines: 3 }), cam);
  assert.equal(chatLinesOf(undefined), 8);
  assert.equal(chatLinesOf({ lines: 40 }), 20);
});

test('adding chat keeps its own box and does not shuffle the videos', () => {
  const c = chatSource([cam], 'block');
  const out = arrangedAfterAdd([cam, c], c, null);
  assert.deepEqual(out[0], cam);
  assert.deepEqual(out[1]!.box, CHAT_BOX);
});

test('privacy: twitch and kick burn in only when platform chat is set to everyone', () => {
  assert.deepEqual(burnablePlatforms(['twitch', 'kick'], 'everyone'), ['twitch', 'kick']);
  assert.deepEqual(burnablePlatforms(['twitch', 'kick'], 'studio'), []);
  assert.deepEqual(burnablePlatforms(['twitch'], 'off'), []);
  assert.deepEqual(burnablePlatforms(['kick'], null), ['kick'], 'a viewer gets no mode, only the sources the server already let them see');
  assert.deepEqual(burnablePlatforms([], undefined), []);
  const lines = [line('1', 'ann'), twitch('2', 'tw'), kick('3', 'kk'), line('4', 'bob', { streamer: true })];
  const ids = (out: OverlayLine[]) => out.map((l) => l.id);
  assert.deepEqual(ids(overlayLinesOf(lines, burnablePlatforms(['twitch', 'kick'], 'everyone'), 10)), ['1', '2', '3', '4']);
  assert.deepEqual(ids(overlayLinesOf(lines, burnablePlatforms(['twitch', 'kick'], 'studio'), 10)), ['1', '4']);
  assert.deepEqual(ids(overlayLinesOf(lines, burnablePlatforms(['twitch', 'kick'], 'off'), 10)), ['1', '4']);
  assert.deepEqual(ids(overlayLinesOf(lines, ['twitch'], 10)), ['1', '2', '4'], 'a platform that is not a source never shows');
});

test('overlay lines: the newest n, names coloured like the dock chat, emotes kept, pending and empty lines skipped', () => {
  const emote = { emote: 'Kappa', url: 'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/1.0' };
  const lines = [
    line('1', 'old'),
    line('2', 'anon'),
    line('3', 'ver', { verified: true }),
    line('4', 'me', { pending: 'sending' }),
    line('5', 'pic', { text: '   ' }),
    twitch('6', 'tw', [{ text: 'gg ' }, emote, { emote: 'bad', url: 'https://evil.example/x.png' }]),
    kick('7', 'kk'),
    line('8', 'host', { streamer: true, text: 'hello :wave:' })
  ];
  const out = overlayLinesOf(lines, ['twitch', 'kick'], 5, (t) => t.replace(':wave:', 'wave'));
  assert.deepEqual(
    out.map((l) => l.id),
    ['2', '3', '6', '7', '8']
  );
  assert.equal(out[0]!.color, NAME_COLORS.anon);
  assert.equal(out[1]!.color, NAME_COLORS.verified);
  assert.equal(out[2]!.color, '#ff8800');
  assert.equal(out[2]!.platform, 'twitch');
  assert.deepEqual(out[2]!.parts, [{ text: 'gg ' }, emote]);
  assert.equal(out[3]!.color, NAME_COLORS.platform);
  assert.equal(out[4]!.color, NAME_COLORS.streamer);
  assert.deepEqual(out[4]!.parts, [{ text: 'hello wave' }]);
  assert.deepEqual(
    overlayLinesOf(lines, [], 99).map((l) => l.id),
    ['1', '2', '3', '8']
  );
});

const measure: Measure = (s, bold) => s.length * (bold ? 11 : 10);

test('layout stacks the newest line at the bottom and drops what does not fit', () => {
  const lines = overlayLinesOf([line('1', 'a'), line('2', 'b'), line('3', 'c')], [], 10);
  const box = { x: 0, y: 0, w: 400, h: 100 };
  const cards = layoutChat(measure, { lines, style: CHAT_STYLE, shape: 'block' }, box, 20);
  assert.ok(cards.length >= 1 && cards.length < 3);
  const lastCard = cards[cards.length - 1]!;
  assert.equal(lastCard.id, '3');
  assert.ok(Math.abs(lastCard.y + lastCard.h - 100) < 1e-6);
  assert.ok(cards.every((c) => c.y >= 0 && c.x === 0 && c.w <= 400));
  assert.deepEqual(lastCard.radii, [0, 0, 0, 0]);
});

test('bubble runs join like the dock chat: one name per run, joined corners inside it', () => {
  const lines = overlayLinesOf([line('1', 'ann'), line('2', 'ann'), line('3', 'ann'), line('4', 'bob')], [], 10);
  const box = { x: 0, y: 0, w: 600, h: 1000 };
  const cards = layoutChat(measure, { lines, style: CHAT_STYLE, shape: 'bubble' }, box, 20);
  assert.equal(cards.length, 4);
  const names = cards.map((c) => c.rows[0]!.some((p) => p.kind === 'name'));
  assert.deepEqual(names, [true, false, false, true]);
  const [tl0, , , bl0] = cards[0]!.radii;
  const [tl1, , , bl1] = cards[1]!.radii;
  const [tl2, , , bl2] = cards[2]!.radii;
  assert.ok(tl0 > bl0 && tl1 === bl1 && tl2 < bl2);
  assert.ok(cards[1]!.y - (cards[0]!.y + cards[0]!.h) < cards[3]!.y - (cards[2]!.y + cards[2]!.h));
  const soft = layoutChat(measure, { lines, style: CHAT_STYLE, shape: 'soft' }, box, 20);
  assert.ok(soft.every((c) => c.rows[0]!.some((p) => p.kind === 'name')));
  assert.ok(soft.every((c) => c.radii.every((r) => r === soft[0]!.radii[0] && r > 0)));
  const right = layoutChat(measure, { lines, style: { ...CHAT_STYLE, align: 'right' }, shape: 'bubble' }, box, 20);
  assert.ok(right.every((c) => Math.abs(c.x + c.w - 600) < 1e-6));
});

test('platform lines carry their mark, emotes wait for a clean image and fall back to the name', () => {
  const emote = { emote: 'Kappa', url: 'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/1.0' };
  const lines = overlayLinesOf([twitch('1', 'tw', [{ text: 'gg ' }, emote])], ['twitch'], 10);
  const box = { x: 0, y: 0, w: 600, h: 200 };
  const text = layoutChat(measure, { lines, style: CHAT_STYLE, shape: 'block' }, box, 20);
  const kinds = text[0]!.rows.flat().map((p) => p.kind);
  assert.deepEqual(kinds, ['mark', 'name', 'word', 'word']);
  assert.equal(text[0]!.rows.flat()[3]!.text, 'Kappa');
  const pictured = layoutChat(measure, { lines, style: CHAT_STYLE, shape: 'block' }, box, 20, () => true);
  assert.deepEqual(
    pictured[0]!.rows.flat().map((p) => p.kind),
    ['mark', 'name', 'word', 'emote']
  );
});

test('long words wrap inside the box', () => {
  const lines = overlayLinesOf([line('1', 'a', { text: 'x'.repeat(100) })], [], 10);
  const cards = layoutChat(measure, { lines, style: CHAT_STYLE, shape: 'block' }, { x: 0, y: 0, w: 200, h: 2000 }, 20);
  assert.ok(cards[0]!.rows.length > 3);
  assert.ok(cards[0]!.rows.every((r) => r.every((p) => p.x + p.w <= 200)));
});

test('a preset keeps the chat overlay: lines, style, box, and puts it back on load', () => {
  const c = { ...chatPatched(chatSource([cam], 'soft'), { lines: 5, style: { size: 0.04, bg: '#112233', align: 'right' } }), box: { x: 0.6, y: 0.1, w: 0.35, h: 0.5 } };
  const raw = JSON.parse(JSON.stringify(stageOf([cam, c], rest)));
  const stage = readStage(raw);
  assert.ok(stage);
  assert.deepEqual(Object.keys(stage.scene), ['cam', 'ch1']);
  assert.deepEqual(stage.chats.ch1, { chat: { lines: 5 }, style: c.style });
  assert.equal(stagedKind('ch1', stage), 'chat');
  const { sources, gaps } = stagedFrom(stage, [cam], [], newId);
  assert.deepEqual(gaps, []);
  assert.deepEqual(sources.find((s) => s.id === 'ch1'), c);
  const elsewhere = stagedFrom(readStage(JSON.parse(JSON.stringify(stageOf([cam], rest))))!, [cam, c], [], newId).sources;
  assert.equal(
    elsewhere.some((s) => s.kind === 'chat'),
    false,
    'chat not in the preset is dropped like a picture'
  );
  const saved = storedStage(stageOf([cam, c], rest))!;
  assert.equal(stageChanged(saved, stageOf([cam, c], rest), []), false);
  assert.equal(stageChanged(saved, stageOf([cam, chatPatched(c, { lines: 6 })], rest), []), true);
  assert.equal(stageChanged(saved, stageOf([cam, { ...c, box: { ...c.box, y: 0.2 } }], rest), []), true);
});

test('stored chat settings are cleaned on read', () => {
  const stage = readStage({
    scene: { ch1: { box: { x: 0, y: 0, w: 0.3, h: 0.5 }, shown: true } },
    chats: { ch1: { chat: { lines: 99 }, style: { size: 9, color: 'red' } }, 'Bad Id': { chat: { lines: 3 } } }
  });
  assert.ok(stage);
  assert.deepEqual(Object.keys(stage.chats), ['ch1']);
  assert.deepEqual(stage.chats.ch1, { chat: { lines: 8 }, style: { size: 0.5, color: '#ffffff' } });
  assert.deepEqual(readStage({ scene: {} })?.chats, {});
});
