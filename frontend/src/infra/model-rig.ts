/**
 * A model's face, and what moves it (docs/vtuber.md). A vrm promises a few expressions by name:
 * five vowels, the blinks, five moods. Most models carry more than that, under names of their
 * own. This looks once at what one model has and settles how the face reader's 52 scores reach
 * it (`RigInfo.kind`):
 *
 * - `arkit`: the model has the reader's own 52 as expressions ("perfect sync"). Each score goes
 *   to the expression of its name and nothing is worked out.
 * - `shapes`: its face mesh has the brows, the eyes and a smile as morphs of their own, as every
 *   model out of vroid studio does. Expressions are made of those here, so brows follow brows
 *   and a smile is a smile, beside the vowels and the blinks.
 * - `presets`: only what a vrm promises. The vowels and the blinks; a clear smile is `happy`
 *   and brows drawn hard down are `angry`, as whole faces.
 * - `none`: no expression of its moves anything. The head still turns.
 *
 * `buildRig` runs before `VRMUtils.combineMorphs`: that keeps only the morphs some expression
 * uses, and the ones made here have to be among them.
 *
 * A model that is no vrm (a glb, an fbx) promises nothing: it has morphs, named the way the
 * tool that made it names them. `expressionsOf` gives it the expressions a vrm would have, out
 * of those names, and from there it is a model like any other.
 */

import { type VRM, VRMExpression, VRMExpressionManager, VRMExpressionMorphTargetBind } from '@pixiv/three-vrm';
import type { Mesh } from 'three';

import type { RigInfo, RigPart } from '@/infra/face-wire';
import { type Mood, moodOf, type Shape, SHAPE_COUNT, SHAPES, shapeIndex } from '@/infra/pose';

export interface FaceRig {
  readonly info: RigInfo;
  /** The brows, the smile and the wide eyes move the model too. Off: the mouth, the blinks and the eyes alone. */
  moods: boolean;
  /**
   * The face for one frame. `shapes` are a pose's, already eased by the drawer; `face` is
   * whether one is in view (with none the model blinks on its own); `clock` is how long the
   * model has been drawn for, in seconds.
   */
  apply(shapes: Float32Array, face: boolean, clock: number): void;
}

/** With no face to read, a blink this long every few seconds. */
const BLINK_S = 0.16;
const BLINK_EVERY_MIN_S = 2.4;
const BLINK_EVERY_MAX_S = 5.5;
/** Two eyes that close about as far as each other are one blink: a reader's two readings of it differ by noise. */
const SAME_BLINK = 0.25;
/** Eyes all the way to one side, in degrees. */
const LOOK_YAW = 22;
const LOOK_PITCH = 14;
/** This many of the reader's 52 among a model's expressions is perfect sync. Fewer is a model that shares a name or two. */
const ARKIT_ENOUGH = 26;
/**
 * A broad smile narrows the eyes: from here up, and this far at the most. A little of the way
 * only: further, the lids come down flat long before they curve, and a grin looks half asleep.
 */
const EYE_SMILE_FROM = 0.75;
const EYE_SMILE_MOST = 0.35;
/**
 * A whole face from one number (`happy`, `angry`): eased in from `MOOD_FROM`. A model that says
 * a mood is all or nothing gets it switched instead, on over `MOOD_ON` and off again under
 * `MOOD_OFF`: only for a look that is meant, and a number near the line does not flicker a face.
 */
const MOOD_FROM = 0.25;
const MOOD_ON = 0.75;
const MOOD_OFF = 0.5;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const NO_MOOD: Mood = { browUp: 0, browDown: 0, smile: 0, wide: 0 };
/** The scores that are a mood and not a word, a blink or a look: what `moods` turns off on a perfect sync model. */
const MOODY: readonly boolean[] = SHAPES.map((name) => /^(brow|cheek|nose|eyeWide|eyeSquint|mouthSmile|mouthFrown|mouthDimple)/.test(name));
const LOOKS: readonly Shape[] = SHAPES.filter((name) => name.startsWith('eyeLook'));

