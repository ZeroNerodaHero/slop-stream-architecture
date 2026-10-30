/**
 * The streamer's frame as numbers (docs/screen.md): the sources they can put on the stream,
 * the boxes those sit in, and the arithmetic of moving, resizing and arranging them. Pure: no
 * atoms, no store, no dom. publish-atoms.ts owns the state and calls in here; SceneView draws
 * the result on both sides from the same fractions.
 */

import { type Box, clampBox, type Fit, LAYER_MIN, type Layer, type Scene, thousandth } from '@/infra/relay';

/**
 * One thing the streamer can put on the stream: the camera, a shared screen, an uploaded
 * picture, their avatar (the profile picture, moving with the voice: the face of a mic-only
 * stream). Its box is kept whether or not it is on the stream, so the eye brings it back where
 * it was. The list is in z-order, bottom first; a source on the stream is a layer of the scene.
 */
export interface Source {
  /** Short and plain: `cam`, `s1`..`s3` (the wire slot), `i<n>`, `me` (the avatar). The layer's id on the wire. */
  id: string;
  kind: 'camera' | 'screen' | 'image' | 'avatar';
  label: string;
  /** A video source: its wire slot. The camera is 0, the screens 1 to 3. */
  slot?: number;
  /** A picture: the api asset under the stream's name. */
  asset?: number;
  /** A picture: its box's width over its height, in fractions of the frame, which a resize keeps. */
  ratio?: number;
  box: Box;
  /** On the stream. Off, a video source is a tile for watchers and a picture is only in the list. */
  shown: boolean;
  fit?: Fit;
}

/** The whole frame. */
export const FULL: Box = { x: 0, y: 0, w: 1, h: 1 };
/** The avatar's id. One avatar: it is the streamer's own picture. Its box is laid out like the camera's; the square picture sits centred in it. */
export const AVATAR_ID = 'me';
/** Bottom right, a quarter wide, the same gap at the side (2% of the width) and the bottom (2% of the width is 3.6% of the height). */
export const CORNER: Box = { x: 0.73, y: 0.714, w: 0.25, h: 0.25 };
/** Where a second and a third screen land when they are added to a scene that already has two pictures: bottom left, top right, a third wide. */
const SECOND_SCREEN: Box = { x: 0.02, y: 0.631, w: 0.333, h: 0.333 };
const THIRD_SCREEN: Box = { x: 0.647, y: 0.036, w: 0.333, h: 0.333 };
/** A picture arrives this wide, centred, no taller than this. */
const IMAGE_W = 0.3;
const IMAGE_MAX_H = 0.6;
/** The avatar beside a camera arrives like a picture of its own shape: a square, 9/16 as wide as it is tall on the frame. */
const AVATAR_BOX_RATIO = 9 / 16;

export const layerOf = (s: Source): Layer =>
  s.kind === 'image'
    ? { id: s.id, kind: 'image', asset: s.asset ?? 0, ...s.box }
    : s.kind === 'avatar'
      ? { id: s.id, kind: 'avatar', ...s.box }
      : { id: s.id, kind: s.kind, slot: s.slot ?? 0, ...(s.fit && { fit: s.fit }), ...s.box };

/** The camera or a screen: a source that is a video slot on the wire. */
export const isVideoSource = (s: Source) => s.kind === 'camera' || s.kind === 'screen';

/** The scene the watchers get: the sources on the stream, bottom first. */
export const sceneOf = (sources: readonly Source[]): Scene => ({ layers: sources.filter((s) => s.shown).map(layerOf) });

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// ---- geometry: fractions in, fractions out -----------------------------------------------------

/** Slid by `dx`,`dy` of the frame, stopped at the frame's edges. The size does not change. */
export function movedBox(box: Box, dx: number, dy: number): Box {
  return clampBox({ ...box, x: box.x + dx, y: box.y + dy });
}

