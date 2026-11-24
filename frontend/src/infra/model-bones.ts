export const NO_HEAD = 'that file has nothing called a head. a model that is not a vrm is known by the names of its bones, and this one has none to turn';

export interface BoneNode {
  name: string;
  parent: number;
  bone: boolean;
}

export interface Bones {
  head: number;
  neck: number;
  chest: number;
  spine: number;
  leftUpperArm: number;
  leftLowerArm: number;
  rightUpperArm: number;
  rightLowerArm: number;
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
const HIPS = new Set(['hips', 'hip', 'pelvis', 'root', 'center', 'centre', 'cog', 'waist']);
const HIPS_JA = ['センター', '下半身', '腰', 'グルーブ', '全ての親'];
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
  raw: string;
  words: string[];
  side: Side | null;
  rest: string;
}

function read(name: string): Named {
  const raw = name.normalize('NFKC');
  const words = raw
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
  if (named.words.includes('shldr')) return !named.words.includes('twist');
  if (named.words.includes('arm')) return !named.words.some((word) => NOT_UPPER_ARM.has(word));
  return named.raw.includes('腕') && !NOT_UPPER_ARM_JA.some((word) => named.raw.includes(word));
}

export function hasHead(nodes: readonly BoneNode[]): boolean {
  return nodes.some((node) => isHead(read(node.name)));
}

export function findBones(nodes: readonly BoneNode[]): Bones | null {
  const named = nodes.map((node) => read(node.name));
  const depth = (i: number) => {
    let d = 0;
    for (let at = nodes[i]!.parent; at >= 0; at = nodes[at]!.parent) d++;
    return d;
  };
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

  let head = first((i) => nodes[i]!.bone && isHead(named[i]!));
  if (head < 0) head = first((i) => isHead(named[i]!));
  if (head < 0) return null;

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
