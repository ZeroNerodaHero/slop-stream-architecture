import type { BoneNode } from '@/infra/model-bones';

export interface FbxInfo {
  nodes: BoneNode[];
  up: 'y' | 'z';
  pictures: number;
  inside: number;
}

const MAGIC = 'Kaydara FBX Binary  \0';
const OLDEST = 7000;
const BROKEN = 'that fbx does not read: it is cut short, or not an fbx inside';
const tooOld = (version: number) => `that fbx is too old a kind (${(version / 1000).toFixed(1)}). this page reads fbx 7 and up`;
const isBoneKind = (kind: string) => kind === 'LimbNode' || kind === 'Root';

const isBinary = (file: ArrayBuffer) => file.byteLength >= 27 && String.fromCharCode(...new Uint8Array(file, 0, MAGIC.length)) === MAGIC;
const isText = (file: ArrayBuffer) => /^\s*; FBX|^\s*FBXHeaderExtension/.test(new TextDecoder().decode(new Uint8Array(file, 0, Math.min(file.byteLength, 512))));

export function isFbx(file: ArrayBuffer): boolean {
  return isBinary(file) || isText(file);
}

function readBinary(file: ArrayBuffer): FbxInfo {
  const view = new DataView(file);
  const version = view.getUint32(23, true);
  if (version < OLDEST) throw new Error(tooOld(version));
  const wide = version >= 7500;
  const header = wide ? 25 : 13;
  const number = (at: number) => (wide ? Number(view.getBigUint64(at, true)) : view.getUint32(at, true));
  const text = (at: number, length: number) => new TextDecoder().decode(new Uint8Array(file, at, length));
  const info: FbxInfo = { nodes: [], up: 'y', pictures: 0, inside: 0 };

  const properties = (at: number, count: number): (string | number)[] => {
    const values: (string | number)[] = [];
    for (let i = 0; i < count; i++) {
      const kind = String.fromCharCode(view.getUint8(at));
      at += 1;
      if (kind === 'S' || kind === 'R') {
        const length = view.getUint32(at, true);
        values.push(kind === 'S' ? text(at + 4, length) : length);
        at += 4 + length;
      } else if (kind === 'I') {
        values.push(view.getInt32(at, true));
        at += 4;
      } else if (kind === 'L') {
        values.push(Number(view.getBigInt64(at, true)));
        at += 8;
      } else {
        break;
      }
    }
    return values;
  };

  const walk = (at: number, end: number, path: string) => {
    while (at + header <= end) {
      const stop = number(at);
      if (stop === 0) return;
      if (stop <= at || stop > end) throw new Error(BROKEN);
      const count = number(at + (wide ? 8 : 4));
      const length = number(at + (wide ? 16 : 8));
      const nameLength = view.getUint8(at + header - 1);
      const first = at + header + nameLength;
      const here = `${path}/${text(at + header, nameLength)}`;
      if (here === '/Objects' || here === '/Objects/Video' || here === '/GlobalSettings' || here === '/GlobalSettings/Properties70') {
        walk(first + length, stop, here);
      } else if (here === '/Objects/Model') {
        const [, name, kind] = properties(first, count);
        if (typeof name === 'string') info.nodes.push({ name: name.split('\0')[0]!, parent: -1, bone: typeof kind === 'string' && isBoneKind(kind) });
      } else if (here === '/Objects/Texture') {
        info.pictures++;
      } else if (here === '/Objects/Video/Content') {
        if (count > 0 && String.fromCharCode(view.getUint8(first)) === 'R' && view.getUint32(first + 1, true) > 0) info.inside++;
      } else if (here === '/GlobalSettings/Properties70/P') {
        const values = properties(first, count);
        if (values[0] === 'UpAxis' && values[4] === 2) info.up = 'z';
      }
      at = stop;
    }
  };
  walk(27, file.byteLength, '');
  return info;
}

function readText(file: ArrayBuffer): FbxInfo {
  const text = new TextDecoder().decode(file);
  const version = Number(/FBXVersion:\s*(\d+)/.exec(text)?.[1] ?? NaN);
  if (!Number.isFinite(version)) throw new Error(BROKEN);
  if (version < OLDEST) throw new Error(tooOld(version));
  const count = (pattern: RegExp) => text.match(pattern)?.length ?? 0;
  return {
    nodes: [...text.matchAll(/^\s*Model:\s*\d+,\s*"Model::([^"]*)",\s*"([^"]*)"/gm)].map(([, name, kind]) => ({ name: name!, parent: -1, bone: isBoneKind(kind!) })),
    up: /P:\s*"UpAxis",\s*"int",\s*"Integer",\s*"",\s*2\b/.test(text) ? 'z' : 'y',
    pictures: count(/^\s*Texture:\s*\d+,/gm),
    inside: count(/^\s*Content:\s*,\s*"/gm)
  };
}

export function readFbx(file: ArrayBuffer): FbxInfo {
  if (!isBinary(file)) return readText(file);
  try {
    return readBinary(file);
  } catch (err) {
    if (err instanceof RangeError) throw new Error(BROKEN, { cause: err });
    throw err;
  }
}
