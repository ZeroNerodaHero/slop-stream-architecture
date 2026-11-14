/**
 * A face as numbers (docs/vtuber.md): where the head is turned and what the face is doing,
 * worked out from what the face reader says about one camera frame. Pure arithmetic: no dom,
 * no three, no reader. The face worker feeds it readings and hands the pose to the drawing.
 *
 * From a reading to a pose: the resting face is taken off (the first second of a face, or
 * `rest()`), left and right are swapped for a mirror, each score is stretched to 0..1 (a real
 * blink or an open jaw does not score all the way to 1) and every number is smoothed.
 */

/** The 52 scores, in arkit's order: the names a face reader and a "perfect sync" model share. */
export const SHAPES = [
  'eyeBlinkLeft',
  'eyeLookDownLeft',
  'eyeLookInLeft',
  'eyeLookOutLeft',
  'eyeLookUpLeft',
  'eyeSquintLeft',
  'eyeWideLeft',
  'eyeBlinkRight',
  'eyeLookDownRight',
  'eyeLookInRight',
  'eyeLookOutRight',
  'eyeLookUpRight',
  'eyeSquintRight',
  'eyeWideRight',
  'jawForward',
  'jawLeft',
  'jawRight',
  'jawOpen',
  'mouthClose',
  'mouthFunnel',
  'mouthPucker',
  'mouthLeft',
  'mouthRight',
  'mouthSmileLeft',
  'mouthSmileRight',
  'mouthFrownLeft',
  'mouthFrownRight',
  'mouthDimpleLeft',
  'mouthDimpleRight',
  'mouthStretchLeft',
  'mouthStretchRight',
  'mouthRollLower',
  'mouthRollUpper',
  'mouthShrugLower',
  'mouthShrugUpper',
  'mouthPressLeft',
  'mouthPressRight',
  'mouthLowerDownLeft',
  'mouthLowerDownRight',
  'mouthUpperUpLeft',
  'mouthUpperUpRight',
  'browDownLeft',
  'browDownRight',
  'browInnerUp',
  'browOuterUpLeft',
  'browOuterUpRight',
  'cheekPuff',
  'cheekSquintLeft',
  'cheekSquintRight',
  'noseSneerLeft',
  'noseSneerRight',
  'tongueOut'
] as const;
export type Shape = (typeof SHAPES)[number];
export const SHAPE_COUNT = SHAPES.length;
const INDEX = new Map<string, number>(SHAPES.map((name, i) => [name, i]));
/** A shape's place in a pose's `shapes`. */
export const shapeIndex = (name: Shape): number => INDEX.get(name)!;

/** Each shape's twin on the other side of the face, by index (itself when it has none): a mirror swaps them. */
const TWIN: readonly number[] = SHAPES.map((name, i) => {
  const other = name.endsWith('Left') ? `${name.slice(0, -4)}Right` : name.endsWith('Right') ? `${name.slice(0, -5)}Left` : name;
  return INDEX.get(other) ?? i;
});

/**
 * Where the head is and what the face is doing, as the model is to wear it (the mirror is
 * already in it). Angles in radians: `yaw` positive turns the model to its own left, `pitch`
 * positive looks down, `roll` positive tips the head to its own right shoulder. `x`, `y`, `z`
 * are how far the head has moved off its rest, in centimetres: to the model's left, up, towards
 * the camera. `shapes` are 0..1, each on the model's own side.
 */
export interface Pose {
  /** A face is in view. False: the numbers are the last ones seen, easing home is the drawer's. */
  face: boolean;
  yaw: number;
  pitch: number;
  roll: number;
  x: number;
  y: number;
  z: number;
  shapes: Float32Array;
}

export const restPose = (): Pose => ({ face: false, yaw: 0, pitch: 0, roll: 0, x: 0, y: 0, z: 0, shapes: new Float32Array(SHAPE_COUNT) });

/** The frames the resting face is taken from: under a second of a camera. */
const REST_FRAMES = 20;
/** Room noise on a score: under this much above its floor it is nothing. */
const DEAD = 0.02;
/**
 * Where each kind of score tops out on a real face: past it the shape is all the way on. Read
 * off a face talking to a camera, not guessed: a jaw in ordinary speech scores 0.15 and 0.3 is
 * loud, a blink peaks near 0.65 over open eyes that already score 0.2.
 */
const TOP_BLINK = 0.5;
const TOP_JAW = 0.35;
const TOP_DEFAULT = 0.6;
const TOPS: readonly number[] = SHAPES.map((name) => (name.startsWith('eyeBlink') ? TOP_BLINK : name === 'jawOpen' ? TOP_JAW : TOP_DEFAULT));
/**
 * A floor follows its score after the resting second too, so a rest taken mid-word mends
 * itself: down fast and up slowly. The mouth's floors sit at the least the score has been (a
 * shut mouth is the lowest it goes); the rest sit low in their usual range, where open eyes and
 * a brow at ease are, not at the one widest stare. Per reading.
 */
const MOUTH_FALL = 0.2;
const MOUTH_RISE = 0.0003;
const FACE_FALL = 0.003;
const FACE_RISE = 0.001;
const IS_MOUTH: readonly boolean[] = SHAPES.map((name) => name.startsWith('jaw') || name.startsWith('mouth'));
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * The one euro filter: a low pass whose cutoff rises with speed, so a still head does not
 * tremble and a fast one does not lag. `minCutoff` in Hz is the stillness; `beta` how fast the
 * cutoff opens up.
 */
