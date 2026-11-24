import { type VRM, VRMExpression, VRMExpressionManager, VRMExpressionMorphTargetBind } from '@pixiv/three-vrm';
import type { Mesh } from 'three';

import type { RigInfo, RigPart } from '@/infra/face-wire';
import { type Mood, moodOf, type Shape, SHAPE_COUNT, SHAPES, shapeIndex } from '@/infra/pose';

export interface FaceRig {
  readonly info: RigInfo;
  moods: boolean;
  apply(shapes: Float32Array, face: boolean, clock: number): void;
}

const BLINK_S = 0.16;
const BLINK_EVERY_MIN_S = 2.4;
const BLINK_EVERY_MAX_S = 5.5;
const SAME_BLINK = 0.25;
const LOOK_YAW = 22;
const LOOK_PITCH = 14;
const ARKIT_ENOUGH = 26;
const EYE_SMILE_FROM = 0.75;
const EYE_SMILE_MOST = 0.35;
const MOOD_FROM = 0.25;
const MOOD_ON = 0.75;
const MOOD_OFF = 0.5;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const NO_MOOD: Mood = { browUp: 0, browDown: 0, smile: 0, wide: 0 };
const MOODY: readonly boolean[] = SHAPES.map((name) => /^(brow|cheek|nose|eyeWide|eyeSquint|mouthSmile|mouthFrown|mouthDimple)/.test(name));
const LOOKS: readonly Shape[] = SHAPES.filter((name) => name.startsWith('eyeLook'));

const plain = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');
function spellings(shape: Shape): string[] {
  const name = plain(shape);
  if (name.endsWith('left')) return [name, `${name.slice(0, -4)}l`];
  if (name.endsWith('right')) return [name, `${name.slice(0, -5)}r`];
  return [name];
}

export interface Target {
  mesh: Mesh;
  index: number;
}
export type MorphTargets = ReadonlyMap<string, Target[]>;

type Made = 'browUp' | 'browDown' | 'smile' | 'eyeSmile' | 'eyeWide';
const NAME: Record<Made, string> = { browUp: 'rig:browUp', browDown: 'rig:browDown', smile: 'rig:smile', eyeSmile: 'rig:eyeSmile', eyeWide: 'rig:eyeWide' };
const SOURCES: Record<Made, readonly (readonly (readonly [RegExp, number])[])[]> = {
  browUp: [[[/Fcl_BRW_Surprised$/, 1]], [[/brow[_ ]?up$/i, 1]], [[/^上$/, 1]]],
  browDown: [
    [
      [/Fcl_BRW_Angry$/, 1],
      [/Fcl_EYE_Angry$/, 0.5]
    ],
    [[/brow[_ ]?down$/i, 1]],
    [[/^怒り$/, 1]]
  ],
  smile: [[[/Fcl_MTH_Fun$/, 1]], [[/(^|[._ ])mouth[_ ]?smile$/i, 1]], [[/^(にやり|にっこり|口角上げ)$/, 1]]],
  eyeSmile: [[[/Fcl_EYE_Joy$/, 1]], [[/(^|[._ ])eyes?[_ ]?smile$/i, 1]], [[/^笑い$/, 1]]],
  eyeWide: [[[/Fcl_EYE_Surprised$/, 1]], [[/^びっくり$/, 1]]]
};

type Promised = 'aa' | 'ih' | 'ou' | 'ee' | 'oh' | 'blink' | 'blinkLeft' | 'blinkRight' | 'happy' | 'angry';
const CALLED: Record<Promised, readonly string[]> = {
  aa: ['vaa', 'visemeaa', 'fclmtha', 'あ', 'aa', 'a', 'lipa', 'moutha', 'mouthopen', 'jawopen'],
  ih: ['vih', 'visemei', 'fclmthi', 'い', 'ih', 'i', 'lipi', 'mouthi'],
  ou: ['vou', 'visemeu', 'fclmthu', 'う', 'ou', 'u', 'lipu', 'mouthu'],
  ee: ['ve', 'visemee', 'fclmthe', 'え', 'ee', 'e', 'lipe', 'mouthe'],
  oh: ['voh', 'visemeo', 'fclmtho', 'お', 'oh', 'o', 'lipo', 'moutho'],
  blink: ['blink', 'fcleyeclose', 'まばたき', '瞬き', 'eyesclosed', 'eyeclose', 'eyeblink'],
  blinkLeft: ['blinkleft', 'blinkl', 'fcleyeclosel', 'ウィンク2', 'ウィンク', 'winkleft', 'winkl', 'eyeblinkleft', 'eyeblinkl'],
  blinkRight: ['blinkright', 'blinkr', 'fcleyecloser', 'ウィンク2右', 'ウィンク右', 'winkright', 'winkr', 'eyeblinkright', 'eyeblinkr'],
  happy: ['happy', 'joy', 'facehappy', 'fclalljoy'],
  angry: ['angry', 'faceangry', 'fclallangry']
};
const called = (name: string) =>
  name
    .slice(name.lastIndexOf('.') + 1)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');

