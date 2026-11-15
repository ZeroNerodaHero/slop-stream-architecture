/**
 * A model's file made a model of, in the face worker (docs/vtuber.md): the bytes of a `.vrm`,
 * a `.glb` or an `.fbx` in, a `VRM` out, and every morph it has by name. A vrm is a vrm as it
 * comes. The other two are loaded as what they are and made one (`model-adopt.ts`).
 *
 * Everything a model needs is inside its file, and nothing is fetched from anywhere else: the
 * loaders may open the file's own blobs and no other address.
 */

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
  /** Its morph targets by the names its file gives them: what the rig makes brows and a smile of. */
  targets: MorphTargets;
}

function note(targets: Map<string, Target[]>, name: string, target: Target) {
  const hits = targets.get(name);
  if (hits) hits.push(target);
  else targets.set(name, [target]);
}

/** A glb's morph targets by name. The names are the file's own (`extras.targetNames`), on a mesh or on each of its primitives. */
function glbTargets(root: Object3D, gltf: GLTF): MorphTargets {
  const json = gltf.parser.json as { meshes?: { extras?: { targetNames?: unknown }; primitives?: { extras?: { targetNames?: unknown } }[] }[] };
  const targets = new Map<string, Target[]>();
  root.traverse((object) => {
    const mesh = object as Mesh;
    const count = mesh.isMesh ? (mesh.morphTargetInfluences?.length ?? 0) : 0;
    if (count === 0) return;
    // the loader notes which of a mesh's primitives an object is, which its typings do not say
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

/** An fbx's, which its loader leaves on each mesh. */
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
  // a glb with no vrm in it. y is up in every gltf: the format says so
  if (!vrm) {
    const targets = glbTargets(gltf.scene, gltf);
    return { vrm: adoptModel(gltf.scene, targets, 'y'), targets };
  }
  VRMUtils.removeUnnecessaryVertices(gltf.scene);
  VRMUtils.combineSkeletons(gltf.scene);
  return { vrm, targets: glbTargets(vrm.scene, gltf) };
}

/**
 * The pictures inside an fbx. Its loader would make an `<img>` of each, and a worker has no
 * document, so they are decoded here: every picture the loader asks for comes through this. One
 * the file only names (it is on its maker's disk) is asked of nobody, and its texture stays
 * empty.
 */
class Pictures extends Loader<Texture> {
  private readonly coming: Promise<void>[] = [];

  load(url: string): Texture {
    const texture = new Texture();
    // decoded the right way up: a bitmap cannot be turned over on its way to the gpu
    texture.flipY = false;
    if (url.startsWith('blob:') || url.startsWith('data:')) this.coming.push(decode(url, texture));
    return texture;
  }

  /** Every picture that is going to come has come. */
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
    // a kind of picture a browser does not read (a .tga, a .psd): the material goes without it
  } finally {
    if (url.startsWith('blob:')) URL.revokeObjectURL(url);
  }
}

/**
 * An fbx's materials, made fit to draw. One whose picture did not come is drawn in its own
 * colour: with an empty texture it would be black. And all of them are drawn matte: an fbx
 * says how strong its shine is in a number the loader does not read, and at full strength
 * under this scene's one light the shine is a white veil over the whole model.
 */
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
  // every name: the loader picks a picture's loader by the end of its file's name, and falls back to one that needs a document
  manager.addHandler(/^/, pictures);
  // the loader says `window.URL` to make the address of a picture inside the file, and a worker has no `window`:
  // it is lent the worker's own scope for the parse, which is one call and lets nothing else run meanwhile
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

/** `file` (already looked over by `model-file.ts`) as a model. Rejects with words when a loader cannot make one of it. */
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
