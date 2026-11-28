import { type Box, clampBox, type Fit, LAYER_MIN, thousandth } from './box.ts';
import { type AvatarLook, centeredSquare, readAvatarLook, SQUARE, squareIn } from './avatar-look.ts';
import type { Layer, Scene } from './relay.ts';
import { looseBox, visibleBox } from './model-frame.ts';

export interface Source {
  id: string;
  kind: 'camera' | 'screen' | 'image' | 'avatar';
  label: string;
  slot?: number;
  asset?: number;
  ratio?: number;
  box: Box;
  shown: boolean;
  fit?: Fit;
  look?: AvatarLook;
  waiting?: boolean;
}

export const FULL: Box = { x: 0, y: 0, w: 1, h: 1 };
export const AVATAR_ID = 'me';
export const CORNER: Box = { x: 0.73, y: 0.714, w: 0.25, h: 0.25 };
const SECOND_SCREEN: Box = { x: 0.02, y: 0.631, w: 0.333, h: 0.333 };
const THIRD_SCREEN: Box = { x: 0.647, y: 0.036, w: 0.333, h: 0.333 };
const IMAGE_W = 0.3;
const IMAGE_MAX_H = 0.6;

export const layerOf = (s: Source): Layer =>
  s.kind === 'image'
    ? { id: s.id, kind: 'image', asset: s.asset ?? 0, ...visibleBox(s.box) }
    : s.kind === 'avatar'
      ? { id: s.id, kind: 'avatar', ...(s.look && { look: s.look }), ...visibleBox(s.box) }
      : { id: s.id, kind: s.kind, slot: s.slot ?? 0, ...(s.fit && { fit: s.fit }), ...visibleBox(s.box) };

export const isVideoSource = (s: Source) => s.kind === 'camera' || s.kind === 'screen';

export const sceneOf = (sources: readonly Source[]): Scene => ({ layers: sources.filter((s) => s.shown).map(layerOf) });

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function movedBox(box: Box, dx: number, dy: number): Box {
  return clampBox({ ...box, x: box.x + dx, y: box.y + dy });
}

export function resizedBox(box: Box, sx: number, sy: number, dx: number, dy: number, ratio: number | null): Box {
  const fx = sx < 0 ? box.x + box.w : box.x;
  const fy = sy < 0 ? box.y + box.h : box.y;
  const roomX = sx < 0 ? fx : 1 - fx;
  const roomY = sy < 0 ? fy : 1 - fy;
  let w: number;
  let h: number;
  if (ratio) {
    const byX = sx * dx;
    const byY = sy * dy * ratio;
    const pull = Math.abs(byX) >= Math.abs(byY) ? byX : byY;
    w = clamp(box.w + pull, LAYER_MIN, Math.max(LAYER_MIN, Math.min(roomX, roomY * ratio)));
    h = w / ratio;
  } else {
    w = clamp(box.w + sx * dx, LAYER_MIN, Math.max(LAYER_MIN, roomX));
    h = clamp(box.h + sy * dy, LAYER_MIN, Math.max(LAYER_MIN, roomY));
  }
  return clampBox({ x: sx < 0 ? fx - w : fx, y: sy < 0 ? fy - h : fy, w, h });
}

export function fittedBox(box: Box, ratio: number | null): Box {
  if (!ratio) return clampBox(box);
  let w = clamp(box.w, LAYER_MIN, 1);
  let h = w / ratio;
  if (h > 1) {
    h = 1;
    w = ratio;
  }
  return clampBox({ x: box.x, y: box.y, w, h });
}

export function imageBox(ratio: number): Box {
  let w = IMAGE_W;
  let h = w / ratio;
  if (h > IMAGE_MAX_H) {
    h = IMAGE_MAX_H;
    w = h * ratio;
  }
  return clampBox({ x: (1 - w) / 2, y: (1 - h) / 2, w, h });
}

export const ratioOf = (naturalWidth: number, naturalHeight: number) => thousandth((naturalWidth / Math.max(1, naturalHeight)) * (9 / 16));

export type Role = 'camera' | 'screen1' | 'screen2' | 'screen3';
export type PresetBox = Box & { role: Role; fit?: Fit };
export interface Preset {
  name: string;
  boxes: PresetBox[];
}

const SCREEN_AND_FACE: Preset = {
  name: 'screen + face',
  boxes: [
    { role: 'screen1', ...FULL },
    { role: 'camera', ...CORNER }
  ]
};
const ROLES: readonly Role[] = ['camera', 'screen1', 'screen2', 'screen3'];

export function roleOf(source: Source, sources: readonly Source[]): Role | null {
  if (source.kind === 'camera') return 'camera';
  if (source.kind === 'avatar') return sources.some((s) => s.kind === 'camera') ? null : 'camera';
  if (source.kind !== 'screen') return null;
  const screens = sources.filter((s) => s.kind === 'screen').sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0));
  const rank = screens.findIndex((s) => s.id === source.id);
  return rank >= 0 && rank < 3 ? (`screen${rank + 1}` as Role) : null;
}

const laidOut = (sources: readonly Source[]): Source[] => sources.filter((s) => roleOf(s, sources) !== null);