class OneEuro {
  private x = 0;
  private dx = 0;
  private at = -1;
  constructor(
    private readonly minCutoff: number,
    private readonly beta: number
  ) {}
  private static alpha(cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
  /** `value` at `t` seconds, smoothed. */
  next(value: number, t: number): number {
    if (this.at < 0 || t <= this.at) {
      this.x = value;
      this.dx = 0;
      this.at = t;
      return value;
    }
    const dt = t - this.at;
    this.at = t;
    const rate = (value - this.x) / dt;
    this.dx += (rate - this.dx) * OneEuro.alpha(1, dt);
    this.x += (value - this.x) * OneEuro.alpha(this.minCutoff + this.beta * Math.abs(this.dx), dt);
    return this.x;
  }
  reset() {
    this.at = -1;
  }
}

/** The middle of `values`, or the value a quarter of the way up: a blink or a word in the resting second does not move it. */
function quantile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
}

/** One reading of a face: the head as the reader's 4x4 (column by column, centimetres), and the 52 scores. */
export interface Reading {
  matrix: ArrayLike<number>;
  shapes: Float32Array;
}

/** The head's turn and place out of the reader's matrix: `[yaw, pitch, roll, x, y, z]`, the subject's own, before any rest or mirror. */
export function headOf(m: ArrayLike<number>): [number, number, number, number, number, number] {
  // the three axes, each made a unit: the matrix carries the face's size too
  const sx = Math.hypot(m[0]!, m[1]!, m[2]!) || 1;
  const sy = Math.hypot(m[4]!, m[5]!, m[6]!) || 1;
  const sz = Math.hypot(m[8]!, m[9]!, m[10]!) || 1;
  // euler angles in the order yaw, pitch, roll: how a head turns
  const pitch = Math.asin(-Math.min(1, Math.max(-1, m[9]! / sz)));
  const yaw = Math.atan2(m[8]! / sz, m[10]! / sz);
  const roll = Math.atan2(m[1]! / sx, m[5]! / sy);
  return [yaw, pitch, roll, m[12]!, m[13]!, m[14]!];
}

/**
 * Readings in, a pose out. Holds the resting face, the mirror and the smoothing. One per face
 * reader; `update` is called once per reading, with `null` when the frame had no face in it.
 */
export class FaceTracker {
  /** The model moves like a mirror: the streamer turns to their left and it turns to the left of the picture. */
  mirror = true;
  private readonly pose = restPose();
  /** The resting face: the head's zero and each score's floor. `null` until it has been taken. */
  private home: { head: number[]; floors: Float32Array } | null = null;
  /** The readings the resting face is being taken from. */
  private sample: { head: number[][]; shapes: Float32Array[] } = { head: [], shapes: [] };
  private readonly headFilters = [
    new OneEuro(1.2, 0.5),
    new OneEuro(1.2, 0.5),
    new OneEuro(1.2, 0.5),
    new OneEuro(0.6, 0.02),
    new OneEuro(0.6, 0.02),
    new OneEuro(0.4, 0.02)
  ];
  // the mouth and the blinks are quick, the rest of a face is not
  private readonly shapeFilters = SHAPES.map((name) =>
    name.startsWith('eyeBlink') || name.startsWith('jaw') || name.startsWith('mouth') ? new OneEuro(5, 3) : new OneEuro(2, 1)
  );

  /** Take the resting face again, from the next readings. */
  rest() {
    this.home = null;
    this.sample = { head: [], shapes: [] };
  }

  /** The pose after this reading, at `now` milliseconds. The same object every time. */
  update(reading: Reading | null, now: number): Pose {
    const pose = this.pose;
    if (!reading) {
      pose.face = false;
      for (const filter of this.headFilters) filter.reset();
      for (const filter of this.shapeFilters) filter.reset();
      return pose;
    }
    pose.face = true;
    const head = headOf(reading.matrix);
    if (!this.home) {
      this.sample.head.push(head);
      this.sample.shapes.push(reading.shapes.slice());
      if (this.sample.head.length < REST_FRAMES) return pose;
      const { head: heads, shapes } = this.sample;
      this.home = {
        head: head.map((_, i) =>
          quantile(
            heads.map((h) => h[i]!),
            0.5
          )
        ),
        floors: Float32Array.from({ length: SHAPE_COUNT }, (_, i) =>
          quantile(
            shapes.map((s) => s[i]!),
            0.25
          )
        )
      };
      this.sample = { head: [], shapes: [] };
    }
    const t = now / 1000;
    const side = this.mirror ? -1 : 1;
    const { head: home, floors } = this.home;
    pose.yaw = this.headFilters[0]!.next(head[0] - home[0]!, t) * side;
    pose.pitch = this.headFilters[1]!.next(head[1] - home[1]!, t);
    pose.roll = this.headFilters[2]!.next(head[2] - home[2]!, t) * side;
    pose.x = this.headFilters[3]!.next(head[3] - home[3]!, t) * side;
    pose.y = this.headFilters[4]!.next(head[4] - home[4]!, t);
    pose.z = this.headFilters[5]!.next(head[5] - home[5]!, t);
    for (let i = 0; i < SHAPE_COUNT; i++) {
      const score = reading.shapes[i]!;
      const gap = score - floors[i]!;
      floors[i]! += gap * (gap < 0 ? (IS_MOUTH[i] ? MOUTH_FALL : FACE_FALL) : IS_MOUTH[i] ? MOUTH_RISE : FACE_RISE);
      const floor = floors[i]!;
      const raw = clamp01((score - floor - DEAD) / Math.max(0.05, TOPS[i]! - floor - DEAD));
      // the score lands on its twin's place under a mirror: the subject's left eye is the picture's right
      pose.shapes[this.mirror ? TWIN[i]! : i] = clamp01(this.shapeFilters[i]!.next(raw, t));
    }
    return pose;
  }
}
