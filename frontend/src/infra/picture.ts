export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PictureSpec {
  title: string;
  where: string;
  size: { width: number; height: number } | null;
  qualities: readonly number[];
  type?: 'image/png';
  max: number;
  stored?: { width: number; height: number; type: string };
}

export const EMOTE_PICTURE: PictureSpec = {
  title: 'a new emote',
  where: 'in the chat, the channels and messages, for everyone in the group',
  size: { width: 128, height: 128 },
  qualities: [1],
  type: 'image/png',
  max: 512 * 1024,
  stored: { width: 128, height: 128, type: 'image/webp' }
};

export const GROUP_ICON: PictureSpec = {
  title: "the group's picture",
  where: 'on the group, its card, and the list on home',
  size: { width: 256, height: 256 },
  qualities: [0.85],
  max: 256 * 1024
};

export const GROUP_BANNER: PictureSpec = {
  title: "the group's banner",
  where: 'across the top of the group',
  size: { width: 2560, height: 640 },
  qualities: [0.8, 0.7, 0.6],
  max: 1024 * 1024
};

export const AVATAR_PICTURE: PictureSpec = {
  title: 'your picture',
  where: 'beside your name, and in the preview of your link',
  size: { width: 256, height: 256 },
  qualities: [0.85],
  max: 256 * 1024,
  stored: { width: 96, height: 96, type: 'image/jpeg' }
};

export const THUMB_PICTURE: PictureSpec = {
  title: 'a thumbnail',
  where: 'your card on home, until that page is refreshed',
  size: { width: 960, height: 540 },
  qualities: [0.8, 0.7],
  max: 256 * 1024
};

export const OFFLINE_PICTURE: PictureSpec = {
  title: 'the offline picture',
  where: 'where the player would be while you are not live, and in the preview of your link then',
  size: { width: 1920, height: 1080 },
  qualities: [0.8, 0.7, 0.6],
  max: 1024 * 1024
};

export const SCENE_PICTURE: PictureSpec = {
  title: 'a picture for the stream',
  where: 'a layer over the camera, at its own shape',
  size: null,
  qualities: [0.92, 0.85, 0.75, 0.6],
  max: 2 * 1024 * 1024
};

export function aspectOf(spec: PictureSpec): number | null {
  return spec.size ? spec.size.width / spec.size.height : null;
}

export const MAX_ZOOM = 4;