export function expressionsOf(targets: MorphTargets): VRMExpressionManager {
  const manager = new VRMExpressionManager();
  const byName = new Map<string, Target[]>();
  for (const [name, hits] of targets) byName.set(called(name), [...(byName.get(called(name)) ?? []), ...hits]);
  const make = (name: string, hits: Target[] | undefined) => {
    if (!hits) return;
    const expression = new VRMExpression(name);
    for (const hit of hits) expression.addBind(new VRMExpressionMorphTargetBind({ primitives: [hit.mesh], index: hit.index, weight: 1 }));
    manager.registerExpression(expression);
  };
  for (const shape of SHAPES) {
    make(
      shape,
      spellings(shape)
        .map((spelling) => byName.get(spelling))
        .find((hits) => hits !== undefined)
    );
  }
  for (const promised of Object.keys(CALLED) as Promised[]) {
    const name =
      CALLED[promised].find((known) => byName.has(known)) ??
      [...byName.keys()].find((own) => CALLED[promised].some((known) => known.startsWith('fcl') && own.endsWith(known)));
    make(promised, name === undefined ? undefined : byName.get(name));
  }
  return manager;
}

export function buildRig(vrm: VRM, targets: MorphTargets): FaceRig {
  const expressions = vrm.expressionManager ?? null;
  const bound = (name: string) => (expressions?.getExpression(name)?.binds.length ?? 0) > 0;
  const set = (name: string, weight: number) => expressions?.setValue(name, weight);

  const own = new Map<string, string>();
  for (const name of Object.keys(expressions?.expressionMap ?? {})) if (bound(name)) own.set(plain(name), name);
  const arkit: (string | null)[] = SHAPES.map(
    (shape) =>
      spellings(shape)
        .map((spelling) => own.get(spelling))
        .find((name) => name !== undefined) ?? null
  );
  const isArkit = arkit.filter((name) => name !== null).length >= ARKIT_ENOUGH;
  const has = (shape: Shape) => isArkit && arkit[shapeIndex(shape)] !== null;

  const made = new Set<Made>();
  if (expressions && !isArkit) {
    const find = (pattern: RegExp) => [...targets].filter(([name]) => pattern.test(name)).flatMap(([, hits]) => hits);
    for (const key of Object.keys(SOURCES) as Made[]) {
      if (key === 'eyeSmile' && !made.has('smile')) continue;
      for (const way of SOURCES[key]) {
        if (find(way[0]![0]).length === 0) continue;
        const expression = new VRMExpression(NAME[key]);
        for (const [pattern, weight] of way) {
          for (const hit of find(pattern)) expression.addBind(new VRMExpressionMorphTargetBind({ primitives: [hit.mesh], index: hit.index, weight }));
        }
        if (key === 'eyeSmile') expression.overrideBlink = 'blend';
        expressions.registerExpression(expression);
        made.add(key);
        break;
      }
    }
  }

  const wholeFace = (name: 'happy' | 'angry'): ((x: number) => number) | null => {
    const expression = isArkit || !bound(name) ? null : expressions!.getExpression(name);
    if (!expression) return null;
    if (name === 'happy' && vrm.meta.metaVersion === '0' && expression.overrideBlink === 'none') expression.overrideBlink = 'blend';
    let on = false;
    return (x) => {
      if (!expression.isBinary) return clamp01((x - MOOD_FROM) / (1 - MOOD_FROM));
      on = x > (on ? MOOD_OFF : MOOD_ON);
      return on ? 1 : 0;
    };
  };
  const happy = made.has('smile') ? null : wholeFace('happy');
  const angry = made.has('browDown') ? null : wholeFace('angry');

  const lookAt = vrm.lookAt ?? null;
  const eachEye = bound('blinkLeft') && bound('blinkRight');
  const vowels = (['aa', 'ih', 'ou', 'ee', 'oh'] as const).some(bound);
  const arkitBlink = has('eyeBlinkLeft') && has('eyeBlinkRight');
  const arkitMouth = has('jawOpen');
  const arkitLooks = LOOKS.filter(has).length >= 4;
  const parts: RigPart[] = [];
  if (arkitLooks || (lookAt && (vrm.humanoid.getRawBoneNode('leftEye') !== null || bound('lookLeft')))) parts.push('eyes');
  if (arkitBlink || eachEye || bound('blink')) parts.push('blink');
  if (arkitMouth || vowels) parts.push('mouth');
  if (has('browInnerUp') || has('browDownLeft') || made.has('browUp') || made.has('browDown') || angry) parts.push('brows');
  if (has('mouthSmileLeft') || made.has('smile') || happy) parts.push('smile');
  const moves = parts.some((part) => part !== 'eyes');
  const info: RigInfo = { kind: isArkit ? 'arkit' : made.size > 0 ? 'shapes' : moves ? 'presets' : 'none', parts };

  let nextBlink = BLINK_EVERY_MIN_S;
  const rig: FaceRig = {
    info,
    moods: true,
    apply(shapes, face, clock) {
      const shape = (name: Shape) => shapes[shapeIndex(name)]!;

      let left = shape('eyeBlinkLeft');
      let right = shape('eyeBlinkRight');
      if (!face) {
        if (clock >= nextBlink + BLINK_S) nextBlink = clock + BLINK_EVERY_MIN_S + Math.random() * (BLINK_EVERY_MAX_S - BLINK_EVERY_MIN_S);
        const through = (clock - nextBlink) / BLINK_S;
        left = right = Math.max(left, through > 0 && through < 1 ? 1 - Math.abs(through * 2 - 1) : 0);
      } else if (Math.abs(left - right) < SAME_BLINK) {
        left = right = (left + right) / 2;
      }

      if (expressions) {
        if (isArkit) {
          for (let i = 0; i < SHAPE_COUNT; i++) {
            const name = arkit[i];
            if (name) set(name, rig.moods || !MOODY[i] ? shapes[i]! : 0);
          }
        }
        if (arkitBlink) {
          set(arkit[shapeIndex('eyeBlinkLeft')]!, left);
          set(arkit[shapeIndex('eyeBlinkRight')]!, right);
        } else if (eachEye) {
          set('blinkLeft', left);
          set('blinkRight', right);
        } else {
          set('blink', (left + right) / 2);
        }

        if (!arkitMouth) {
          let aa = shape('jawOpen');
          let oh = shape('mouthFunnel');
          let ou = shape('mouthPucker');
          let ih = (shape('mouthUpperUpLeft') + shape('mouthUpperUpRight')) / 2;
          const sum = aa + oh + ou + ih;
          if (sum > 1) {
            aa /= sum;
            oh /= sum;
            ou /= sum;
            ih /= sum;
          }
          set('aa', aa);
          set('oh', oh);
          set('ou', ou);
          set('ih', ih);
        }

        if (!isArkit) {
          const mood = rig.moods ? moodOf(shapes) : NO_MOOD;
          set(NAME.browUp, mood.browUp);
          set(NAME.browDown, mood.browDown);
          set(NAME.smile, mood.smile);
          set(NAME.eyeSmile, clamp01((mood.smile - EYE_SMILE_FROM) / (1 - EYE_SMILE_FROM)) * EYE_SMILE_MOST);
          set(NAME.eyeWide, mood.wide);
          if (happy) set('happy', happy(mood.smile));
          if (angry) set('angry', angry(mood.browDown));
        }
      }

      if (lookAt) {
        const yaw = (shape('eyeLookOutLeft') - shape('eyeLookInLeft') + shape('eyeLookInRight') - shape('eyeLookOutRight')) / 2;
        const up = (shape('eyeLookUpLeft') + shape('eyeLookUpRight') - shape('eyeLookDownLeft') - shape('eyeLookDownRight')) / 2;
        lookAt.yaw = arkitLooks ? 0 : Math.min(1, Math.max(-1, yaw)) * LOOK_YAW;
        lookAt.pitch = arkitLooks ? 0 : Math.min(1, Math.max(-1, -up)) * LOOK_PITCH;
      }
    }
  };
  return rig;
}
