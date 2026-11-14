/**
 * The model, drawn (docs/vtuber.md): one scene with one vrm in it, framed as a bust, and one
 * `draw(pose, dt)` that moves it toward a pose and paints a frame onto the canvas it was given.
 * It runs in the face worker, on an `OffscreenCanvas`; nothing in here knows about a camera, a
 * track or the page. `three` and `@pixiv/three-vrm` are imported here and nowhere else, so they
 * are in the worker's bundle and in no page's.
 *
 * A vrm 0.x model faces the other way from a 1.0 one. `VRMUtils.rotateVRM0` turns the whole
 * model round, which leaves its bones' own x and z pointing the other way: every turn about
 * those two is flipped for a 0.x model (`side`).
 */

import { type VRM, VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { AmbientLight, Box3, Color, DirectionalLight, LoadingManager, type Object3D, PerspectiveCamera, Scene, Vector3, WebGLRenderer } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

import { type Pose, type Shape, SHAPE_COUNT, shapeIndex } from '@/infra/pose';

export interface ModelScene {
  /** One frame: the model moved toward `pose` and painted. `dt` is the seconds since the last one. */
  draw(pose: Pose, dt: number): void;
  /** The flat colour behind the model, as css (`#1b1d26`). Video has no see-through. */
  setBackground(css: string): void;
  /** The model and the webgl context go. */
  dispose(): void;
}

/** The lens: a long one, so a face is not bulged by a camera half a metre away. */
const FOV = 20;
/** The arms let down from the T a vrm stands in, in radians off the horizontal. */
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
/** With no face to read, a blink this long every few seconds. */
const BLINK_S = 0.16;
const BLINK_EVERY_MIN_S = 2.4;
const BLINK_EVERY_MAX_S = 5.5;
/** Two eyes that close about as far as each other are one blink: a reader's two readings of it differ by noise. */
const SAME_BLINK = 0.25;
/** Eyes all the way to one side, in degrees. */
const LOOK_YAW = 22;
const LOOK_PITCH = 14;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * `file` (a .vrm, already read by `infra/vrm.ts`) loaded and standing in a scene on `canvas`.
 * Rejects with words when the loader cannot make an avatar of it.
 */
export async function createModelScene(canvas: OffscreenCanvas, file: ArrayBuffer, background: string): Promise<ModelScene> {
  // everything a model needs is inside its file: the loader may open the file's own blobs and nothing else
  const manager = new LoadingManager();
  manager.setURLModifier((url) => {
    if (url.startsWith('blob:') || url.startsWith('data:')) return url;
    throw new Error('that model points outside its own file. it is not drawn');
  });
  const loader = new GLTFLoader(manager);
  loader.register((parser) => new VRMLoaderPlugin(parser));
  const gltf = await loader.parseAsync(file, '');
  const vrm = gltf.userData.vrm as VRM | undefined;
  if (!vrm) throw new Error('that file has no avatar in it');

  VRMUtils.removeUnnecessaryVertices(gltf.scene);
  VRMUtils.combineSkeletons(gltf.scene);
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

  const bone = (name: 'head' | 'neck' | 'chest' | 'upperChest' | 'spine' | 'leftUpperArm' | 'rightUpperArm'): Object3D | null =>
    vrm.humanoid.getNormalizedBoneNode(name);
  const head = bone('head');
  const neck = bone('neck');
  const chest = bone('upperChest') ?? bone('chest');
  const spine = bone('spine');
  for (const b of [head, neck, chest, spine]) if (b) b.rotation.order = 'YXZ';
  bone('leftUpperArm')?.rotation.set(0, 0, -ARM_DOWN * side);
  bone('rightUpperArm')?.rotation.set(0, 0, ARM_DOWN * side);

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

  const expressions = vrm.expressionManager;
  const has = (name: string) => !!expressions?.getExpression(name);
  const eachEye = has('blinkLeft') && has('blinkRight');
  /** Where the model is now, eased toward the pose every frame. */
  const now = { yaw: 0, pitch: 0, roll: 0, x: 0, z: 0, shapes: new Float32Array(SHAPE_COUNT) };
  let clock = 0;
  let nextBlink = BLINK_EVERY_MIN_S;
  let settled = false;

  const shape = (name: Shape) => now.shapes[shapeIndex(name)]!;
  const turn = (b: Object3D | null, share: number, extraPitch = 0) => {
    b?.rotation.set((now.pitch * share + extraPitch) * side, now.yaw * share, now.roll * share * side);
  };

  return {
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

      if (expressions) {
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
        expressions.setValue('aa', aa);
        expressions.setValue('oh', oh);
        expressions.setValue('ou', ou);
        expressions.setValue('ih', ih);

        // the blinks: the face's, or with no face to read one of its own every few seconds
        let left = shape('eyeBlinkLeft');
        let right = shape('eyeBlinkRight');
        if (!pose.face) {
          if (clock >= nextBlink + BLINK_S) nextBlink = clock + BLINK_EVERY_MIN_S + Math.random() * (BLINK_EVERY_MAX_S - BLINK_EVERY_MIN_S);
          const through = (clock - nextBlink) / BLINK_S;
          left = right = Math.max(left, through > 0 && through < 1 ? 1 - Math.abs(through * 2 - 1) : 0);
        } else if (Math.abs(left - right) < SAME_BLINK) {
          left = right = (left + right) / 2;
        }
        if (eachEye) {
          expressions.setValue('blinkLeft', left);
          expressions.setValue('blinkRight', right);
        } else {
          expressions.setValue('blink', (left + right) / 2);
        }
      }

      if (vrm.lookAt) {
        // out for one eye is in for the other. positive yaw is the model's own left, negative pitch is up
        const yaw = (shape('eyeLookOutLeft') - shape('eyeLookInLeft') + shape('eyeLookInRight') - shape('eyeLookOutRight')) / 2;
        const up = (shape('eyeLookUpLeft') + shape('eyeLookUpRight') - shape('eyeLookDownLeft') - shape('eyeLookDownRight')) / 2;
        vrm.lookAt.yaw = clamp(yaw, -1, 1) * LOOK_YAW;
        vrm.lookAt.pitch = clamp(-up, -1, 1) * LOOK_PITCH;
      }

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
    dispose() {
      VRMUtils.deepDispose(vrm.scene);
      renderer.dispose();
      // dispose alone keeps the webgl context, and a browser keeps only so many
      renderer.forceContextLoss();
    }
  };
}
