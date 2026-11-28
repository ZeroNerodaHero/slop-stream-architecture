import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  cleanSourceName,
  inputKindOf,
  isSoundId,
  nameKey,
  readNames,
  readSounds,
  renamed,
  SOUND_MAX_BYTES,
  SOUNDS_MAX,
  sectionsOf,
  soundNameOf,
  soundRefusal
} from '../src/infra/source-settings.ts';

test('rigging and model settings belong to the model source alone', () => {
  assert.equal(inputKindOf('camera', true), 'model');
  assert.equal(inputKindOf('camera', false), 'camera');
  assert.equal(inputKindOf('screen', true), 'screen');
  for (const kind of ['camera', 'screen', 'image', 'avatar', 'sound'] as const) {
    const sections = sectionsOf(kind);
    assert.equal(sections.includes('rigging'), false, kind);
    assert.equal(sections.includes('model'), false, kind);
  }
  assert.deepEqual(sectionsOf('model'), ['fill', 'model', 'rigging']);
  assert.ok(sectionsOf('camera').includes('device'));
  assert.ok(sectionsOf('image').includes('fitCamera'));
  assert.deepEqual(sectionsOf('sound'), ['playback']);
});

test('a name is kept by what the source is, not by its place in the list', () => {
  assert.equal(nameKey({ kind: 'camera' }, false), 'camera');
  assert.equal(nameKey({ kind: 'camera' }, true), 'model');
  assert.equal(nameKey({ kind: 'screen', slot: 2 }, false), 'screen2');
  assert.equal(nameKey({ kind: 'image', asset: 41 }, false), 'image41');
  assert.equal(nameKey({ kind: 'avatar' }, false), 'avatar');
});

test('kept names are cleaned, and junk is dropped', () => {
  assert.deepEqual(readNames(null), {});
  assert.deepEqual(readNames(['camera']), {});
  assert.deepEqual(readNames({ camera: '  my   cam ', model: 3, nope: 'x', screen1: '   ', image7: 'logo' }), { camera: 'my cam', image7: 'logo' });
  assert.equal(cleanSourceName('x'.repeat(80)).length, 32);
});

test('renaming back to the default or to nothing forgets the name', () => {
  assert.deepEqual(renamed({}, 'camera', ' face cam ', 'camera'), { camera: 'face cam' });
  assert.deepEqual(renamed({ camera: 'face cam' }, 'camera', 'camera', 'camera'), {});
  assert.deepEqual(renamed({ camera: 'face cam' }, 'camera', '   ', 'camera'), {});
});

test('kept sounds load with safe defaults, and bad rows are dropped', () => {
  assert.deepEqual(readSounds('junk'), []);
  assert.deepEqual(readSounds([{ id: 'abcd1' }]), [{ id: 'abcd1', name: 'sound', loop: false, volume: 0.8, hear: true }]);
  assert.deepEqual(readSounds([{ id: 'abcd1', name: ' intro ', loop: true, volume: 3, hear: false }, { id: 'abcd1' }, { id: '../x' }]), [
    { id: 'abcd1', name: 'intro', loop: true, volume: 1, hear: false }
  ]);
  const many = Array.from({ length: 20 }, (_, i) => ({ id: `a${String(i).padStart(4, '0')}` }));
  assert.equal(readSounds(many).length, SOUNDS_MAX);
  assert.equal(isSoundId('cam'), false);
  assert.equal(isSoundId('s1'), false);
  assert.equal(isSoundId('i1'), false);
});

test('a sound file is refused when it is not audio, too big, or one too many', () => {
  assert.equal(soundRefusal({ name: 'a.mp3', type: 'audio/mpeg', size: 10 }, 0), null);
  assert.equal(soundRefusal({ name: 'a.flac', type: '', size: 10 }, 0), null);
  assert.equal(soundRefusal({ name: 'a.png', type: 'image/png', size: 10 }, 0), 'that is not a sound file');
  assert.equal(soundRefusal({ name: 'a.mp3', type: 'audio/mpeg', size: SOUND_MAX_BYTES + 1 }, 0), 'too big: 20 MB at most');
  assert.equal(soundRefusal({ name: 'a.mp3', type: 'audio/mpeg', size: 10 }, SOUNDS_MAX), '8 sounds at most');
  assert.equal(soundNameOf('airhorn.final.mp3'), 'airhorn.final');
  assert.equal(soundNameOf('.mp3'), 'sound');
});
