/**
 * The model, drawn (docs/vtuber.md): one scene with one model in it, framed as a bust, and one
 * `draw(pose, dt)` that moves it toward a pose and paints a frame onto the canvas it was given.
 * The head, the neck and the lean are here; the face is `model-rig.ts`'s; the file, whatever
 * kind it is, is `model-load.ts`'s, which hands over a vrm either way. It runs in the face
 * worker, on an `OffscreenCanvas`; nothing in here knows about a camera, a track or the page.
 * `three` and `@pixiv/three-vrm` are imported by these and by nothing a page loads, so they are
 * in the worker's bundle and in no page's.
 *
 * A vrm 0.x model faces the other way from a 1.0 one. `VRMUtils.rotateVRM0` turns the whole
 * model round, which leaves its bones' own x and z pointing the other way: every turn about
 * those two is flipped for a 0.x model (`side`).
 */

import { VRMUtils } from '@pixiv/three-vrm';
import { AmbientLight, Box3, Color, DirectionalLight, type Object3D, PerspectiveCamera, Scene, Vector3, WebGLRenderer } from 'three';

import type { RigInfo } from '@/infra/face-wire';
import { loadModel } from '@/infra/model-load';
import { buildRig } from '@/infra/model-rig';
import { type Pose, SHAPE_COUNT } from '@/infra/pose';

export interface ModelScene {
  /** What of this model's face the reader can move. */
  readonly rig: RigInfo;
  /** One frame: the model moved toward `pose` and painted. `dt` is the seconds since the last one. */
  draw(pose: Pose, dt: number): void;
  /** The flat colour behind the model, as css (`#1b1d26`). Video has no see-through. */
  setBackground(css: string): void;
  /** The brows, the smile and the wide eyes move the model too, or only the mouth, the blinks and the eyes do. */
  setExpressions(on: boolean): void;
  /** The model and the webgl context go. */
  dispose(): void;
}

/** The lens: a long one, so a face is not bulged by a camera half a metre away. */
const FOV = 20;
/** The arms let down from the T a vrm stands in, to this many radians under the horizontal. */
const ARM_DOWN = 1.22;
/** How far a head turns, whatever the reader says: a neck has ends. */
const MAX_YAW = 0.75;
const MAX_PITCH = 0.5;
const MAX_ROLL = 0.5;
/** The turn is shared: a little in the chest, some in the neck, most in the head. */
const CHEST_SHARE = 0.15;
const NECK_SHARE = 0.35;
const HEAD_SHARE = 0.5;
/** A head moved sideways or forward leans the body: radians per centimetre, and where it stops. */
const LEAN = 0.012;
const MAX_LEAN = 0.2;
/** The model reaches a new pose in about this long: under it a slow reader shows as steps. */
const EASE_S = 0.06;
/** And goes back to rest this slowly when the face is gone. */
const HOME_S = 0.35;
/** A breath: this long, this deep. */
const BREATH_S = 4.2;
const BREATH = 0.012;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * An arm let down from wherever the model holds it: a vrm stands in a T, another model as its
 * maker left it. `upper` and `lower` are the humanoid's normalized bones, whose axes are the
 * model's own whatever way its real bones point. `out` is which way along x the arm goes when
 * the model does not say (it has no bone under its upper arm). An arm that already hangs lower
 * than this is left alone.
 */
function letDown(upper: Object3D | null, lower: Object3D | null, out: number) {
  if (!upper) return;
  // where the lower arm sits from the upper one is which way the arm points
  const rest = lower && lower.position.lengthSq() > 0 ? lower.position.clone().normalize() : new Vector3(out, 0, 0);
  const flat = Math.hypot(rest.x, rest.z);
  if (flat === 0 || Math.atan2(-rest.y, flat) >= ARM_DOWN) return;
  // the same way out from the body, further down
  const down = new Vector3((rest.x / flat) * Math.cos(ARM_DOWN), -Math.sin(ARM_DOWN), (rest.z / flat) * Math.cos(ARM_DOWN));
  upper.quaternion.setFromUnitVectors(rest, down);
}

/**
 * `file` (a .vrm, a .glb or an .fbx, already read by `infra/model-file.ts`) loaded and standing
 * in a scene on `canvas`. Rejects with words when no model can be made of it.
 */