export function minSide(width: number, height: number): number {
  return Math.max(8, Math.min(width, height) * 0.02);
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

function smallest(aspect: number | null, min: number): { w: number; h: number } {
  if (aspect === null) return { w: min, h: min };
  const w = Math.max(min, min * aspect);
  return { w, h: w / aspect };
}

export function centredRect(width: number, height: number, aspect: number | null): Rect {
  if (aspect === null) return { x: 0, y: 0, w: width, h: height };
  const w = Math.min(width, height * aspect);
  const h = w / aspect;
  return { x: (width - w) / 2, y: (height - h) / 2, w, h };
}

export function movedRect(rect: Rect, dx: number, dy: number, width: number, height: number): Rect {
  return { ...rect, x: clamp(rect.x + dx, 0, width - rect.w), y: clamp(rect.y + dy, 0, height - rect.h) };
}

export function scaleOf(rect: Rect, width: number, height: number): number {
  return Math.max(rect.w / width, rect.h / height);
}

export function zoomOf(rect: Rect, width: number, height: number): number {
  return 1 / scaleOf(rect, width, height);
}

export function minScale(width: number, height: number, aspect: number | null): number {
  const f = smallest(aspect, minSide(width, height));
  return Math.max(f.w / width, f.h / height, 1 / MAX_ZOOM);
}

export function maxZoom(width: number, height: number, aspect: number | null): number {
  return 1 / minScale(width, height, aspect);
}

export function scaledRect(rect: Rect, factor: number, aspect: number | null, width: number, height: number): Rect {
  const f = smallest(aspect, minSide(width, height));
  const most = Math.min(width / rect.w, height / rect.h);
  const least = Math.max(f.w / rect.w, f.h / rect.h, 1 / (MAX_ZOOM * scaleOf(rect, width, height)));
  const k = clamp(factor, Math.min(least, most), most);
  const w = rect.w * k;
  const h = rect.h * k;
  return movedRect({ x: rect.x + (rect.w - w) / 2, y: rect.y + (rect.h - h) / 2, w, h }, 0, 0, width, height);
}

export function zoomedRect(rect: Rect, zoom: number, aspect: number | null, width: number, height: number): Rect {
  return scaledRect(rect, zoomOf(rect, width, height) / zoom, aspect, width, height);
}

export function cornerRect(from: Rect, sx: number, sy: number, dx: number, dy: number, aspect: number | null, width: number, height: number): Rect {
  const ax = sx < 0 ? from.x + from.w : from.x;
  const ay = sy < 0 ? from.y + from.h : from.y;
  const roomW = sx < 0 ? ax : width - ax;
  const roomH = sy < 0 ? ay : height - ay;
  const f = smallest(aspect, minSide(width, height));
  let w = from.w + sx * dx;
  let h = from.h + sy * dy;
  if (aspect === null) {
    w = clamp(w, Math.min(f.w, roomW), roomW);
    h = clamp(h, Math.min(f.h, roomH), roomH);
    if (Math.max(w / width, h / height) < 1 / MAX_ZOOM) {
      const wide = roomW >= width / MAX_ZOOM && (w / width >= h / height || roomH < height / MAX_ZOOM);
      if (wide) w = width / MAX_ZOOM;
      else h = Math.min(roomH, height / MAX_ZOOM);
    }
  } else {
    if (Math.abs(dx) >= Math.abs(dy) * aspect) h = w / aspect;
    else w = h * aspect;
    const most = Math.min(roomW, roomH * aspect);
    const least = Math.max(f.w, Math.min(width, height * aspect) / MAX_ZOOM);
    w = clamp(w, Math.min(least, most), most);
    h = w / aspect;
  }
  return { x: sx < 0 ? ax - w : ax, y: sy < 0 ? ay - h : ay, w, h };
}

export type Turns = 0 | 1 | 2 | 3;

export function nextTurn(turns: Turns): Turns {
  return ((turns + 1) % 4) as Turns;
}

export function turnedSize(width: number, height: number, turns: Turns): { width: number; height: number } {
  return turns % 2 ? { width: height, height: width } : { width, height };
}

export function turnPoint(p: { x: number; y: number }, width: number, height: number, turns: Turns): { x: number; y: number } {
  let { x, y } = p;
  let [w, h] = [width, height];
  for (let i = 0; i < turns; i++) {
    [x, y] = [h - y, x];
    [w, h] = [h, w];
  }
  return { x, y };
}

export function turnRect(rect: Rect, width: number, height: number, turns: Turns): Rect {
  const a = turnPoint({ x: rect.x, y: rect.y }, width, height, turns);
  const b = turnPoint({ x: rect.x + rect.w, y: rect.y + rect.h }, width, height, turns);
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}

export function sourceRect(rect: Rect, width: number, height: number, turns: Turns): Rect {
  const turned = turnedSize(width, height, turns);
  return turnRect(rect, turned.width, turned.height, ((4 - turns) % 4) as Turns);
}

export function rotatedCrop(rect: Rect, width: number, height: number, aspect: number | null): Rect {
  const turned = turnRect(rect, width, height, 1);
  const [nw, nh] = [height, width];
  if (aspect === null) return movedRect(turned, 0, 0, nw, nh);
  const zoom = clamp(zoomOf(rect, width, height), 1, maxZoom(nw, nh, aspect));
  const fit = centredRect(nw, nh, aspect);
  const w = fit.w / zoom;
  const h = w / aspect;
  const cx = turned.x + turned.w / 2;
  const cy = turned.y + turned.h / 2;
  return movedRect({ x: cx - w / 2, y: cy - h / 2, w, h }, 0, 0, nw, nh);
}

export function drawTransform(turns: Turns, width: number, height: number): [number, number, number, number, number, number] {
  if (turns === 1) return [0, 1, -1, 0, width, 0];
  if (turns === 2) return [-1, 0, 0, -1, width, height];
  if (turns === 3) return [0, -1, 1, 0, 0, height];
  return [1, 0, 0, 1, 0, 0];
}

export function isWhole(rect: Rect, width: number, height: number): boolean {
  return rect.x <= 0.5 && rect.y <= 0.5 && rect.x + rect.w >= width - 0.5 && rect.y + rect.h >= height - 0.5;
}

export function wholePixels(rect: Rect, width: number, height: number): Rect {
  const x = clamp(Math.round(rect.x), 0, width - 1);
  const y = clamp(Math.round(rect.y), 0, height - 1);
  return { x, y, w: clamp(Math.round(rect.w), 1, width - x), h: clamp(Math.round(rect.h), 1, height - y) };
}

export function outputSize(spec: PictureSpec, rect: Rect, width: number, height: number): { width: number; height: number } {
  if (spec.size) return spec.size;
  const r = wholePixels(rect, width, height);
  return { width: r.w, height: r.h };
}

export function assetType(file: Blob): string {
  return file.type === 'image/jpeg' || file.type === 'image/webp' ? file.type : 'image/png';
}

export function formatWord(type: string): string {
  return type === 'image/jpeg' ? 'jpeg' : type === 'image/webp' ? 'webp' : type === 'image/gif' ? 'gif' : 'png';
}

function drawScaled(source: CanvasImageSource, sx: number, sy: number, sw: number, sh: number, width: number, height: number, turns: Turns = 0): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no canvas');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const local = turnedSize(width, height, turns);
  ctx.setTransform(...drawTransform(turns, width, height));
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, local.width, local.height);
  return canvas;
}

