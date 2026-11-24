import { VRMUtils } from '@pixiv/three-vrm';
import { AmbientLight, Box3, Color, DirectionalLight, type Object3D, PerspectiveCamera, Scene, Vector3, WebGLRenderer } from 'three';

import type { RigInfo } from '@/infra/face-wire';
import { loadModel } from '@/infra/model-load';
import { buildRig } from '@/infra/model-rig';
import { type Pose, SHAPE_COUNT } from '@/infra/pose';

export interface ModelScene {
  readonly rig: RigInfo;
  draw(pose: Pose, dt: number): void;
  setBackground(css: string): void;
  setExpressions(on: boolean): void;
  dispose(): void;
}

const FOV = 20;
const ARM_DOWN = 1.22;
const MAX_YAW = 0.75;
const MAX_PITCH = 0.5;
const MAX_ROLL = 0.5;
const CHEST_SHARE = 0.15;
const NECK_SHARE = 0.35;
const HEAD_SHARE = 0.5;
const LEAN = 0.012;
const MAX_LEAN = 0.2;
const EASE_S = 0.06;
const HOME_S = 0.35;
const BREATH_S = 4.2;
const BREATH = 0.012;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function letDown(upper: Object3D | null, lower: Object3D | null, out: number) {
  if (!upper) return;
  const rest = lower && lower.position.lengthSq() > 0 ? lower.position.clone().normalize() : new Vector3(out, 0, 0);
  const flat = Math.hypot(rest.x, rest.z);
  if (flat === 0 || Math.atan2(-rest.y, flat) >= ARM_DOWN) return;
  const down = new Vector3((rest.x / flat) * Math.cos(ARM_DOWN), -Math.sin(ARM_DOWN), (rest.z / flat) * Math.cos(ARM_DOWN));
  upper.quaternion.setFromUnitVectors(rest, down);
}

export async function createModelScene(canvas: OffscreenCanvas, file: ArrayBuffer, background: string): Promise<ModelScene> {
  const { vrm, targets } = await loadModel(file);
  const rig = buildRig(vrm, targets);
  VRMUtils.combineMorphs(vrm);
  VRMUtils.rotateVRM0(vrm);
  vrm.scene.traverse((o) => {
    o.frustumCulled = false;
  });
  const side = vrm.meta.metaVersion === '0' ? -1 : 1;

  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
  } catch {
    VRMUtils.deepDispose(vrm.scene);
    throw new Error('this browser will not draw 3d here (no webgl), so it cannot show a model');
  }
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
  letDown(bone('leftUpperArm'), bone('leftLowerArm'), side);
  letDown(bone('rightUpperArm'), bone('rightLowerArm'), -side);

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
      spine?.rotation.set(clamp(now.z * LEAN, -MAX_LEAN, MAX_LEAN) * side, 0, clamp(-now.x * LEAN, -MAX_LEAN, MAX_LEAN) * side);

      rig.apply(now.shapes, pose.face, clock);

      vrm.update(dt);
      if (!settled) {
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
      renderer.forceContextLoss();
    }
  };
}
