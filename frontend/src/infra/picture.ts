/**
 * A picture before it goes anywhere. Every picture the pages put up (the profile picture, a
 * thumbnail, the offline picture, a picture for the scene) is picked as a file and then cut in
 * the crop dialog (CropDialog.tsx): a rectangle of the shape the upload wants sits over the
 * picture, is moved and scaled by hand, and what is inside it is what goes up, drawn at the
 * size the api wants and encoded here. So the api never decodes an image (profile.rs); it
 * checks the first bytes and the size, and puts the bytes in the bucket as they came.
 *
 * This file is the geometry (the rectangle, kept inside the picture and in shape) and the cut
 * itself. The dialog draws it; `crop-atoms.ts` opens it.
 */

/** A rectangle of the picture, in the picture's own pixels. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What one upload wants of a picture. */
export interface PictureSpec {
  /** The dialog's title. */
  title: string;
  /** Where the picture shows, for the line under the title. */
  where: string;
  /**
   * The output, a jpeg of exactly this size: the rectangle keeps its shape. `null`: the scene's
   * picture, which goes up at its own pixels in its own format (png, jpeg or webp), any shape;
   * the whole of it is the file itself, untouched.
   */
  size: { width: number; height: number } | null;
  /** Jpeg (and webp) qualities, tried in order until the bytes are under `max`. */
  qualities: readonly number[];
  /** The api's ceiling for the bytes, which the route stops reading at. */
  max: number;
}

/** 256x256 at `groups/<name>/icon.jpg`. The group's picture, square, like an avatar. */
export const GROUP_ICON: PictureSpec = {
  title: "the group's picture",
  where: 'on the group, its card, and the list on home',
  size: { width: 256, height: 256 },
  qualities: [0.85],
  max: 256 * 1024
};

/**
 * 2560x640 at `groups/<name>/banner.jpg`. A wide strip across the top of the group, the room's
 * whole width: a 1280 one was stretched over twice its pixels on a sharp screen.
 */
export const GROUP_BANNER: PictureSpec = {
  title: "the group's banner",
  where: 'across the top of the group',
  size: { width: 2560, height: 640 },
  qualities: [0.8, 0.7, 0.6],
  max: 1024 * 1024
};

/** 256x256 at `avatars/<id>.jpg`. The page shows it at 40px, the preview card of a link bigger. */
export const AVATAR_PICTURE: PictureSpec = {
  title: 'your picture',
  where: 'beside your name, and in the preview of your link',
  size: { width: 256, height: 256 },
  qualities: [0.85],
  max: 256 * 1024
};

/**
 * 960x540, one of up to six on the card on home: a card is 280px and up, a featured one half the
 * page, on screens with two pixels to the point. The avatar's ceiling: the routes share a body
 * limit, so a busy photo steps down once to fit.
 */
export const THUMB_PICTURE: PictureSpec = {
  title: 'a thumbnail',
  where: 'your card on home, until that page is refreshed',
  size: { width: 960, height: 540 },
  qualities: [0.8, 0.7],
  max: 256 * 1024
};

/**
 * 1920x1080 where the player would be while the name is not live: the player's own size, so it
 * is not blown up on a desktop. A photo at 0.8 can run past its ceiling, so the quality steps
 * down, and stops at 0.6: softer than that is blocks, and the dialog asks for a plainer picture.
 */
export const OFFLINE_PICTURE: PictureSpec = {
  title: 'the offline picture',
  where: 'where the player would be while you are not live, and in the preview of your link then',
  size: { width: 1920, height: 1080 },
  qualities: [0.8, 0.7, 0.6],
  max: 1024 * 1024
};

/** A layer over the camera (docs/screen.md): up as it is, its holes and its pixels kept. */
export const SCENE_PICTURE: PictureSpec = {
  title: 'a picture for the stream',
  where: 'a layer over the camera, at its own shape',
  size: null,
  qualities: [0.92, 0.85, 0.75, 0.6],
  max: 2 * 1024 * 1024
};

/** The rectangle's shape, width over height. `null`: any. */
export function aspectOf(spec: PictureSpec): number | null {
  return spec.size ? spec.size.width / spec.size.height : null;
}