/** A name with nothing but its letters and digits: how `EyeBlink_L` and `eyeBlinkLeft` are told to be the same. */
const plain = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');
/** The ways a model may spell one of the 52: in full, or with its side as one letter. */
function spellings(shape: Shape): string[] {
  const name = plain(shape);
  if (name.endsWith('left')) return [name, `${name.slice(0, -4)}l`];
  if (name.endsWith('right')) return [name, `${name.slice(0, -5)}r`];
  return [name];
}

/** One morph target, on one primitive of a mesh. */
export interface Target {
  mesh: Mesh;
  index: number;
}
/** Every morph target of a model by the name its file gives it, on every primitive that has it (`model-load.ts` reads them). */
export type MorphTargets = ReadonlyMap<string, Target[]>;

/** The expressions made here, and their names: no model's own can be in their way. */
type Made = 'browUp' | 'browDown' | 'smile' | 'eyeSmile' | 'eyeWide';
const NAME: Record<Made, string> = { browUp: 'rig:browUp', browDown: 'rig:browDown', smile: 'rig:smile', eyeSmile: 'rig:eyeSmile', eyeWide: 'rig:eyeWide' };
/**
 * Where a face mesh keeps what each is made of: ways to find it, and the first that is there
 * wins. A way is morph targets by the end of their names, each with how much of it; the first
 * of a way has to be there, the others come along when they are. Vroid studio's names first
 * (`Face.M_F00_000_00_Fcl_BRW_Angry`: most vrm files come out of it), then the plain names
 * other tools write, then mmd's, which a model made for vrchat often carries too.
 */
const SOURCES: Record<Made, readonly (readonly (readonly [RegExp, number])[])[]> = {
  browUp: [[[/Fcl_BRW_Surprised$/, 1]], [[/brow[_ ]?up$/i, 1]], [[/^上$/, 1]]],
  // brows drawn down narrow the eyes with them
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

/** The expressions a vrm promises that the reader moves: the vowels, the blinks, and the two moods the rig falls back on. */
type Promised = 'aa' | 'ih' | 'ou' | 'ee' | 'oh' | 'blink' | 'blinkLeft' | 'blinkRight' | 'happy' | 'angry';
/**
 * What other tools call them, each name as `called` leaves it, and the first a model has is the
 * one: vrchat's visemes (`vrc.v_aa`), oculus's (`viseme_aa`), vroid's own morphs (`Fcl_MTH_A`),
 * mmd's (`あ`, `まばたき`, `ウィンク２`), then the plain words a model made by hand has
 * (`lip_a`, `mouthOpen`, `face_happy`). Mmd's `ウィンク` shuts the left eye with a smile in
 * it, and `ウィンク２` shuts it plainly: the plain one first.
 */
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
/**
 * A morph's name as the lists above have it: what a tool put before a dot gone (`blendShape1.`),
 * wide and narrow letters made one kind, and nothing left but letters and digits.
 */
const called = (name: string) =>
  name
    .slice(name.lastIndexOf('.') + 1)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');

/**
 * The expressions of a model that is no vrm, made of its morphs by their names: each of the
 * reader's 52 it has, under the reader's own name (enough of them and it is perfect sync), and
 * the vowels and blinks a vrm promises, from what other tools call them. What it has no morph
 * for is not made, and the rig finds the model without it.
 */
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
    // vroid's morphs keep their mesh's name in front in some files (`Face.M_F00_000_00_Fcl_MTH_A`): those are told by their ends
    const name =
      CALLED[promised].find((known) => byName.has(known)) ??
      [...byName.keys()].find((own) => CALLED[promised].some((known) => known.startsWith('fcl') && own.endsWith(known)));
    make(promised, name === undefined ? undefined : byName.get(name));
  }
  return manager;
}

