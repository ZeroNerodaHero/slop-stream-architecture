/**
 * A `.vrm` or a `.glb` before it is drawn (docs/vtuber.md). A vrm is a glb: a 12 byte header, a
 * json chunk, a binary chunk. This reads the header and the json chunk, never a mesh: does
 * everything it needs sit inside the file, is it a vrm, what does it call itself, who made it
 * and who may wear it; and for a glb that is no vrm, what its bones are called, which is all
 * that says where its head is. Pure: no dom, no three, so the page asks it before a file goes
 * anywhere (`model-file.ts`).
 *
 * The one thing it refuses that a loader would take: a buffer or a picture named by `uri`.
 * Whoever draws such a file fetches from wherever it points, and a model from a random download
 * should not get to call home from the streamer's browser.
 */

import type { BoneNode } from '@/infra/model-bones';

export interface GlbInfo {
  /** `0` (vrm 0.x) or `1` (vrm 1.0). `null`: a glb with no vrm in it, a model by the names of its bones alone. */
  vrm: '0' | '1' | null;
  /** The model's own name. '' when it has none. */
  name: string;
  author: string;
  /** The licence it names, in a few words. '' when it does not say. */
  licence: string;
  /** Who its meta says may wear it, in words. '' when it does not say. */
  wearer: string;
  /** Its own thumbnail, when there is one inside the file: the picture's bytes as they are. */
  thumbnail: Blob | null;
  /** What is in it by name, and which of those are bones: where a glb that is no vrm is looked over for a head. */
  nodes: BoneNode[];
}

const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_WORDS = 80;
const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
const UNREADABLE = 'that file does not read as a model';

/** What a model may say it cannot be drawn without: the vrm set, and the plain gltf ones three reads on its own. */
const KNOWN_EXTENSIONS: readonly string[] = [
  'VRM',
  'VRMC_vrm',
  'VRMC_springBone',
  'VRMC_springBone_extended_collider',
  'VRMC_node_constraint',
  'VRMC_materials_mtoon',
  'VRMC_materials_hdr_emissiveMultiplier',
  'KHR_materials_unlit',
  'KHR_materials_emissive_strength',
  'KHR_materials_clearcoat',
  'KHR_materials_dispersion',
  'KHR_materials_ior',
  'KHR_materials_sheen',
  'KHR_materials_specular',
  'KHR_materials_transmission',
  'KHR_materials_iridescence',
  'KHR_materials_anisotropy',
  'KHR_materials_volume',
  'KHR_lights_punctual',
  'KHR_texture_transform',
  'KHR_mesh_quantization',
  'EXT_materials_bump',
  'EXT_texture_webp',
  'EXT_texture_avif',
  'EXT_mesh_gpu_instancing'
];
/** Each of these is a wasm decoder the page does not carry. */
const PACKED: Record<string, string> = {
  KHR_draco_mesh_compression: 'draco',
  EXT_meshopt_compression: 'meshopt',
  KHR_texture_basisu: 'ktx2'
};

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const objectAt = (v: unknown, key: string): Json | null => (isObject(v) && isObject(v[key]) ? v[key] : null);
const listAt = (v: unknown, key: string): unknown[] => (isObject(v) && Array.isArray(v[key]) ? v[key] : []);
const indexAt = (v: unknown, key: string): number | null => {
  const n = isObject(v) ? v[key] : null;
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : null;
};

/** A string kept to one line and `MAX_WORDS` characters. */
function words(v: unknown): string {
  return typeof v === 'string' ? v.split(/\s+/).filter(Boolean).join(' ').slice(0, MAX_WORDS) : '';
}
/** The same, without the address in brackets some tools put after a name: `CC-BY-4.0 (http://creativecommons.org/...)`. */
const beforeAddress = (v: unknown) => words(v).replace(/\s*\(https?:\/\/[^)]*\)?$/, '');

const WEARERS: Record<string, string> = {
  onlyauthor: 'only its author',
  onlyseparatelylicensedperson: 'only people it is licensed to',
  explicitlylicensedperson: 'only people it is licensed to',
  everyone: 'anyone'
};

function pictureType(bytes: Uint8Array, said: unknown): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  return typeof said === 'string' && said.startsWith('image/') ? said : '';
}

/** By its first bytes: the file is a glb, which a vrm is too. */
export function isGlb(file: ArrayBuffer): boolean {
  return file.byteLength >= 20 && new DataView(file).getUint32(0, true) === GLB_MAGIC;
}

/** The file's nodes by name, each with its parent, and whether a skin moves by it. */
function nodesOf(doc: Json): BoneNode[] {
  const joints = new Set(listAt(doc, 'skins').flatMap((skin) => listAt(skin, 'joints')));
  const list = listAt(doc, 'nodes');
  const nodes: BoneNode[] = list.map((node, i) => ({ name: isObject(node) && typeof node.name === 'string' ? node.name : '', parent: -1, bone: joints.has(i) }));
  list.forEach((node, i) => {
    for (const child of listAt(node, 'children')) if (typeof child === 'number' && nodes[child]) nodes[child].parent = i;
  });
  return nodes;
}

