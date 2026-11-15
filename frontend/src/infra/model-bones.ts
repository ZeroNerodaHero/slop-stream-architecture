/**
 * A model's bones, found by their names (docs/vtuber.md). A vrm says which of its bones is the
 * head. No other file does: a glb or an fbx has a skeleton whose bones are named the way the
 * tool that made it names them, and the head is the one that is called a head. This reads the
 * names: mixamo's (`mixamorig:Head`), ready player me's and unity's (`Head`, `LeftArm`),
 * vroid's (`J_Bip_C_Head`), a biped's (`Bip001 Head`), unreal's (`head`, `upperarm_l`), mmd's
 * (`頭`, `左腕`).
 *
 * Pure: names and who is whose parent in, places in that list out. The page asks whether a
 * file has a head at all, before the file is kept (`model-file.ts`); the worker asks which
 * bones to move (`model-adopt.ts`). One rule for both, so a file the page lets in is one the
 * worker finds a head in.
 */

/** What is said of a file with nothing called a head, by the page at the door and by the worker should one get past it. */
export const NO_HEAD = 'that file has nothing called a head. a model that is not a vrm is known by the names of its bones, and this one has none to turn';

/** One thing in a model that has a place: a bone, or a mesh or a group beside the bones. */
export interface BoneNode {
  /** The name the file gives it. */
  name: string;
  /** Its parent's place in the list. -1 at the top, and where the file was not asked. */
  parent: number;
  /** It is a bone of a skeleton, not a mesh that happens to be called a head. */
  bone: boolean;
}

/** The bones the drawer moves, each a place in the list. -1: the model has no such bone, or names it some other way. */
export interface Bones {
  head: number;
  neck: number;
  /** The top of the back, where the shoulders hang. */
  chest: number;
  /** The bottom of the back, over the hips. -1 when the back is one bone: that one is the chest. */
  spine: number;
  leftUpperArm: number;
  leftLowerArm: number;
  rightUpperArm: number;
  rightLowerArm: number;
  /** Every bone named for a side: between them they say which way the model's left is, and so which way it faces. */
  left: number[];
  right: number[];
}

type Side = 'left' | 'right';
const SIDE = new Map<string, Side>([
  ['left', 'left'],
  ['l', 'left'],
  ['right', 'right'],
  ['r', 'right']
]);
/** What a bone at the bottom of a back is called: the back stops there. */
const HIPS = new Set(['hips', 'hip', 'pelvis', 'root', 'center', 'centre', 'cog', 'waist']);
const HIPS_JA = ['センター', '下半身', '腰', 'グルーブ', '全ての親'];
/** An arm bone with one of these in its name is not the upper arm: it is further down, or a twist, or a handle. */
const NOT_UPPER_ARM = new Set([
  'fore',
  'lower',
  'low',
  'elbow',
  'hand',
  'wrist',
  'twist',
  'roll',
  'ik',
  'pole',
  'target',
  'ctrl',
  'control',
  'shoulder',
  'clavicle',
  'collar'
]);
const NOT_UPPER_ARM_JA = ['捩', 'ひじ', '手', 'IK', '肩', '先'];

interface Named {
  /** The name, with wide and narrow letters made one kind. */
  raw: string;
  /** Its words, lower case: `mixamorig:LeftForeArm` is mixamorig, left, fore, arm. */
  words: string[];
  side: Side | null;
  /** The words but for the side, run together: `J_Bip_L_UpperArm` is jbipupperarm. */
  rest: string;
}

function read(name: string): Named {
  const raw = name.normalize('NFKC');
  const words = raw
    // a new word starts at a capital after a small letter, at the last capital of a run, and at a digit after a letter
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([A-Za-z])([0-9])/g, '$1 $2')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  let side: Side | null = raw.includes('左') ? 'left' : raw.includes('右') ? 'right' : null;
  for (const word of words) side ??= SIDE.get(word) ?? null;
  return {
    raw,
    words,
    side,
    rest: words
      .filter((word) => !SIDE.has(word))
      .join('')
      .replace(/[左右]/g, '')
  };
}

