import { isFbx, readFbx } from '@/infra/fbx';
import { hasHead, NO_HEAD } from '@/infra/model-bones';
import { isGlb, readGlb } from '@/infra/vrm';

export type ModelFormat = 'vrm' | 'glb' | 'fbx';

export interface ModelInfo {
  format: ModelFormat;
  name: string;
  author: string;
  licence: string;
  wearer: string;
  thumbnail: Blob | null;
}

const MAX_MODEL_BYTES = 150 * 1024 * 1024;
export const NOT_A_MODEL = 'not a .vrm, .glb or .fbx file';

export function containerOf(file: ArrayBuffer): 'glb' | 'fbx' | null {
  return isGlb(file) ? 'glb' : isFbx(file) ? 'fbx' : null;
}

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
    if (fbx.pictures > 0 && fbx.inside === 0)
      throw new Error('that fbx keeps its pictures in other files, and only this one was picked. save it with its pictures inside it (embed media), or as a .glb');
    return { format: 'fbx', name: '', author: '', licence: '', wearer: '', thumbnail: null };
  }
  throw new Error(NOT_A_MODEL);
}