/**
 * The model's face, looked at once. Makes the expressions a `shapes` model gets (they are
 * registered with the model's own), and hands back what drives all of them each frame.
 */
export function buildRig(vrm: VRM, targets: MorphTargets): FaceRig {
  const expressions = vrm.expressionManager ?? null;
  /** An expression that is there and moves something: a model can list `happy` and bind nothing to it. */
  const bound = (name: string) => (expressions?.getExpression(name)?.binds.length ?? 0) > 0;
  const set = (name: string, weight: number) => expressions?.setValue(name, weight);

  // ---- perfect sync: the reader's own names among the model's expressions ------------------
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

  // ---- the brows, the eyes and a smile, made of the face mesh's own morphs ------------------
  const made = new Set<Made>();
  if (expressions && !isArkit) {
    const find = (pattern: RegExp) => [...targets].filter(([name]) => pattern.test(name)).flatMap(([, hits]) => hits);
    for (const key of Object.keys(SOURCES) as Made[]) {
      // the eyes a smile narrows go with the smile made here (it is made first). a model whose smile is a whole face, `happy`, has that face's eyes
      if (key === 'eyeSmile' && !made.has('smile')) continue;
      for (const way of SOURCES[key]) {
        if (find(way[0]![0]).length === 0) continue;
        const expression = new VRMExpression(NAME[key]);
        for (const [pattern, weight] of way) {
          for (const hit of find(pattern)) expression.addBind(new VRMExpressionMorphTargetBind({ primitives: [hit.mesh], index: hit.index, weight }));
        }
        // eyes shut by a smile are not shut again by a blink
        if (key === 'eyeSmile') expression.overrideBlink = 'blend';
        expressions.registerExpression(expression);
        made.add(key);
        break;
      }
    }
  }

  // ---- the whole faces a vrm promises, for what was not made --------------------------------
  const wholeFace = (name: 'happy' | 'angry'): ((x: number) => number) | null => {
    const expression = isArkit || !bound(name) ? null : expressions!.getExpression(name);
    if (!expression) return null;
    // a 0.x file cannot say that its smile shuts the eyes. most do: without this a blink shuts them twice
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

  // ---- what there is to move ----------------------------------------------------------------
  const lookAt = vrm.lookAt ?? null;
  const eachEye = bound('blinkLeft') && bound('blinkRight');
  const vowels = (['aa', 'ih', 'ou', 'ee', 'oh'] as const).some(bound);
  const arkitBlink = has('eyeBlinkLeft') && has('eyeBlinkRight');
  const arkitMouth = has('jawOpen');
  /** The model has the eyes' turns among its 52: they are driven as scores, and the vrm's own look-at is left alone, or the eyes would turn twice. */
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

      // the blinks: the face's, or with no face to read one of its own every few seconds
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
          // the mouth: one mouth, so the vowels together are never more than all the way open
          let aa = shape('jawOpen');
          let oh = shape('mouthFunnel');
          let ou = shape('mouthPucker');
          // the wide vowel: the upper lip up off the teeth. (the reader's `mouthStretch` never moves on a talking face)
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
          // a name that was not made is not there, and setting it does nothing
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
        // out for one eye is in for the other. positive yaw is the model's own left, negative pitch is up
        const yaw = (shape('eyeLookOutLeft') - shape('eyeLookInLeft') + shape('eyeLookInRight') - shape('eyeLookOutRight')) / 2;
        const up = (shape('eyeLookUpLeft') + shape('eyeLookUpRight') - shape('eyeLookDownLeft') - shape('eyeLookDownRight')) / 2;
        lookAt.yaw = arkitLooks ? 0 : Math.min(1, Math.max(-1, yaw)) * LOOK_YAW;
        lookAt.pitch = arkitLooks ? 0 : Math.min(1, Math.max(-1, -up)) * LOOK_PITCH;
      }
    }
  };
  return rig;
}
