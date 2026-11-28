import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AVATAR_LOOK, avatarFrame, avatarRadius, readAvatarLook, sameLook, squareIn } from '../src/infra/avatar-look.ts';
import { arrangedAfterAdd, arrangedAfterRemove, AVATAR_ID, CORNER, FULL, keptOf, readKept, resizedBox, sceneOf, soloed, type Source, squaredAvatarBox, squaredAvatars } from '../src/infra/scene.ts';
import { sectionsOf } from '../src/infra/source-settings.ts';
import { readStage, type Stage, stageChanged, stagedFrom, stageOf } from '../src/infra/stage.ts';

const square = (b: { w: number; h: number }) => Math.abs(b.w * 16 - b.h * 9) < 0.02;
const avatar: Source = { id: AVATAR_ID, kind: 'avatar', label: 'avatar', box: FULL, shown: true };
const cam: Source = { id: 'cam', kind: 'camera', label: 'camera', slot: 0, box: FULL, shown: true };
const screen: Source = { id: 's1', kind: 'screen', label: 'screen', slot: 1, box: FULL, shown: true };

test('a fresh avatar look is the old behavior: theme shape, talk border in the theme blue, bounce on', () => {
  assert.deepEqual(AVATAR_LOOK, { shape: 'default', border: true, color: '', bounce: true });
  assert.deepEqual(readAvatarLook({}), AVATAR_LOOK);
  for (const raw of [null, undefined, 'bubble', 3, []]) assert.equal(readAvatarLook(raw), null);
  assert.ok(sameLook(readAvatarLook({})!, AVATAR_LOOK));
  assert.equal(sameLook({ ...AVATAR_LOOK, bounce: false }, AVATAR_LOOK), false);
});

test('a stored look keeps what is valid and drops the rest', () => {
  assert.deepEqual(readAvatarLook({ shape: 'soft', border: false, color: '#FF0088', bounce: false }), { shape: 'soft', border: false, color: '#ff0088', bounce: false });
  assert.deepEqual(readAvatarLook({ shape: 'round', color: 'red', border: 'no' }), AVATAR_LOOK);
});

test('a new avatar is square wherever it lands', () => {
  const alone = arrangedAfterAdd([avatar], avatar, null).find((s) => s.kind === 'avatar')!;
  assert.ok(square(alone.box), JSON.stringify(alone.box));
  const decor = arrangedAfterAdd([cam, avatar], avatar, null).find((s) => s.kind === 'avatar')!;
  assert.ok(square(decor.box), JSON.stringify(decor.box));
  const corner = arrangedAfterAdd([screen, avatar], avatar, null).find((s) => s.kind === 'avatar')!;
  assert.ok(square(corner.box), JSON.stringify(corner.box));
  const rest = arrangedAfterRemove([{ ...avatar, box: CORNER }]).find((s) => s.kind === 'avatar')!;
  assert.ok(square(rest.box));
  assert.ok(square(soloed([avatar]).find((s) => s.kind === 'avatar')!.box));
  assert.ok(square(squareIn(CORNER)));
});

test('pulling a corner of a square avatar keeps it square', () => {
  const box = squareIn(CORNER);
  const next = resizedBox(box, -1, -1, -0.1, -0.02, box.w / box.h);
  assert.ok(square(next));
  assert.ok(next.w > box.w);
});