function applyPreset(sources: readonly Source[], preset: Preset): Source[] {
  const videos = laidOut(sources);
  const placed: Source[] = [];
  for (const b of preset.boxes) {
    const source = videos.find((v) => roleOf(v, sources) === b.role && !placed.some((p) => p.id === v.id));
    if (!source) continue;
    const box = { x: b.x, y: b.y, w: b.w, h: b.h };
    placed.push({ ...source, box: source.kind === 'avatar' ? squareIn(box) : box, fit: b.fit });
  }
  const rest = videos.filter((v) => !placed.some((p) => p.id === v.id)).map((v) => ({ ...v, shown: false }));
  const lowest = sources.findIndex((s) => videos.includes(s));
  const decor = sources.filter((s) => !videos.includes(s));
  const under = decor.filter((s) => lowest >= 0 && sources.indexOf(s) < lowest);
  const above = decor.filter((s) => !under.includes(s));
  return [...under, ...placed, ...rest, ...above];
}

export function presetOf(name: string, sources: readonly Source[]): Preset {
  const boxes: PresetBox[] = [];
  for (const s of sources) {
    const role = roleOf(s, sources);
    if (!s.shown || !role) continue;
    boxes.push({ role, ...s.box, ...(s.fit && { fit: s.fit }) });
  }
  return { name, boxes };
}

export function validPreset(raw: unknown): Preset | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 32 || !Array.isArray(p.boxes)) return null;
  const boxes: PresetBox[] = [];
  for (const entry of p.boxes.slice(0, 8)) {
    if (!entry || typeof entry !== 'object') continue;
    const b = entry as Record<string, unknown>;
    if (!ROLES.includes(b.role as Role)) continue;
    if (![b.x, b.y, b.w, b.h].every((v) => typeof v === 'number' && Number.isFinite(v))) continue;
    const box = clampBox({ x: b.x as number, y: b.y as number, w: b.w as number, h: b.h as number });
    const fit = b.fit === 'cover' || b.fit === 'contain' ? b.fit : undefined;
    boxes.push({ role: b.role as Role, ...box, ...(fit && { fit }) });
  }
  return { name: p.name.trim(), boxes };
}

const fullFor = (s: Source): Box => (s.kind === 'avatar' ? centeredSquare(FULL) : FULL);

export function arrangedAfterAdd(sources: readonly Source[], added: Source, last: Preset | null): Source[] {
  const videos = laidOut(sources);
  if (!videos.some((v) => v.id === added.id)) return sources.map((s) => (s.id === added.id ? { ...s, box: imageBox(SQUARE), shown: true } : s));
  if (videos.length === 1) return sources.map((s) => (s.id === added.id ? { ...s, box: fullFor(s), shown: true } : s));
  if (videos.length === 2 && added.kind === 'screen') {
    return applyPreset(sources, last && last.boxes.some((b) => b.role === 'screen1') ? last : SCREEN_AND_FACE);
  }
  const role = roleOf(added, sources);
  const box = role === 'screen2' ? SECOND_SCREEN : role === 'screen3' ? THIRD_SCREEN : added.kind === 'avatar' ? squareIn(CORNER) : CORNER;
  return sources.map((s) => (s.id === added.id ? { ...s, box, shown: true } : s));
}

export function arrangedAfterRemove(sources: readonly Source[]): Source[] {
  const videos = laidOut(sources);
  if (videos.length !== 1) return [...sources];
  return sources.map((s) => (videos.includes(s) ? { ...s, box: fullFor(s) } : s));
}

export function soloed(sources: readonly Source[]): Source[] {
  const face = sources.find((s) => roleOf(s, sources) === 'camera');
  if (!face) return [...sources];
  const at = sources.indexOf(face);
  const alone = face.kind === 'avatar';
  return sources.map((s, i) =>
    s === face ? { ...s, box: fullFor(s), shown: true, fit: s.kind === 'camera' ? 'cover' : s.fit } : alone || i > at ? { ...s, shown: false } : s
  );
}

export interface KeptSource {
  box: Box;
  shown: boolean;
  fit?: Fit;
  look?: AvatarLook;
}
export type KeptScene = Record<string, KeptSource>;

export function keptOf(sources: readonly Source[]): KeptScene {
  return Object.fromEntries(sources.map((s) => [s.id, { box: s.box, shown: s.shown, ...(s.fit && { fit: s.fit }), ...(s.look && { look: s.look }) }]));
}

export function readKept(raw: unknown): KeptScene | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const kept: KeptScene = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    const k = value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
    const b = k?.box as Partial<Box> | undefined;
    if (!k || !b || ![b.x, b.y, b.w, b.h].every((n) => typeof n === 'number' && Number.isFinite(n))) continue;
    const look = readAvatarLook(k.look);
    kept[id] = { box: looseBox(b as Box), shown: k.shown !== false, ...((k.fit === 'cover' || k.fit === 'contain') && { fit: k.fit }), ...(look && { look }) };
  }
  return kept;
}

export function arrivedFrom(kept: KeptScene, before: readonly Source[], next: Source[]): Source[] {
  const came = next.some((s) => kept[s.id] && !before.some((b) => b.id === s.id));
  if (!came) return next;
  return next.map((s) => {
    const was = before.find((b) => b.id === s.id);
    const k = was ?? kept[s.id];
    return k ? { ...s, box: k.box, shown: k.shown, fit: k.fit, ...(k.look && { look: k.look }) } : s;
  });
}

export function restoredFrom(kept: KeptScene, before: readonly Source[], next: readonly Source[]): Source[] {
  return next.map((s) => {
    const k = kept[s.id];
    return k && !before.some((b) => b.id === s.id) ? { ...s, box: k.box, shown: k.shown, fit: k.fit, ...(k.look && { look: k.look }) } : s;
  });
}