const isHead = (named: Named) => named.words.includes('head') || named.raw === '頭';
const isNeck = (named: Named) => named.words.includes('neck') || named.raw === '首';
const isHips = (named: Named) => named.words.some((word) => HIPS.has(word)) || HIPS_JA.some((word) => named.raw.includes(word));
const isTwist = (named: Named) => named.words.includes('twist') || named.words.includes('roll') || named.raw.includes('捩');

function isUpperArm(named: Named): boolean {
  if (/upperarm|uparm/.test(named.rest)) return true;
  // daz: the shoulder is the collar, and `lShldrBend` is the arm
  if (named.words.includes('shldr')) return !named.words.includes('twist');
  if (named.words.includes('arm')) return !named.words.some((word) => NOT_UPPER_ARM.has(word));
  return named.raw.includes('腕') && !NOT_UPPER_ARM_JA.some((word) => named.raw.includes(word));
}

/** A file has something called a head: a model can be made of it. */
export function hasHead(nodes: readonly BoneNode[]): boolean {
  return nodes.some((node) => isHead(read(node.name)));
}

/** The bones the drawer moves, out of a model's own names. `null`: nothing in it is called a head. */
export function findBones(nodes: readonly BoneNode[]): Bones | null {
  const named = nodes.map((node) => read(node.name));
  const depth = (i: number) => {
    let d = 0;
    for (let at = nodes[i]!.parent; at >= 0; at = nodes[at]!.parent) d++;
    return d;
  };
  /** The one nearest the top of the tree, and of those the plainest name: `Head` before its child `HeadTop_End`. */
  const first = (fits: (i: number) => boolean): number => {
    let best = -1;
    let bestRank = Infinity;
    for (let i = 0; i < nodes.length; i++) {
      if (!fits(i)) continue;
      const rank = depth(i) * 100 + named[i]!.words.length;
      if (rank < bestRank) {
        best = i;
        bestRank = rank;
      }
    }
    return best;
  };

  // a bone first: a mesh is often named for the part it covers (`Wolf3D_Head`), and sits higher in the tree than the bone
  let head = first((i) => nodes[i]!.bone && isHead(named[i]!));
  if (head < 0) head = first((i) => isHead(named[i]!));
  if (head < 0) return null;

  // up from the head: a neck, then the back, down to the hips. a second neck bone is passed over
  let neck = -1;
  const back: number[] = [];
  for (let at = nodes[head]!.parent; at >= 0 && nodes[at]!.bone; at = nodes[at]!.parent) {
    if (isNeck(named[at]!)) {
      if (neck < 0 && back.length === 0) neck = at;
      continue;
    }
    if (isHips(named[at]!)) break;
    back.push(at);
  }

  const arm = (side: Side) => first((i) => nodes[i]!.bone && named[i]!.side === side && isUpperArm(named[i]!));
  /** What an upper arm holds up: its first child that is a bone, a twist bone only when there is nothing else. */
  const below = (upper: number): number => {
    if (upper < 0) return -1;
    const children = nodes.flatMap((node, i) => (node.parent === upper && node.bone ? [i] : []));
    return children.find((i) => !isTwist(named[i]!)) ?? children[0] ?? -1;
  };
  const leftUpperArm = arm('left');
  const rightUpperArm = arm('right');
  const onSide = (side: Side) => nodes.flatMap((node, i) => (node.bone && named[i]!.side === side ? [i] : []));

  return {
    head,
    neck,
    chest: back[0] ?? -1,
    spine: back.length > 1 ? back[back.length - 1]! : -1,
    leftUpperArm,
    leftLowerArm: below(leftUpperArm),
    rightUpperArm,
    rightLowerArm: below(rightUpperArm),
    left: onSide('left'),
    right: onSide('right')
  };
}