/**
 * What a glb says about itself. Throws an `Error` whose message is the reason, in words for
 * the person who picked it, when it is not a file this page will draw.
 */
export function readGlb(file: ArrayBuffer): GlbInfo {
  const view = new DataView(file);
  if (!isGlb(file)) throw new Error(UNREADABLE);
  if (view.getUint32(4, true) !== 2) throw new Error('that is an old kind of gltf. this page reads version 2');
  if (view.getUint32(8, true) !== file.byteLength) throw new Error('that file is cut short');
  const jsonLength = view.getUint32(12, true);
  const jsonEnd = 20 + jsonLength;
  if (view.getUint32(16, true) !== CHUNK_JSON || jsonLength > MAX_JSON_BYTES || jsonEnd > file.byteLength) throw new Error(UNREADABLE);
  let doc: unknown;
  try {
    doc = JSON.parse(new TextDecoder().decode(new Uint8Array(file, 20, jsonLength)));
  } catch {
    throw new Error(UNREADABLE);
  }
  if (!isObject(doc)) throw new Error(UNREADABLE);

  // everything inside the file: a `uri` is a fetch from wherever it points, made by whoever draws it
  for (const list of ['buffers', 'images']) {
    if (listAt(doc, list).some((item) => isObject(item) && 'uri' in item)) throw new Error('that model points outside its own file. it is not drawn');
  }
  for (const needed of listAt(doc, 'extensionsRequired')) {
    if (typeof needed !== 'string') continue;
    if (PACKED[needed]) throw new Error(`that model is packed with ${PACKED[needed]}, which this page does not unpack`);
    if (!KNOWN_EXTENSIONS.includes(needed)) throw new Error(`that model needs ${words(needed)}, which this page does not read`);
  }

  const extensions = objectAt(doc, 'extensions');
  const one = objectAt(objectAt(extensions, 'VRMC_vrm'), 'meta');
  const zero = objectAt(objectAt(extensions, 'VRM'), 'meta');
  let info: Omit<GlbInfo, 'thumbnail' | 'nodes'>;
  let image: number | null = null;
  if (one) {
    const url = words(one.licenseUrl);
    info = {
      vrm: '1',
      name: words(one.name),
      author: words(
        listAt(one, 'authors')
          .filter((a) => typeof a === 'string')
          .join(', ')
      ),
      licence: url.includes('vrm.dev/licenses/1.0') ? 'VRM Public License 1.0' : url,
      wearer: WEARERS[words(one.avatarPermission).toLowerCase()] ?? ''
    };
    image = indexAt(one, 'thumbnailImage');
  } else if (zero) {
    // 0.x names a licence by a word (`CC0`, `Redistribution_Prohibited`); `Other` points at a url
    const named = words(zero.licenseName).replace(/_/g, ' ');
    info = {
      vrm: '0',
      name: words(zero.title),
      author: words(zero.author),
      licence: named.toLowerCase() === 'other' ? words(zero.otherLicenseUrl) : named,
      wearer: WEARERS[words(zero.allowedUserName).toLowerCase()] ?? ''
    };
    // its thumbnail is a texture, whose `source` is the picture
    const texture = indexAt(zero, 'texture');
    image = texture === null ? null : indexAt(listAt(doc, 'textures')[texture], 'source');
  } else {
    // a plain glb says little of itself: a line of copyright, and what a site it came down from wrote beside that
    const asset = objectAt(doc, 'asset');
    const extras = objectAt(asset, 'extras');
    info = {
      vrm: null,
      name: words(extras?.title),
      author: beforeAddress(extras?.author) || words(asset?.copyright),
      licence: beforeAddress(extras?.license),
      wearer: ''
    };
  }

  return { ...info, thumbnail: image === null ? null : thumbnailOf(file, doc, jsonEnd, image), nodes: nodesOf(doc) };
}

/** The bytes of picture `image`: its buffer view, inside the binary chunk. `null` when they are not all in the file. */
function thumbnailOf(file: ArrayBuffer, doc: Json, jsonEnd: number, image: number): Blob | null {
  if (jsonEnd + 8 > file.byteLength) return null;
  const view = new DataView(file);
  const binLength = view.getUint32(jsonEnd, true);
  const binStart = jsonEnd + 8;
  if (view.getUint32(jsonEnd + 4, true) !== CHUNK_BIN || binStart + binLength > file.byteLength) return null;
  const picture = listAt(doc, 'images')[image];
  const bufferView = indexAt(picture, 'bufferView');
  const span = bufferView === null ? null : listAt(doc, 'bufferViews')[bufferView];
  const length = indexAt(span, 'byteLength');
  if (length === null || length === 0) return null;
  const start = binStart + (indexAt(span, 'byteOffset') ?? 0);
  if (start + length > binStart + binLength) return null;
  const bytes = new Uint8Array(file, start, length);
  const type = pictureType(bytes, isObject(picture) ? picture.mimeType : null);
  // a copy: the file's buffer is handed to the worker, and a view of it would go with it
  return type ? new Blob([bytes.slice()], { type }) : null;
}
