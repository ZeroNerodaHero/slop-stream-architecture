/**
 * A `.vrm` before it is drawn (docs/vtuber.md). A vrm is a glb: a 12 byte header, a json chunk,
 * a binary chunk. This reads the header and the json chunk, never a mesh: is it a vrm, does
 * everything it needs sit inside the file, what does it call itself, who made it and who may
 * wear it. Pure: no dom, no three, so the page asks it before a file goes anywhere.
 *
 * The one thing it refuses that a loader would take: a buffer or a picture named by `uri`.
 * Whoever draws such a file fetches from wherever it points, and a model from a random download
 * should not get to call home from the streamer's browser.
 */

export interface VrmInfo {
  /** `0` (vrm 0.x) or `1` (vrm 1.0). */
  version: '0' | '1';
  /** The model's own name. '' when it has none. */
  name: string;
  author: string;
  /** The licence it names, in a few words. '' when it does not say. */
  licence: string;
  /** Who its meta says may wear it, in words. '' when it does not say. */
  wearer: string;
  /** Its own thumbnail, when there is one inside the file: the picture's bytes as they are. */
  thumbnail: Blob | null;
}

/** Their disk and their gpu, so this is for a mistake, not a budget: no model is this big. */
export const MAX_MODEL_BYTES = 150 * 1024 * 1024;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_WORDS = 80;
const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

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
  'KHR_texture_transform',
  'KHR_mesh_quantization'
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

/**
 * What the file says about itself. Throws an `Error` whose message is the reason, in words for
 * the person who picked it, when it is not a vrm this page will draw.
 */
export function readVrm(file: ArrayBuffer): VrmInfo {
  if (file.byteLength > MAX_MODEL_BYTES)
    throw new Error(`that file is ${Math.round(file.byteLength / (1024 * 1024))} mb. a model is ${MAX_MODEL_BYTES / (1024 * 1024)} mb at most`);
  const view = new DataView(file);
  if (file.byteLength < 20 || view.getUint32(0, true) !== GLB_MAGIC) throw new Error('not a .vrm file');
  if (view.getUint32(4, true) !== 2) throw new Error('not a .vrm file (an old gltf)');
  if (view.getUint32(8, true) !== file.byteLength) throw new Error('that file is cut short');
  const jsonLength = view.getUint32(12, true);
  const jsonEnd = 20 + jsonLength;
  if (view.getUint32(16, true) !== CHUNK_JSON || jsonLength > MAX_JSON_BYTES || jsonEnd > file.byteLength) throw new Error('not a .vrm file');
  let doc: unknown;
  try {
    doc = JSON.parse(new TextDecoder().decode(new Uint8Array(file, 20, jsonLength)));
  } catch {
    throw new Error('not a .vrm file (its inside does not read)');
  }
  if (!isObject(doc)) throw new Error('not a .vrm file');

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
  let info: Omit<VrmInfo, 'thumbnail'>;
  let image: number | null;
  if (one) {
    const url = words(one.licenseUrl);
    info = {
      version: '1',
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
      version: '0',
      name: words(zero.title),
      author: words(zero.author),
      licence: named.toLowerCase() === 'other' ? words(zero.otherLicenseUrl) : named,
      wearer: WEARERS[words(zero.allowedUserName).toLowerCase()] ?? ''
    };
    // its thumbnail is a texture, whose `source` is the picture
    const texture = indexAt(zero, 'texture');
    image = texture === null ? null : indexAt(listAt(doc, 'textures')[texture], 'source');
  } else {
    throw new Error('that is a 3d file, but not a vrm: it has no avatar in it');
  }

  return { ...info, thumbnail: image === null ? null : thumbnailOf(file, doc, jsonEnd, image) };
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