/**
 * A corner pulled by `dx`,`dy` of the frame. `sx`,`sy` say which corner (-1 left or top, 1
 * right or bottom): the opposite corner stays put, and the box grows no further than the frame
 * has room on the pulled side. With `ratio` (the box's width over its height) the shape is kept:
 * the pull along whichever axis the pointer travelled further decides.
 */
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

/** The same box inside the frame, its shape set by `ratio` when there is one (a picture): as wide as asked, no taller than the frame. */
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

/** Where a new picture goes: centred, `IMAGE_W` wide with its own shape, or `IMAGE_MAX_H` tall when that is taller. */
export function imageBox(ratio: number): Box {
  let w = IMAGE_W;
  let h = w / ratio;
  if (h > IMAGE_MAX_H) {
    h = IMAGE_MAX_H;
    w = h * ratio;
  }
  return clampBox({ x: (1 - w) / 2, y: (1 - h) / 2, w, h });
}

/** A picture's `ratio` from its natural size: the frame is 16:9, so a square picture's box is 9/16 as wide as it is tall. */
export const ratioOf = (naturalWidth: number, naturalHeight: number) => thousandth((naturalWidth / Math.max(1, naturalHeight)) * (9 / 16));

// ---- presets: geometry by role, so one applies to whatever sources there are --------------------

/** The camera, and the screens by their rank among the live screens (slot order). */
export type Role = 'camera' | 'screen1' | 'screen2' | 'screen3';
export type PresetBox = Box & { role: Role; fit?: Fit };
/** An arrangement, bottom first. A role not listed is off the stream. Pictures are not in a preset: they stay where they are. */
export interface Preset {
  name: string;
  boxes: PresetBox[];
}

export const PRESETS: readonly Preset[] = [
  { name: 'face', boxes: [{ role: 'camera', ...FULL }] },
  { name: 'screen', boxes: [{ role: 'screen1', ...FULL }] },
  {
    name: 'screen + face',
    boxes: [
      { role: 'screen1', ...FULL },
      { role: 'camera', ...CORNER }
    ]
  },
  {
    name: 'face + screen',
    boxes: [
      { role: 'camera', ...FULL },
      { role: 'screen1', x: 0.647, y: 0.631, w: 0.333, h: 0.333 }
    ]
  },
  {
    name: 'side by side',
    boxes: [
      { role: 'screen1', x: 0, y: 0.25, w: 0.5, h: 0.5 },
      { role: 'camera', x: 0.5, y: 0.25, w: 0.5, h: 0.5 }
    ]
  },
  {
    name: 'three up',
    boxes: [
      { role: 'screen1', x: 0, y: 0.167, w: 0.667, h: 0.667 },
      { role: 'camera', x: 0.667, y: 0.167, w: 0.333, h: 0.333 },
      { role: 'screen2', x: 0.667, y: 0.5, w: 0.333, h: 0.333 }
    ]
  }
];
/** Saved presets this browser keeps, at most. */
export const MAX_SAVED_PRESETS = 12;
const ROLES: readonly Role[] = ['camera', 'screen1', 'screen2', 'screen3'];

/**
 * The role a source plays: the camera, or the n-th screen by slot. The avatar is the face of a
 * stream with no camera, so it is the camera's role then (`face`, `screen + face` and the rules
 * lay a mic-only stream out like any other); beside a camera it has none. A picture has none.
 */
export function roleOf(source: Source, sources: readonly Source[]): Role | null {
  if (source.kind === 'camera') return 'camera';
  if (source.kind === 'avatar') return sources.some((s) => s.kind === 'camera') ? null : 'camera';
  if (source.kind !== 'screen') return null;
  const screens = sources.filter((s) => s.kind === 'screen').sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0));
  const rank = screens.findIndex((s) => s.id === source.id);
  return rank >= 0 && rank < 3 ? (`screen${rank + 1}` as Role) : null;
}

/** The roles present: a preset whose roles are all here is whole; the strip dims the others. */
export const rolesOf = (sources: readonly Source[]): Set<Role> => new Set(sources.map((s) => roleOf(s, sources)).filter((r): r is Role => r !== null));

