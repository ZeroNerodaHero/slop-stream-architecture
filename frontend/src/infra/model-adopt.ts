/**
 * A model that is no vrm, made one in memory (docs/vtuber.md). A glb or an fbx is a mesh on a
 * skeleton and no more: which bone is the head, which way the model faces, how big it is and
 * what its morphs mean are for whoever opens it to work out. This works them out once, as the
 * file is loaded, and hands back the `VRM` the drawer and the rig already know: its bones by
 * their names (`model-bones.ts`), the model stood up, turned to the camera and made a person's
 * height, and the expressions a vrm would have, out of its morphs' names (`model-rig.ts`).
 * After this nothing knows what kind of file it was.
 *
 * What a vrm has and this cannot make: hair and clothes that swing (spring bones), eyes that
 * turn (a look-at), and a licence.
 */

import { VRM, type VRMHumanBoneName, type VRMHumanBones, VRMHumanoid } from '@pixiv/three-vrm';
import { type Bone, Box3, Group, type Light, type Object3D, Quaternion, Vector3 } from 'three';

import { type BoneNode, findBones, NO_HEAD } from '@/infra/model-bones';
import { expressionsOf, type MorphTargets } from '@/infra/model-rig';

/** How tall a model stands once it is here, in metres: the drawer frames a head by a person's size, and a file may be in centimetres or in anything. */
const HEIGHT = 1.6;
const UP = new Vector3(0, 1, 0);
const QUARTER = Math.PI / 2;

/** The name the file gave a thing, before its loader made it fit for an animation's path: `mixamorig:Head`, not `mixamorigHead`. */
function nameOf(object: Object3D): string {
  const { name, originalName } = object.userData as { name?: unknown; originalName?: unknown };
  return typeof name === 'string' ? name : typeof originalName === 'string' ? originalName : object.name;
}

/**
 * `model` (a loader's scene) as a vrm. `up`: which way is up in its file. Throws words when
 * nothing in it is called a head.
 */
export function adoptModel(model: Object3D, targets: MorphTargets, up: 'y' | 'z'): VRM {
  const root = new Group();
  root.add(model);
  if (up === 'z') root.rotation.x = -QUARTER;
  // a light the file brought along would light the model a second time
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

  // which way it faces: its left is to the left of where it looks. turned by quarters: a model
  // is made facing along an axis, and arms held a little forward are not a turn
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
  // a vrm's humanoid is typed as a whole body. this one has the bones the drawer moves, and a humanoid passes over the ones it has not got
  const humanoid = new VRMHumanoid(humanBones as VRMHumanBones);

  return new VRM({ scene: root, humanoid, expressionManager: expressionsOf(targets), meta: { metaVersion: '1', name: '', authors: [], licenseUrl: '' } });
}
