import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AVATAR_LOOK, avatarFrame, avatarRadius, readAvatarLook, sameLook, squareIn } from '../src/infra/avatar-look.ts';
import { arrangedAfterAdd, arrangedAfterRemove, AVATAR_ID, CORNER, FULL, keptOf, readKept, resizedBox, soloed, type Source } from '../src/infra/scene.ts';
import { sectionsOf } from '../src/infra/source-settings.ts';
import { readStage, type Stage, stagedFrom, stageOf } from '../src/infra/stage.ts';

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