/** The sources the rules and the presets lay out: those with a role. The rest (a picture, the avatar beside a camera) stay where they are put. */
const laidOut = (sources: readonly Source[]): Source[] => sources.filter((s) => roleOf(s, sources) !== null);

/**
 * The preset laid onto the sources. Its layers replace the ones there, in its order; a role
 * with no source is skipped; a source with a role it does not list goes off the stream, its box
 * kept. `reveal` (a click on the strip) puts the listed sources on the stream even if they were
 * off; without it (the rules below) a source the streamer took off stays off and only boxes
 * change. Pictures (and the avatar beside a camera) keep their boxes and their place: those
 * under the lowest placed source stay under (a background), the rest stay above (a border, a logo).
 */
export function applyPreset(sources: readonly Source[], preset: Preset, reveal: boolean): Source[] {
  const videos = laidOut(sources);
  const placed: Source[] = [];
  for (const b of preset.boxes) {
    const source = videos.find((v) => roleOf(v, sources) === b.role && !placed.some((p) => p.id === v.id));
    if (!source) continue;
    placed.push({ ...source, box: { x: b.x, y: b.y, w: b.w, h: b.h }, fit: b.fit, shown: reveal || source.shown });
  }
  const rest = videos.filter((v) => !placed.some((p) => p.id === v.id)).map((v) => ({ ...v, shown: false }));
  const lowest = sources.findIndex((s) => videos.includes(s));
  const decor = sources.filter((s) => !videos.includes(s));
  const under = decor.filter((s) => lowest >= 0 && sources.indexOf(s) < lowest);
  const above = decor.filter((s) => !under.includes(s));
  return [...under, ...placed, ...rest, ...above];
}

/** The arrangement on the stream right now as a preset: every video source on it, in order, by role. */
export function presetOf(name: string, sources: readonly Source[]): Preset {
  const boxes: PresetBox[] = [];
  for (const s of sources) {
    const role = roleOf(s, sources);
    if (!s.shown || !role) continue;
    boxes.push({ role, ...s.box, ...(s.fit && { fit: s.fit }) });
  }
  return { name, boxes };
}

/** A preset from anything (localstorage), or `null`. */
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

// ---- the rules: what happens to the frame when a source comes or goes -------------------------

/**
 * A source with a role was added (the camera, a screen, the avatar as the face). One picture
 * alone fills the frame. The first screen beside the face makes `screen + face`, or the
 * arrangement this browser last had for a screen and the face (`last`). A third or later picture
 * takes a corner of its own and moves nothing else: the streamer is in another tab picking the
 * share, and a reflow then is a jump nobody asked for (`three up` is one click away). The avatar
 * added beside a camera has no role: it arrives centred, like a picture.
 */
export function arrangedAfterAdd(sources: readonly Source[], added: Source, last: Preset | null): Source[] {
  const videos = laidOut(sources);
  if (!videos.some((v) => v.id === added.id)) return sources.map((s) => (s.id === added.id ? { ...s, box: imageBox(AVATAR_BOX_RATIO), shown: true } : s));
  if (videos.length === 1) return sources.map((s) => (s.id === added.id ? { ...s, box: FULL, shown: true } : s));
  if (videos.length === 2 && added.kind === 'screen') {
    const preset = last && last.boxes.some((b) => b.role === 'screen1') ? last : PRESETS.find((p) => p.name === 'screen + face');
    return preset ? applyPreset(sources, preset, false) : [...sources];
  }
  const role = roleOf(added, sources);
  const box = role === 'screen2' ? SECOND_SCREEN : role === 'screen3' ? THIRD_SCREEN : CORNER;
  return sources.map((s) => (s.id === added.id ? { ...s, box, shown: true } : s));
}

/** A source with a role went. One left fills the frame; otherwise nothing moves (a hole is the streamer's to fix with one click). */
export function arrangedAfterRemove(sources: readonly Source[]): Source[] {
  const videos = laidOut(sources);
  if (videos.length !== 1) return [...sources];
  return sources.map((s) => (videos.includes(s) ? { ...s, box: FULL } : s));
}
