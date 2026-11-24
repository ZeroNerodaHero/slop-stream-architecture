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
export const shapeIndex = (name: Shape): number => INDEX.get(name)!;

const TWIN: readonly number[] = SHAPES.map((name, i) => {
  const other = name.endsWith('Left') ? `${name.slice(0, -4)}Right` : name.endsWith('Right') ? `${name.slice(0, -5)}Left` : name;
  return INDEX.get(other) ?? i;
});

export interface Pose {
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

export interface Mood {
  browUp: number;
  browDown: number;
  smile: number;
  wide: number;
}

const SCOWL_FROM = 0.15;
const at = (shapes: ArrayLike<number>, name: Shape) => shapes[INDEX.get(name)!] ?? 0;
const both = (shapes: ArrayLike<number>, left: Shape, right: Shape) => (at(shapes, left) + at(shapes, right)) / 2;

export function moodOf(shapes: ArrayLike<number>): Mood {
  const down = both(shapes, 'browDownLeft', 'browDownRight');
  const up = Math.max(at(shapes, 'browInnerUp'), both(shapes, 'browOuterUpLeft', 'browOuterUpRight'));
  const browDown = clamp01((down - up - SCOWL_FROM) / (1 - SCOWL_FROM));
  const smile = clamp01(both(shapes, 'mouthSmileLeft', 'mouthSmileRight') * (1 - browDown));
  return {
    browUp: clamp01(up - down),
    browDown,
    smile,
    wide: clamp01(both(shapes, 'eyeWideLeft', 'eyeWideRight') * (1 - smile) * (1 - browDown))
  };
}

const REST_FRAMES = 20;
const DEAD = 0.02;
const TOP_BLINK = 0.5;
const TOP_JAW = 0.35;
const TOP_SMILE = 0.8;
const TOP_WIDE = 0.2;
const TOP_DEFAULT = 0.6;
const TOPS: readonly number[] = SHAPES.map((name) =>
  name.startsWith('eyeBlink')
    ? TOP_BLINK
    : name === 'jawOpen'
      ? TOP_JAW
      : name.startsWith('mouthSmile')
        ? TOP_SMILE
        : name.startsWith('eyeWide')
          ? TOP_WIDE
          : TOP_DEFAULT
);
const MOUTH: readonly [number, number] = [0.2, 0.0003];
const EYES: readonly [number, number] = [0.003, 0.001];
const BROWS: readonly [number, number] = [0.0022, 0.0022];
const SMILE: readonly [number, number] = [0.2, 0.0001];
const isSmile = (name: string) => name.startsWith('mouthSmile');
const isHeld = (name: string) => name.startsWith('brow') || name.startsWith('eyeWide') || name.startsWith('cheek') || name.startsWith('nose');
const FOLLOW: readonly (readonly [number, number])[] = SHAPES.map((name) =>
  isSmile(name) ? SMILE : isHeld(name) ? BROWS : name.startsWith('jaw') || name.startsWith('mouth') ? MOUTH : EYES
);
const SPAN_FROM_ZERO: readonly boolean[] = SHAPES.map((name) => isSmile(name) || isHeld(name));
const SETTLING: readonly boolean[] = SHAPES.map(isHeld);
const SETTLE_FROM = 60;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

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

function quantile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
}

export interface Reading {
  matrix: ArrayLike<number>;
  shapes: Float32Array;
}

export function headOf(m: ArrayLike<number>): [number, number, number, number, number, number] {
  const sx = Math.hypot(m[0]!, m[1]!, m[2]!) || 1;
  const sy = Math.hypot(m[4]!, m[5]!, m[6]!) || 1;
  const sz = Math.hypot(m[8]!, m[9]!, m[10]!) || 1;
  const pitch = Math.asin(-Math.min(1, Math.max(-1, m[9]! / sz)));
  const yaw = Math.atan2(m[8]! / sz, m[10]! / sz);
  const roll = Math.atan2(m[1]! / sx, m[5]! / sy);
  return [yaw, pitch, roll, m[12]!, m[13]!, m[14]!];
}

export class FaceTracker {
  mirror = true;
  private readonly pose = restPose();
  private home: { head: number[]; floors: Float32Array } | null = null;
  private sample: { head: number[][]; shapes: Float32Array[] } = { head: [], shapes: [] };
  private since = 0;
  private readonly headFilters = [
    new OneEuro(1.2, 0.5),
    new OneEuro(1.2, 0.5),
    new OneEuro(1.2, 0.5),
    new OneEuro(0.6, 0.02),
    new OneEuro(0.6, 0.02),
    new OneEuro(0.4, 0.02)
  ];
  private readonly shapeFilters = SHAPES.map((name) =>
    name.startsWith('eyeBlink') || name.startsWith('jaw') || (name.startsWith('mouth') && !isSmile(name)) ? new OneEuro(5, 3) : new OneEuro(2, 1)
  );

  rest() {
    this.home = null;
    this.sample = { head: [], shapes: [] };
  }

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
      this.since = 0;
    }
    const settle = 1 / (SETTLE_FROM + this.since++);
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
      const follow = FOLLOW[i]![gap < 0 ? 0 : 1];
      floors[i]! += gap * (SETTLING[i] ? Math.max(follow, settle) : follow);
      const floor = floors[i]!;
      const raw = clamp01((score - floor - DEAD) / Math.max(0.05, TOPS[i]! - DEAD - (SPAN_FROM_ZERO[i] ? 0 : floor)));
      pose.shapes[this.mirror ? TWIN[i]! : i] = clamp01(this.shapeFilters[i]!.next(raw, t));
    }
    return pose;
  }
}