export async function cutPicture(picture: ImageBitmap, rect: Rect, width: number, height: number, type: string, quality?: number, turns: Turns = 0): Promise<Blob> {
  let source: CanvasImageSource = picture;
  let { x, y, w, h } = rect;
  const local = turnedSize(width, height, turns);
  while (w >= local.width * 2 && h >= local.height * 2) {
    const half = drawScaled(source, x, y, w, h, Math.round(w / 2), Math.round(h / 2));
    source = half;
    x = 0;
    y = 0;
    w = half.width;
    h = half.height;
  }
  const canvas = drawScaled(source, x, y, w, h, width, height, turns);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('could not make the picture'))), type, quality);
  });
}

const kb = (bytes: number) => (bytes >= 1024 * 1024 ? `${bytes / (1024 * 1024)} mb` : `${bytes / 1024} kb`);

export function keepsFile(spec: PictureSpec, file: Blob, rect: Rect, width: number, height: number, turns: Turns): boolean {
  return !spec.size && turns === 0 && isWhole(rect, width, height) && file.size <= spec.max;
}

export async function pictureFor(spec: PictureSpec, file: Blob, picture: ImageBitmap, rect: Rect, turns: Turns = 0): Promise<Blob> {
  const { width, height } = turnedSize(picture.width, picture.height, turns);
  if (spec.size) {
    const type = spec.type ?? 'image/jpeg';
    const from = sourceRect(rect, picture.width, picture.height, turns);
    for (const quality of type === 'image/png' ? [undefined] : spec.qualities) {
      const cut = await cutPicture(picture, from, spec.size.width, spec.size.height, type, quality, turns);
      if (cut.size <= spec.max) return cut;
    }
    throw new Error(`too much detail for ${kb(spec.max)}. try a plainer picture`);
  }
  if (keepsFile(spec, file, rect, width, height, turns)) return file;
  const r = wholePixels(rect, width, height);
  const from = sourceRect(r, picture.width, picture.height, turns);
  const type = assetType(file);
  for (const quality of type === 'image/png' ? [undefined] : spec.qualities) {
    const cut = await cutPicture(picture, from, r.w, r.h, type, quality, turns);
    if (cut.size <= spec.max) return cut;
  }
  throw new Error(`over ${kb(spec.max)} as a ${formatWord(type)}. try a smaller part`);
}

const CHAT_LINE_PX = 24;
const CHAT_LINES = 5;
const CHAT_MAX_H = CHAT_LINE_PX * CHAT_LINES * 2;
const CHAT_MAX_W = 640;
const CHAT_MAX_BYTES = 256 * 1024;

export async function compressChatImage(file: Blob): Promise<Blob> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('not a picture');
  }
  try {
    const scale = Math.min(1, CHAT_MAX_W / bitmap.width, CHAT_MAX_H / bitmap.height);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const rect = { x: 0, y: 0, w: bitmap.width, h: bitmap.height };
    const webp = await chatWebp(bitmap, rect, width, height);
    if (webp) return webp;
    for (const quality of [0.8, 0.6, 0.45]) {
      const jpeg = await cutPicture(bitmap, rect, width, height, 'image/jpeg', quality);
      if (jpeg.size <= CHAT_MAX_BYTES) return jpeg;
    }
    throw new Error('that picture is too big');
  } finally {
    bitmap.close();
  }
}

async function chatWebp(bitmap: ImageBitmap, rect: Rect, width: number, height: number): Promise<Blob | null> {
  try {
    for (const quality of [0.8, 0.66, 0.5, 0.35]) {
      const blob = await cutPicture(bitmap, rect, width, height, 'image/webp', quality);
      if (blob.type && blob.type !== 'image/webp') return null;
      if (blob.size <= CHAT_MAX_BYTES) return blob.type === 'image/webp' ? blob : null;
    }
    return null;
  } catch {
    return null;
  }
}