/** The shortest a side may get, in the picture's pixels: a sliver of a huge picture is still a handle wide on screen. */
export function minSide(width: number, height: number): number {
  return Math.max(8, Math.min(width, height) * 0.02);
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** The smallest the rectangle may be, each way: `min` a side, the shape kept. */
function smallest(aspect: number | null, min: number): { w: number; h: number } {
  if (aspect === null) return { w: min, h: min };
  const w = Math.max(min, min * aspect);
  return { w, h: w / aspect };
}

/** The biggest rectangle of this shape that fits, in the middle: where the box starts. The whole picture for no shape. */
export function centredRect(width: number, height: number, aspect: number | null): Rect {
  if (aspect === null) return { x: 0, y: 0, w: width, h: height };
  const w = Math.min(width, height * aspect);
  const h = w / aspect;
  return { x: (width - w) / 2, y: (height - h) / 2, w, h };
}

/** `rect` moved by (dx, dy) and kept inside the picture. */
export function movedRect(rect: Rect, dx: number, dy: number, width: number, height: number): Rect {
  return { ...rect, x: clamp(rect.x + dx, 0, width - rect.w), y: clamp(rect.y + dy, 0, height - rect.h) };
}

/**
 * How much of the picture the rectangle spans, on the axis it is tighter on: 1 is as big as it
 * gets, the zoom slider's left end. The slider shows `1 / scale`.
 */
export function scaleOf(rect: Rect, width: number, height: number): number {
  return Math.max(rect.w / width, rect.h / height);
}

/** The scale's floor for this picture: the rectangle at `min` a side. */
export function minScale(width: number, height: number, aspect: number | null): number {
  const f = smallest(aspect, minSide(width, height));
  return Math.max(f.w / width, f.h / height);
}

/**
 * `rect` scaled by `factor` about its centre: both sides alike, so the shape is kept. No
 * smaller than the floor, no bigger than fits, and slid back in where the picture's edge is in
 * the way.
 */
export function scaledRect(rect: Rect, factor: number, aspect: number | null, width: number, height: number): Rect {
  const f = smallest(aspect, minSide(width, height));
  const most = Math.min(width / rect.w, height / rect.h);
  const least = Math.max(f.w / rect.w, f.h / rect.h);
  const k = clamp(factor, Math.min(least, most), most);
  const w = rect.w * k;
  const h = rect.h * k;
  return movedRect({ x: rect.x + (rect.w - w) / 2, y: rect.y + (rect.h - h) / 2, w, h }, 0, 0, width, height);
}

/**
 * A corner pulled: `sx`/`sy` say which (-1 is the left or the top), `dx`/`dy` how far. The
 * opposite corner stays. With a shape, the bigger pull wins and the other side follows; the
 * rectangle stops at the floor and at the picture's edge.
 */
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
  } else {
    if (Math.abs(dx) >= Math.abs(dy) * aspect) h = w / aspect;
    else w = h * aspect;
    const most = Math.min(roomW, roomH * aspect);
    w = clamp(w, Math.min(f.w, most), most);
    h = w / aspect;
  }
  return { x: sx < 0 ? ax - w : ax, y: sy < 0 ? ay - h : ay, w, h };
}

/** The rectangle is the whole picture, give or take the half pixel a drag leaves. */
export function isWhole(rect: Rect, width: number, height: number): boolean {
  return rect.x <= 0.5 && rect.y <= 0.5 && rect.x + rect.w >= width - 0.5 && rect.y + rect.h >= height - 0.5;
}

/** The rectangle on whole pixels, inside the picture: a cut at the picture's own pixels copies them, no resampling. */
export function wholePixels(rect: Rect, width: number, height: number): Rect {
  const x = clamp(Math.round(rect.x), 0, width - 1);
  const y = clamp(Math.round(rect.y), 0, height - 1);
  return { x, y, w: clamp(Math.round(rect.w), 1, width - x), h: clamp(Math.round(rect.h), 1, height - y) };
}

/** The size of what goes up for `spec`, as the dialog says it: the output's, or the cut's own pixels. */
export function outputSize(spec: PictureSpec, rect: Rect, width: number, height: number): { width: number; height: number } {
  if (spec.size) return spec.size;
  const r = wholePixels(rect, width, height);
  return { width: r.w, height: r.h };
}

