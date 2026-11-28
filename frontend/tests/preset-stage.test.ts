import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readPreset, readPresets } from '../src/infra/live-dock.ts';
import { arrivedFrom, keptOf, type Source } from '../src/infra/scene.ts';
import { readSounds } from '../src/infra/source-settings.ts';
import { blankStage, gapWords, readStage, sameStage, type Stage, stageChanged, stagedFrom, stagedKind, stageOf, storedStage, withGoneScreens } from '../src/infra/stage.ts';

const cam: Source = { id: 'cam', kind: 'camera', label: 'camera', slot: 0, box: { x: 0.5, y: 0.5, w: 0.4, h: 0.4 }, shown: true, fit: 'cover' };
const screen: Source = { id: 's1', kind: 'screen', label: 'screen', slot: 1, box: { x: 0, y: 0, w: 1, h: 1 }, shown: true };
const logo: Source = { id: 'i1', kind: 'image', label: 'logo', asset: 7, ratio: 0.5, box: { x: 0.1, y: 0.1, w: 0.2, h: 0.3 }, shown: true };
const sticker: Source = { id: 'i2', kind: 'image', label: 'sticker', asset: 9, ratio: 1, box: { x: 0.6, y: 0.1, w: 0.2, h: 0.2 }, shown: true };

const lower: Source = {
  id: 't1',
  kind: 'text',
  label: 'billy is live',
  text: 'billy is live',
  style: { size: 0.05, color: '#ffffff', bg: '#000000', align: 'left', shape: 'bubble' },
  box: { x: 0.04, y: 0.78, w: 0.5, h: 0.12 },
  shown: true
};

