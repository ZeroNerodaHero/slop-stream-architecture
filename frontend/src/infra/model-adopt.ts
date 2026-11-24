import { VRM, type VRMHumanBoneName, type VRMHumanBones, VRMHumanoid } from '@pixiv/three-vrm';
import { type Bone, Box3, Group, type Light, type Object3D, Quaternion, Vector3 } from 'three';

import { type BoneNode, findBones, NO_HEAD } from '@/infra/model-bones';
import { expressionsOf, type MorphTargets } from '@/infra/model-rig';

const HEIGHT = 1.6;
const UP = new Vector3(0, 1, 0);
const QUARTER = Math.PI / 2;

function nameOf(object: Object3D): string {
  const { name, originalName } = object.userData as { name?: unknown; originalName?: unknown };
  return typeof name === 'string' ? name : typeof originalName === 'string' ? originalName : object.name;
}

export function adoptModel(model: Object3D, targets: MorphTargets, up: 'y' | 'z'): VRM {
  const root = new Group();
  root.add(model);
  if (up === 'z') root.rotation.x = -QUARTER;
  const lights: Object3D[] = [];
  model.traverse((object) => {
    if ((object as Light).isLight) lights.push(object);
  });
  for (const light of lights) light.removeFromParent();

  const objects: Object3D[] = [];
  model.traverse((object) => {
    objects.push(object);
  });
  const place = new Map(objects.map((object, i) => [object, i]));
  const nodes: BoneNode[] = objects.map((object) => ({
    name: nameOf(object),
    parent: (object.parent ? place.get(object.parent) : undefined) ?? -1,
    bone: (object as Bone).isBone === true
  }));
  const bones = findBones(nodes);
  if (!bones) throw new Error(NO_HEAD);

  if (bones.left.length > 0 && bones.right.length > 0) {
    root.updateMatrixWorld(true);
    const middle = (list: number[]) => list.reduce((sum, i) => sum.add(objects[i]!.getWorldPosition(new Vector3())), new Vector3()).divideScalar(list.length);
    const left = middle(bones.left).sub(middle(bones.right));
    const turned = Math.round(Math.atan2(-left.z, left.x) / QUARTER) * QUARTER;
    if (turned !== 0) root.quaternion.premultiply(new Quaternion().setFromAxisAngle(UP, -turned));
  }

  root.updateMatrixWorld(true);
  const box = new Box3().setFromObject(root);
  const height = box.max.y - box.min.y;
  if (height > 0 && Number.isFinite(height)) root.scale.setScalar(HEIGHT / height);
  root.updateMatrixWorld(true);

  const humanBones: Partial<Record<VRMHumanBoneName, { node: Object3D }>> = {};
  const give = (name: VRMHumanBoneName, i: number) => {
    if (i >= 0) humanBones[name] = { node: objects[i]! };
  };
  give('head', bones.head);
  give('neck', bones.neck);
  give('chest', bones.chest);
  give('spine', bones.spine);
  give('leftUpperArm', bones.leftUpperArm);
  give('leftLowerArm', bones.leftLowerArm);
  give('rightUpperArm', bones.rightUpperArm);
  give('rightLowerArm', bones.rightLowerArm);
  const humanoid = new VRMHumanoid(humanBones as VRMHumanBones);

  return new VRM({ scene: root, humanoid, expressionManager: expressionsOf(targets), meta: { metaVersion: '1', name: '', authors: [], licenseUrl: '' } });
}