test('a wide avatar tile from an old preset becomes a square around the drawn avatar', () => {
  const wide = { x: 0.3, y: 0.4, w: 0.6, h: 0.5 };
  const box = squaredAvatarBox(wide);
  assert.ok(square(box), JSON.stringify(box));
  const px = (b: typeof wide) => ({ cx: (b.x + b.w / 2) * 1600, cy: (b.y + b.h / 2) * 900, side: Math.min(b.w * 1600, b.h * 900) });
  const before = px(wide);
  const after = px(box);
  assert.ok(Math.abs(before.cx - after.cx) < 2 && Math.abs(before.cy - after.cy) < 2, JSON.stringify({ before, after }));
  assert.ok(Math.abs(before.side - after.side) < 2, JSON.stringify({ before, after }));
  assert.deepEqual(squaredAvatarBox(box), box);
  const tall = squaredAvatarBox({ x: 0.1, y: 0.1, w: 0.2, h: 0.8 });
  assert.ok(square(tall), JSON.stringify(tall));
  const fixed = squaredAvatars([{ ...avatar, box: wide }, { ...screen, box: wide }]);
  assert.deepEqual(fixed[0]!.box, box);
  assert.deepEqual(fixed[1]!.box, wide);
  const again = squaredAvatars(fixed);
  assert.equal(again[0], fixed[0]);
  const rest = { levels: {}, sounds: {}, names: {}, camera: '', mic: '', mirror: true, expressions: true, background: '', model: null, solo: false };
  const stage = readStage(JSON.parse(JSON.stringify(stageOf([{ ...avatar, box: wide }, { ...screen, box: wide }], rest))))!;
  assert.deepEqual(stage.scene[AVATAR_ID]!.box, box);
  assert.deepEqual(stage.scene.s1!.box, wide);
  const { sources: back } = stagedFrom(stage, [avatar, screen], [], () => 'i1');
  assert.ok(!stageChanged(stage, stageOf(back, rest), []));
});

test('the look rides with the source through kept scenes and presets', () => {
  const look = { shape: 'bubble' as const, border: true, color: '#22cc88', bounce: false };
  const sources: Source[] = [cam, { ...avatar, box: squareIn(CORNER), look }];
  const kept = readKept(JSON.parse(JSON.stringify(keptOf(sources))))!;
  assert.deepEqual(kept[AVATAR_ID]!.look, look);
  assert.equal(kept.cam!.look, undefined);
  const rest = { levels: {}, sounds: {}, names: {}, camera: '', mic: '', mirror: true, expressions: true, background: '', model: null, solo: false };
  const stage: Stage = readStage(JSON.parse(JSON.stringify(stageOf(sources, rest))))!;
  assert.deepEqual(stage.scene[AVATAR_ID]!.look, look);
  const { sources: back } = stagedFrom(stage, [cam, avatar], [], () => 'i1');
  assert.deepEqual(back.find((s) => s.kind === 'avatar')!.look, look);
});

test('only the avatar has the look section', () => {
  assert.ok(sectionsOf('avatar').includes('look'));
  for (const kind of ['camera', 'model', 'screen', 'image', 'sound'] as const) assert.equal(sectionsOf(kind).includes('look'), false, kind);
});

test('the composite frame grows and lifts only with bounce on, and borders only with the talk border on', () => {
  const box = { x: 0, y: 0, w: 100, h: 100 };
  const still = avatarFrame(box, AVATAR_LOOK, 0, false);
  assert.equal(still.side, 84);
  const loud = avatarFrame(box, AVATAR_LOOK, 1, true);
  assert.ok(loud.side > still.side && loud.y < still.y && loud.talking);
  const flat = avatarFrame(box, { ...AVATAR_LOOK, bounce: false }, 1, true);
  assert.equal(flat.side, 84);
  assert.equal(flat.talking, true);
  assert.equal(avatarFrame(box, { ...AVATAR_LOOK, border: false }, 1, true).talking, false);
});

test('each shape rounds the composite its own way, default follows the site', () => {
  assert.equal(avatarRadius('block', 96, '50%', 16), 0);
  assert.equal(avatarRadius('soft', 96, '0px', 16), 12);
  assert.equal(avatarRadius('bubble', 96, '0px', 16), 48);
  assert.equal(avatarRadius('default', 96, '6px', 16), 12);
  assert.equal(avatarRadius('default', 96, '50%', 16), 48);
});

test('the scene sent to viewers carries the avatar look, and nothing when it is the default', () => {
  const look = { shape: 'soft' as const, border: false, color: '', bounce: false };
  const [styled] = sceneOf([{ ...avatar, look }]).layers;
  assert.deepEqual(styled, { id: AVATAR_ID, kind: 'avatar', look, ...FULL });
  const [plain] = sceneOf([avatar]).layers;
  assert.equal('look' in plain!, false);
  const [camLayer] = sceneOf([cam]).layers;
  assert.equal('look' in camLayer!, false);
});
