import { type VRM, VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { type Group, Loader, LoadingManager, type Mesh, type MeshPhongMaterial, type Object3D, Texture } from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { type GLTF, GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

import { readFbx } from '@/infra/fbx';
import { adoptModel } from '@/infra/model-adopt';
import { containerOf, NOT_A_MODEL } from '@/infra/model-file';
import type { MorphTargets, Target } from '@/infra/model-rig';

export interface LoadedModel {
  vrm: VRM;
  targets: MorphTargets;
}

function note(targets: Map<string, Target[]>, name: string, target: Target) {
  const hits = targets.get(name);
  if (hits) hits.push(target);
  else targets.set(name, [target]);
}

function glbTargets(root: Object3D, gltf: GLTF): MorphTargets {
  const json = gltf.parser.json as { meshes?: { extras?: { targetNames?: unknown }; primitives?: { extras?: { targetNames?: unknown } }[] }[] };
  const targets = new Map<string, Target[]>();
  root.traverse((object) => {
    const mesh = object as Mesh;
    const count = mesh.isMesh ? (mesh.morphTargetInfluences?.length ?? 0) : 0;
    if (count === 0) return;
    const where = gltf.parser.associations.get(mesh) as { meshes?: number; primitives?: number } | undefined;
    const def = where?.meshes === undefined ? undefined : json.meshes?.[where.meshes];
    const names = def?.extras?.targetNames ?? def?.primitives?.[where?.primitives ?? 0]?.extras?.targetNames;
    if (!Array.isArray(names)) return;
    names.forEach((name: unknown, index) => {
      if (typeof name === 'string' && index < count) note(targets, name, { mesh, index });
    });
  });
  return targets;
}

function fbxTargets(root: Object3D): MorphTargets {
  const targets = new Map<string, Target[]>();
  root.traverse((object) => {
    const mesh = object as Mesh;
    if (!mesh.isMesh || !mesh.morphTargetDictionary) return;
    for (const [name, index] of Object.entries(mesh.morphTargetDictionary)) note(targets, name, { mesh, index });
  });
  return targets;
}

async function fromGlb(file: ArrayBuffer, manager: LoadingManager): Promise<LoadedModel> {
  const loader = new GLTFLoader(manager);
  loader.register((parser) => new VRMLoaderPlugin(parser));
  const gltf = await loader.parseAsync(file, '');
  const vrm = gltf.userData.vrm as VRM | undefined;
  if (!vrm) {
    const targets = glbTargets(gltf.scene, gltf);
    return { vrm: adoptModel(gltf.scene, targets, 'y'), targets };
  }
  VRMUtils.removeUnnecessaryVertices(gltf.scene);
  VRMUtils.combineSkeletons(gltf.scene);
  return { vrm, targets: glbTargets(vrm.scene, gltf) };
}

class Pictures extends Loader<Texture> {
  private readonly coming: Promise<void>[] = [];

  load(url: string): Texture {
    const texture = new Texture();
    texture.flipY = false;
    if (url.startsWith('blob:') || url.startsWith('data:')) this.coming.push(decode(url, texture));
    return texture;
  }

  async settled(): Promise<void> {
    await Promise.all(this.coming);
  }
}

async function decode(url: string, texture: Texture): Promise<void> {
  try {
    const picture = await (await fetch(url)).blob();
    texture.image = await createImageBitmap(picture, { imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    texture.needsUpdate = true;
  } catch {
  } finally {
    if (url.startsWith('blob:')) URL.revokeObjectURL(url);
  }
}

function tidyMaterials(root: Object3D) {
  root.traverse((object) => {
    const mesh = object as Mesh;
    if (!mesh.isMesh) return;
    for (const material of [mesh.material].flat()) {
      for (const [slot, value] of Object.entries(material)) {
        if (!(value instanceof Texture) || value.image) continue;
        (material as unknown as Record<string, unknown>)[slot] = null;
        material.needsUpdate = true;
      }
      (material as MeshPhongMaterial).specular?.setScalar(0);
    }
  });
}

async function fromFbx(file: ArrayBuffer, manager: LoadingManager): Promise<LoadedModel> {
  const pictures = new Pictures(manager);
  manager.addHandler(/^/, pictures);
  const scope = globalThis as { window?: unknown };
  const lent = scope.window === undefined;
  if (lent) scope.window = scope;
  let scene: Group;
  try {
    scene = new FBXLoader(manager).parse(file, '');
  } catch (err) {
    const why = err instanceof Error ? err.message.replace(/^THREE\.FBXLoader:\s*/, '') : String(err);
    throw new Error(`that fbx would not load: ${why}`, { cause: err });
  } finally {
    if (lent) delete scope.window;
  }
  await pictures.settled();
  tidyMaterials(scene);
  const targets = fbxTargets(scene);
  return { vrm: adoptModel(scene, targets, readFbx(file).up), targets };
}

export function loadModel(file: ArrayBuffer): Promise<LoadedModel> {
  const manager = new LoadingManager();
  manager.setURLModifier((url) => {
    if (url.startsWith('blob:') || url.startsWith('data:')) return url;
    throw new Error('that model points outside its own file. it is not drawn');
  });
  const container = containerOf(file);
  if (container === 'glb') return fromGlb(file, manager);
  if (container === 'fbx') return fromFbx(file, manager);
  return Promise.reject(new Error(NOT_A_MODEL));
}