const rest: Omit<Stage, 'scene' | 'images' | 'texts' | 'chats'> = {
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

test('a saved screen or camera that is not here waits in its saved place, and a missing picture is named in the notice', () => {
  const stage = saved([screen, { ...cam, shown: false }, logo]);
  const { sources, gaps } = stagedFrom(stage, [], [], newId);
  assert.deepEqual(sources, [
    { id: 's1', kind: 'screen', label: 'screen', slot: 1, box: screen.box, shown: true, waiting: true },
    { id: 'cam', kind: 'camera', label: 'camera', slot: 0, box: cam.box, shown: false, fit: 'cover', waiting: true }
  ]);
  assert.deepEqual(gaps, [{ kind: 'image', label: 'logo' }]);
  assert.equal(gapWords(gaps), 'skipped logo: not here now');
  assert.equal(gapWords([]), '');
  assert.deepEqual(keptOf(sources), { s1: stage.scene.s1, cam: stage.scene.cam });
});

test('a waiting screen is kept by the next preset that has it, dropped by one that does not, and counts for dirty', () => {
  const stage = saved([cam, screen]);
  const first = stagedFrom(stage, [cam], [], newId).sources;
  assert.deepEqual(
    first.map((s) => [s.id, s.waiting === true]),
    [
      ['cam', false],
      ['s1', true]
    ]
  );
  const again = stagedFrom(stage, first, [], newId).sources;
  assert.deepEqual(JSON.parse(JSON.stringify(again)), JSON.parse(JSON.stringify(first)));
  const without = stagedFrom(saved([cam]), first, [], newId).sources;
  assert.deepEqual(
    without.map((s) => s.id),
    ['cam']
  );
  const saving = storedStage(stageOf(first, rest))!;
  assert.equal(stageChanged(saving, stageOf(first, rest), ['cam', 's1']), false);
  assert.equal(stageChanged(saving, stageOf([cam], rest), ['cam', 's1']), true);
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
  assert.deepEqual(stage.scene.cam!.box, { x: -0.95, y: 0, w: 1, h: 1 });
  assert.deepEqual(stage.images, {});
  assert.deepEqual(stage.levels, { mic: { level: 1, muted: false } });
  assert.deepEqual(stage.sounds, { aboing1: { name: 'sound', volume: 0, loop: false, hear: true } });
  assert.deepEqual(stage.names, { camera: 'face' });
  assert.equal(stage.background, '');
  assert.equal(stage.model, null);
  assert.equal(stage.mirror, true);
});

test('autosave keeps a saved screen not shared yet this session, but drops one that was shared and then removed', () => {
  const before = stageOf([screen, cam], rest);
  const now = stageOf([cam], rest);
  assert.deepEqual(Object.keys(withGoneScreens(before, now, []).scene), ['s1', 'cam']);
  assert.deepEqual(withGoneScreens(before, now, []).scene.s1, before.scene.s1);
  assert.deepEqual(Object.keys(withGoneScreens(before, now, ['s1']).scene), ['cam']);
  assert.equal(withGoneScreens(undefined, now, []), now);
  const withoutLogo = stageOf([screen, cam], rest);
  assert.deepEqual(Object.keys(withGoneScreens(stageOf([screen, cam, logo], rest), withoutLogo, ['s1']).scene), ['s1', 'cam']);
});

test('a saved screen arriving lands in its saved box and the others stay where they were', () => {
  const kept = keptOf([{ ...screen, box: { x: 0.2, y: 0.2, w: 0.5, h: 0.5 }, shown: false }, cam]);
  const moved = { ...cam, box: { x: 0.8, y: 0.8, w: 0.2, h: 0.2 } };
  const out = arrivedFrom(kept, [cam], [moved, screen]);
  assert.deepEqual(out.find((s) => s.id === 'cam')?.box, cam.box);
  assert.deepEqual(out.find((s) => s.id === 's1')?.box, { x: 0.2, y: 0.2, w: 0.5, h: 0.5 });
  assert.equal(out.find((s) => s.id === 's1')?.shown, false);
  const plain = [moved, logo];
  assert.equal(arrivedFrom(kept, [cam], plain), plain);
});

test('a stage just saved is clean, and a move, a hidden source, a level, a sound or a setting makes it dirty', () => {
  const saved = storedStage(stageOf([cam, screen, logo], rest))!;
  assert.equal(stageChanged(saved, stageOf([cam, screen, logo], rest), []), false);
  assert.equal(stageChanged(saved, stageOf([{ ...cam, box: { ...cam.box, x: 0.1 } }, screen, logo], rest), []), true);
  assert.equal(stageChanged(saved, stageOf([cam, { ...screen, shown: false }, logo], rest), []), true);
  assert.equal(stageChanged(saved, stageOf([screen, cam, logo], rest), []), true);
  assert.equal(stageChanged(saved, stageOf([cam, screen, logo], { ...rest, levels: { ...rest.levels, mic: { level: 0.9, muted: false } } }), []), true);
  assert.equal(stageChanged(saved, stageOf([cam, screen, logo], { ...rest, sounds: {} }), []), true);
  assert.equal(stageChanged(saved, stageOf([cam, screen, logo], { ...rest, mirror: true }), []), true);
  assert.equal(stageChanged(saved, stageOf([cam, screen, logo], { ...rest, names: { camera: 'other' } }), []), true);
});

test('dirty ignores what a reload changes on its own: picture ids, key order, a screen not shared yet, a hidden extra, a fresh level row', () => {
  const saved = storedStage(stageOf([cam, screen, logo], rest))!;
  assert.equal(stageChanged(saved, stageOf([cam, screen, { ...logo, id: 'i7' }], rest), []), false);
  const shuffled = { ...rest, levels: { master: rest.levels.master!, mic: rest.levels.mic! } };
  assert.equal(stageChanged(saved, stageOf([cam, screen, logo], shuffled), []), false);
  assert.equal(stageChanged(saved, stageOf([cam, logo], rest), []), false);
  assert.equal(stageChanged(saved, stageOf([cam, logo], rest), ['s1']), true);
  assert.equal(stageChanged(saved, stageOf([{ ...sticker, shown: false }, cam, screen, logo], rest), []), false);
  assert.equal(stageChanged(saved, stageOf([sticker, cam, screen, logo], rest), []), true);
  const fresh = { ...rest, levels: { ...rest.levels, desktop: { level: 1, muted: false } } };
  assert.equal(stageChanged(saved, stageOf([cam, screen, logo], fresh), []), false);
  const moved = { ...rest, levels: { ...rest.levels, desktop: { level: 0.5, muted: false } } };
  assert.equal(stageChanged(saved, stageOf([cam, screen, logo], moved), []), true);
  assert.equal(sameStage(saved, saved), true);
});

test('a stored preset with a picture and a sound still loads with the + menu entries gone: the picture comes back from the library, the sound stays', () => {
  const stored = JSON.parse(
    JSON.stringify({
      list: [{ id: 'p1', name: 'show', stage: stageOf([screen, cam, logo], rest) }],
      active: 'p1'
    })
  );
  const presets = readPresets(stored);
  const stage = presets.list[0]?.stage;
  assert.ok(stage);
  assert.deepEqual(stage.images.i1, { asset: 7, label: 'logo', ratio: 0.5 });
  assert.deepEqual(stage.sounds.aboing1, { name: 'boing', volume: 0.4, loop: true, hear: false });
  const { sources, gaps } = stagedFrom(stage, [], [7], newId);
  assert.deepEqual(gaps, []);
  const picture = sources.find((s) => s.kind === 'image');
  assert.equal(picture?.asset, 7);
  assert.deepEqual(picture?.box, logo.box);
  assert.deepEqual(readSounds([{ id: 'aboing1', name: 'boing', volume: 0.4, loop: true, hear: false }]), [
    { id: 'aboing1', name: 'boing', volume: 0.4, loop: true, hear: false }
  ]);
});

test('a new preset starts blank: nothing on stage, devices kept, and it survives storage next to a full one', () => {
  const full = stageOf([screen, cam, logo], rest);
  const blank = blankStage(full);
  assert.deepEqual(blank.scene, {});
  assert.deepEqual(blank.images, {});
  assert.deepEqual(blank.sounds, {});
  assert.deepEqual(blank.names, {});
  assert.equal(blank.model, null);
  assert.equal(blank.solo, false);
  assert.equal(blank.camera, 'cam-b');
  assert.equal(blank.mic, 'mic-b');
  const raw = JSON.parse(JSON.stringify({ list: [{ id: 'default', stage: full }, { id: 'p2', name: 'preset 2', stage: blank }], active: 'p2' }));
  const presets = readPresets(raw);
  assert.equal(presets.active, 'p2');
  assert.deepEqual(presets.list[1]?.stage, blank);
  assert.deepEqual(Object.keys(presets.list[0]?.stage?.scene ?? {}), ['s1', 'cam', 'i1']);
  const staged = stagedFrom(blank, [screen, cam, logo], [7], newId);
  assert.equal(staged.sources.some((s) => s.shown), false);
  assert.equal(staged.sources.some((s) => s.kind === 'image'), false);
  assert.deepEqual(staged.gaps, []);
  assert.deepEqual(blank.texts, {});
  assert.equal(stagedFrom(blank, [cam, lower], [], newId).sources.some((s) => s.kind === 'text'), false);
});

test('a saved preset keeps its text: the words, the style, the box and where it sits, and puts it back on load', () => {
  const stage = saved([screen, cam, lower]);
  assert.deepEqual(Object.keys(stage.scene), ['s1', 'cam', 't1']);
  assert.deepEqual(stage.texts.t1, { text: 'billy is live', style: lower.style });
  assert.equal(stagedKind('t1', stage), 'text');
  const { sources, gaps } = stagedFrom(stage, [cam, screen], [], newId);
  assert.deepEqual(gaps, []);
  assert.deepEqual(
    sources.map((s) => s.id),
    ['s1', 'cam', 't1']
  );
  const back = sources.find((s) => s.id === 't1');
  assert.deepEqual(back, lower);
  const edited = stagedFrom(stage, [cam, screen, { ...lower, text: 'changed', box: { x: 0, y: 0, w: 0.2, h: 0.1 } }], [], newId).sources.find((s) => s.id === 't1');
  assert.equal(edited?.text, 'billy is live');
  assert.deepEqual(edited?.box, lower.box);
});

test('a saved text is never mistaken for a screen, and text not in the preset is dropped like a picture', () => {
  const stage = saved([cam, lower]);
  const { sources } = stagedFrom(stage, [], [], newId);
  assert.deepEqual(
    sources.map((s) => [s.id, s.kind, s.waiting === true]),
    [
      ['cam', 'camera', true],
      ['t1', 'text', false]
    ]
  );
  const other = stagedFrom(saved([cam]), [cam, lower, { ...lower, id: 't2' }], [], newId).sources;
  assert.deepEqual(
    other.map((s) => s.id),
    ['cam']
  );
});

test('text dirties the preset when its words, style or box change, and empty text is not saved', () => {
  const stage = storedStage(stageOf([cam, lower], rest))!;
  assert.equal(stageChanged(stage, stageOf([cam, lower], rest), []), false);
  assert.equal(stageChanged(stage, stageOf([cam, { ...lower, text: 'brb' }], rest), []), true);
  assert.equal(stageChanged(stage, stageOf([cam, { ...lower, style: { ...lower.style!, color: '#ff0000' } }], rest), []), true);
  assert.equal(stageChanged(stage, stageOf([cam, { ...lower, box: { ...lower.box, y: 0.1 } }], rest), []), true);
  const empty = stageOf([cam, { ...lower, text: '  ' }], rest);
  assert.deepEqual(empty.texts, {});
  assert.deepEqual(Object.keys(empty.scene), ['cam']);
});

test('stored text is cleaned on read: capped words, a clamped style, and junk dropped', () => {
  const stage = readStage({
    scene: { t1: { box: { x: 0, y: 0, w: 0.5, h: 0.1 }, shown: true }, t2: { box: { x: 0, y: 0, w: 0.5, h: 0.1 }, shown: true } },
    texts: { t1: { text: 'x'.repeat(500), style: { size: 4, color: 'red', bg: 'nope' } }, t2: { text: '   ' }, 'Bad Id': { text: 'hi' } }
  });
  assert.ok(stage);
  assert.deepEqual(Object.keys(stage.texts), ['t1']);
  assert.equal(stage.texts.t1!.text.length, 120);
  assert.deepEqual(stage.texts.t1!.style, { size: 0.5, color: '#ffffff' });
  assert.equal(stagedKind('t2', stage), 'screen');
});