export async function createModelScene(canvas: OffscreenCanvas, file: ArrayBuffer, background: string): Promise<ModelScene> {
  const { vrm, targets } = await loadModel(file);
  // the face, and what will move it. before the morphs are combined: that keeps only the ones an
  // expression uses, and the rig makes expressions of its own out of the model's raw ones
  const rig = buildRig(vrm, targets);
  VRMUtils.combineMorphs(vrm);
  VRMUtils.rotateVRM0(vrm);
  // the bones move the mesh out of the box it was culled by
  vrm.scene.traverse((o) => {
    o.frustumCulled = false;
  });
  const side = vrm.meta.metaVersion === '0' ? -1 : 1;

  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
  } catch {
    // three's own words for it are a paragraph about drivers
    VRMUtils.deepDispose(vrm.scene);
    throw new Error('this browser will not draw 3d here (no webgl), so it cannot show a model');
  }
  // `false`: an OffscreenCanvas has no style to size
  renderer.setSize(canvas.width, canvas.height, false);
  const scene = new Scene();
  scene.background = new Color(background);
  const sun = new DirectionalLight(0xffffff, Math.PI);
  sun.position.set(0.6, 1, 1.4).normalize();
  scene.add(sun, new AmbientLight(0xffffff, 0.35), vrm.scene);

  const bone = (name: 'head' | 'neck' | 'chest' | 'upperChest' | 'spine' | 'leftUpperArm' | 'leftLowerArm' | 'rightUpperArm' | 'rightLowerArm'): Object3D | null =>
    vrm.humanoid.getNormalizedBoneNode(name);
  const head = bone('head');
  const neck = bone('neck');
  const chest = bone('upperChest') ?? bone('chest');
  const spine = bone('spine');
  for (const b of [head, neck, chest, spine]) if (b) b.rotation.order = 'YXZ';
  // a model's left is its +x, a 0.x model's its -x
  letDown(bone('leftUpperArm'), bone('leftLowerArm'), side);
  letDown(bone('rightUpperArm'), bone('rightLowerArm'), -side);

  // a bust: from a head's height under the neck to a little over the top of the hair
  vrm.scene.updateMatrixWorld(true);
  const at = head ? head.getWorldPosition(new Vector3()) : new Vector3(0, 1.35, 0);
  const top = Math.max(new Box3().setFromObject(vrm.scene).max.y, at.y + 0.12);
  const headHeight = clamp(top - at.y, 0.12, 0.7);
  const low = at.y - headHeight;
  const high = top + headHeight * 0.25;
  const camera = new PerspectiveCamera(FOV, canvas.width / canvas.height, 0.05, 30);
  const centre = (low + high) / 2;
  camera.position.set(at.x, centre, at.z + (high - low) / 2 / Math.tan((FOV * Math.PI) / 360));
  camera.lookAt(at.x, centre, at.z);

  /** Where the model is now, eased toward the pose every frame. */
  const now = { yaw: 0, pitch: 0, roll: 0, x: 0, z: 0, shapes: new Float32Array(SHAPE_COUNT) };
  let clock = 0;
  let settled = false;

  const turn = (b: Object3D | null, share: number, extraPitch = 0) => {
    b?.rotation.set((now.pitch * share + extraPitch) * side, now.yaw * share, now.roll * share * side);
  };

  return {
    rig: rig.info,
    draw(pose, dt) {
      clock += dt;
      // toward the face while there is one, and home when there is not
      const k = 1 - Math.exp(-dt / (pose.face ? EASE_S : HOME_S));
      const to = pose.face ? pose : null;
      now.yaw += (clamp(to?.yaw ?? 0, -MAX_YAW, MAX_YAW) - now.yaw) * k;
      now.pitch += (clamp(to?.pitch ?? 0, -MAX_PITCH, MAX_PITCH) - now.pitch) * k;
      now.roll += (clamp(to?.roll ?? 0, -MAX_ROLL, MAX_ROLL) - now.roll) * k;
      now.x += ((to?.x ?? 0) - now.x) * k;
      now.z += ((to?.z ?? 0) - now.z) * k;
      for (let i = 0; i < SHAPE_COUNT; i++) now.shapes[i]! += ((to?.shapes[i] ?? 0) - now.shapes[i]!) * k;

      turn(chest, CHEST_SHARE, Math.sin((clock / BREATH_S) * 2 * Math.PI) * BREATH);
      turn(neck, NECK_SHARE);
      turn(head, HEAD_SHARE);
      // the head moved to its left leans the body to its left; toward the camera leans it forward
      spine?.rotation.set(clamp(now.z * LEAN, -MAX_LEAN, MAX_LEAN) * side, 0, clamp(-now.x * LEAN, -MAX_LEAN, MAX_LEAN) * side);

      // the face: the mouth, the blinks, the eyes, and what else this model has (model-rig.ts)
      rig.apply(now.shapes, pose.face, clock);

      vrm.update(dt);
      if (!settled) {
        // the hair and the clothes start hanging from the pose it stands in, not swinging down from the T
        vrm.springBoneManager?.reset();
        settled = true;
      }
      renderer.render(scene, camera);
    },
    setBackground(css) {
      scene.background = new Color(css);
    },
    setExpressions(on) {
      rig.moods = on;
    },
    dispose() {
      VRMUtils.deepDispose(vrm.scene);
      renderer.dispose();
      // dispose alone keeps the webgl context, and a browser keeps only so many
      renderer.forceContextLoss();
    }
  };
}
