/**
 * A model's file before it is drawn (docs/vtuber.md): which kind it is, whether this page can
 * make a model of it, and what it says of itself for its card. The kind is read off the file's
 * first bytes, never its name: a `.vrm` and a `.glb` are both a glb (`vrm.ts`), an `.fbx` is an
 * fbx (`fbx.ts`). Pure: no dom, no three. The page asks before a file is kept or handed on, so
 * one that would not be drawn is refused at the door, in words; the worker asks only which
 * loader the bytes are for.
 *
 * A vrm says where its head is and which shapes are its blink. A glb with no vrm in it, and an
 * fbx, do not: they are models by the names of their bones (`model-bones.ts`), and one with
 * nothing called a head has nothing a face could move.
 */

import { isFbx, readFbx } from '@/infra/fbx';
import { hasHead, NO_HEAD } from '@/infra/model-bones';
import { isGlb, readGlb } from '@/infra/vrm';

/** `vrm`: a glb with a vrm in it. `glb`: a glb without. */
export type ModelFormat = 'vrm' | 'glb' | 'fbx';

export interface ModelInfo {
  format: ModelFormat;
  /** The model's own name. '' when it has none: only a vrm, and a glb off some sites, says. */
  name: string;
  author: string;
  /** The licence it names, in a few words. '' when it does not say. */
  licence: string;
  /** Who it says may wear it, in words. '' when it does not say. */
  wearer: string;
  /** Its own thumbnail, when there is one inside the file: the picture's bytes as they are. */
  thumbnail: Blob | null;
}

/** Their disk and their gpu, so this is for a mistake, not a budget: no model is this big. */
const MAX_MODEL_BYTES = 150 * 1024 * 1024;
/** What is said of a file that is neither kind, by the page at the door and by the worker should one get past it. */
export const NOT_A_MODEL = 'not a .vrm, .glb or .fbx file';

/** Which loader the bytes are for. `null`: neither. */
export function containerOf(file: ArrayBuffer): 'glb' | 'fbx' | null {
  return isGlb(file) ? 'glb' : isFbx(file) ? 'fbx' : null;
}

/**
 * What the file says about itself. Throws an `Error` whose message is the reason, in words for
 * the person who picked it, when it is not a model this page will draw.
 */
export function readModel(file: ArrayBuffer): ModelInfo {
  if (file.byteLength > MAX_MODEL_BYTES)
    throw new Error(`that file is ${Math.round(file.byteLength / (1024 * 1024))} mb. a model is ${MAX_MODEL_BYTES / (1024 * 1024)} mb at most`);
  const container = containerOf(file);
  if (container === 'glb') {
    const { vrm, nodes, ...info } = readGlb(file);
    if (!vrm && !hasHead(nodes)) throw new Error(NO_HEAD);
    return { format: vrm ? 'vrm' : 'glb', ...info };
  }
  if (container === 'fbx') {
    const fbx = readFbx(file);
    if (!hasHead(fbx.nodes)) throw new Error(NO_HEAD);
    // an fbx often names its pictures by where they were on its maker's disk. only this one file was picked: it would be drawn bare
    if (fbx.pictures > 0 && fbx.inside === 0)
      throw new Error('that fbx keeps its pictures in other files, and only this one was picked. save it with its pictures inside it (embed media), or as a .glb');
    return { format: 'fbx', name: '', author: '', licence: '', wearer: '', thumbnail: null };
  }
  throw new Error(NOT_A_MODEL);
}