/** Which format the scene's cut keeps: a jpeg stays a jpeg, a webp a webp (png where the browser cannot write one), anything else is a png, holes and all. */
export function assetType(file: Blob): string {
  return file.type === 'image/jpeg' || file.type === 'image/webp' ? file.type : 'image/png';
}

/** The short word for the format, for the line under the picture. */
export function formatWord(type: string): string {
  return type === 'image/jpeg' ? 'jpeg' : type === 'image/webp' ? 'webp' : type === 'image/gif' ? 'gif' : 'png';
}

/** `source`'s rectangle drawn onto a new canvas of `width` x `height`, at the best smoothing the browser has. */
function drawScaled(source: CanvasImageSource, sx: number, sy: number, sw: number, sh: number, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no canvas');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, width, height);
  return canvas;
}

/**
 * `rect` of `picture` drawn at `width` x `height` and encoded as `type`. Shrunk by halves while
 * the cut is still twice the output or more, then the last step: a half is a 2x2 average, which
 * the bilinear filter every browser has gets right, and the last step is under 2x, where a
 * filter has all the pixels. One `drawImage` straight from a 4000px photo to 256 reads four
 * source pixels per output pixel and drops the rest: hair, fabric and text come out aliased,
 * fine detail turns to moiré, edges go jagged, and the picture is worse than the dialog's
 * preview, which the `<img>` scaler shrinks properly. `imageSmoothingQuality` alone fixes it
 * where it is implemented (chrome, safari); the halves do the same where it is not (firefox).
 */
export async function cutPicture(picture: ImageBitmap, rect: Rect, width: number, height: number, type: string, quality?: number): Promise<Blob> {
  let source: CanvasImageSource = picture;
  let { x, y, w, h } = rect;
  while (w >= width * 2 && h >= height * 2) {
    const half = drawScaled(source, x, y, w, h, Math.round(w / 2), Math.round(h / 2));
    source = half;
    x = 0;
    y = 0;
    w = half.width;
    h = half.height;
  }
  const canvas = drawScaled(source, x, y, w, h, width, height);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('could not make the picture'))), type, quality);
  });
}

const kb = (bytes: number) => (bytes >= 1024 * 1024 ? `${bytes / (1024 * 1024)} mb` : `${bytes / 1024} kb`);

/**
 * What goes up for `spec`: the rectangle as a jpeg at the output size, softer until it is under
 * the ceiling; for the scene, the file itself when the rectangle is the whole picture and it
 * fits, else the cut at its own pixels in its own format. Throws, with the reason, when nothing
 * fits under the ceiling: the dialog says it and stays open for a smaller part.
 */
export async function pictureFor(spec: PictureSpec, file: Blob, picture: ImageBitmap, rect: Rect): Promise<Blob> {
  if (spec.size) {
    for (const quality of spec.qualities) {
      const jpeg = await cutPicture(picture, rect, spec.size.width, spec.size.height, 'image/jpeg', quality);
      if (jpeg.size <= spec.max) return jpeg;
    }
    throw new Error(`too much detail for ${kb(spec.max)}. try a plainer picture`);
  }
  if (isWhole(rect, picture.width, picture.height) && file.size <= spec.max) return file;
  const r = wholePixels(rect, picture.width, picture.height);
  const type = assetType(file);
  // a png has no quality: one try. the others get softer
  for (const quality of type === 'image/png' ? [undefined] : spec.qualities) {
    const cut = await cutPicture(picture, r, r.w, r.h, type, quality);
    if (cut.size <= spec.max) return cut;
  }
  throw new Error(`over ${kb(spec.max)} as a ${formatWord(type)}. try a smaller part`);
}

/** How tall a chat picture is drawn: five lines of the panel's text. The file is twice that, for a sharp screen. */
const CHAT_LINE_PX = 24;
const CHAT_LINES = 5;
const CHAT_MAX_H = CHAT_LINE_PX * CHAT_LINES * 2;
const CHAT_MAX_W = 640;
const CHAT_MAX_BYTES = 256 * 1024;

/**
 * A picture for a chat line: shrunk so it is about five lines tall, then webp, softer until it
 * fits. Jpeg when the browser cannot write webp. Profile pictures, group pictures, thumbnails
 * and the offline picture stay jpeg and do not come through here.
 */
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

/** Webp under the ceiling, or null when this browser will not write one (or none of the tries fit). */
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
