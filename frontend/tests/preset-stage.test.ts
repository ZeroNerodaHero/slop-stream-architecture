import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readPreset } from '../src/infra/live-dock.ts';
import type { Source } from '../src/infra/scene.ts';
import { gapWords, readStage, type Stage, stagedFrom, stageOf } from '../src/infra/stage.ts';

const cam: Source = { id: 'cam', kind: 'camera', label: 'camera', slot: 0, box: { x: 0.5, y: 0.5, w: 0.4, h: 0.4 }, shown: true, fit: 'cover' };
const screen: Source = { id: 's1', kind: 'screen', label: 'screen', slot: 1, box: { x: 0, y: 0, w: 1, h: 1 }, shown: true };
const logo: Source = { id: 'i1', kind: 'image', label: 'logo', asset: 7, ratio: 0.5, box: { x: 0.1, y: 0.1, w: 0.2, h: 0.3 }, shown: true };
const sticker: Source = { id: 'i2', kind: 'image', label: 'sticker', asset: 9, ratio: 1, box: { x: 0.6, y: 0.1, w: 0.2, h: 0.2 }, shown: true };

const rest: Omit<Stage, 'scene' | 'images'> = {
  levels: { mic: { level: 0.3, muted: false }, master: { level: 0.8, muted: true } },
  sounds: { aboing1: { name: 'boing', volume: 0.4, loop: true, hear: false } },
  names: { camera: 'face cam' },
  camera: 'cam-b',
  mic: 'mic-b',
  mirror: false,
  expressions: true,
  background: '#102030',
  model: null,
  solo: false
};

const saved = (sources: Source[]) => {
  const raw = JSON.parse(JSON.stringify({ panels: { hidden: ['chat'] }, layout: 'c2', stage: stageOf(sources, rest) }));
  const preset = readPreset(raw);
  assert.ok(preset?.stage);
  return preset.stage;
};

let ids = 0;
const newId = () => `i${100 + ++ids}`;

test('a saved preset keeps which sources, their order, boxes, levels and source settings through storage', () => {
  const stage = saved([screen, cam, logo]);
  assert.deepEqual(Object.keys(stage.scene), ['s1', 'cam', 'i1']);
  assert.deepEqual(stage.scene.cam, { box: cam.box, shown: true, fit: 'cover' });
  assert.deepEqual(stage.images.i1, { asset: 7, label: 'logo', ratio: 0.5 });
  assert.deepEqual(stage.levels.mic, { level: 0.3, muted: false });
  assert.deepEqual(stage.levels.master, { level: 0.8, muted: true });
  assert.deepEqual(stage.sounds.aboing1, { name: 'boing', volume: 0.4, loop: true, hear: false });
  assert.equal(stage.names.camera, 'face cam');
  assert.equal(stage.camera, 'cam-b');
  assert.equal(stage.mic, 'mic-b');
  assert.equal(stage.mirror, false);
  assert.equal(stage.background, '#102030');
});

test('applying a saved stage puts the same sources back in order with their boxes, hides extras and drops other pictures', () => {
  const stage = saved([screen, cam, logo]);
  const moved: Source[] = [
    { ...cam, box: { x: 0, y: 0, w: 1, h: 1 }, fit: 'contain' },
    { ...screen, shown: false, box: { x: 0.2, y: 0.2, w: 0.3, h: 0.3 } },
    { ...sticker },
    { id: 's2', kind: 'screen', label: 'window', slot: 2, box: { x: 0, y: 0, w: 1, h: 1 }, shown: true }
  ];
  const { sources, gaps } = stagedFrom(stage, moved, [7, 9], newId);
  assert.deepEqual(
    sources.map((s) => [s.id, s.shown]),
    [
      ['s2', false],
      ['s1', true],
      ['cam', true],
      ['i101', true]
    ]
  );
  assert.deepEqual(sources[2]!.box, cam.box);
  assert.equal(sources[2]!.fit, 'cover');
  assert.deepEqual(sources[1]!.box, screen.box);
  assert.equal(sources[3]!.asset, 7);
  assert.equal(sources[3]!.label, 'logo');
  assert.deepEqual(gaps, []);
});

test('a picture already in the scene is reused by its asset, not added twice', () => {
  const stage = saved([cam, logo]);
  const { sources } = stagedFrom(stage, [{ ...logo, id: 'i5', box: { x: 0, y: 0, w: 0.5, h: 0.5 } }, cam], [7], newId);
  assert.deepEqual(
    sources.map((s) => s.id),
    ['cam', 'i5']
  );
  assert.deepEqual(sources[1]!.box, logo.box);
});

test('a saved screen, picture or camera that is not here is skipped and named in the notice', () => {
  const stage = saved([screen, cam, logo]);
  const { sources, gaps } = stagedFrom(stage, [], [], newId);
  assert.deepEqual(sources, []);
  assert.deepEqual(gaps, [{ kind: 'screen', slot: 1 }, { kind: 'camera' }, { kind: 'image', label: 'logo' }]);
  assert.equal(gapWords(gaps), 'skipped screen 1, camera, logo: not here now');
  assert.equal(gapWords([]), '');
});

test('a hidden saved source that is gone is skipped quietly', () => {
  const stage = saved([{ ...screen, shown: false }, cam]);
  const { gaps } = stagedFrom(stage, [cam], [], newId);
  assert.deepEqual(gaps, []);
});

test('an old preset without a stage still reads and leaves the sources alone', () => {
  const old = readPreset({ panels: { hidden: ['sound'] }, layout: 'obs', name: 'mine' });
  assert.deepEqual(old, { name: 'mine' });
  assert.equal(old?.stage, undefined);
  assert.equal(readPreset({ panels: { hidden: [] }, stage: 'junk' })?.stage, undefined);
  assert.equal(readPreset({ panels: { hidden: [] }, stage: { levels: {} } })?.stage, undefined);
});

test('stored stage values are clamped and junk entries are dropped', () => {
  const stage = readStage({
    scene: { cam: { box: { x: -1, y: 0, w: 9, h: 1 }, shown: true }, 'Bad Id': { box: { x: 0, y: 0, w: 1, h: 1 } } },
    images: { i1: { asset: -2 } },
    levels: { mic: { level: 4, muted: 'yes' }, bad: { level: 'x' } },
    sounds: { aboing1: { volume: -1 } },
    names: { camera: '  face  ', nope: 'x' },
    background: 'red',
    model: { kind: 'demo', id: 'Nope!', v: '1', name: 'x' }
  });
  assert.ok(stage);
  assert.deepEqual(Object.keys(stage.scene), ['cam']);
  assert.deepEqual(stage.scene.cam!.box, { x: 0, y: 0, w: 1, h: 1 });
  assert.deepEqual(stage.images, {});
  assert.deepEqual(stage.levels, { mic: { level: 1, muted: false } });
  assert.deepEqual(stage.sounds, { aboing1: { name: 'sound', volume: 0, loop: false, hear: true } });
  assert.deepEqual(stage.names, { camera: 'face' });
  assert.equal(stage.background, '');
  assert.equal(stage.model, null);
  assert.equal(stage.mirror, true);
});
