type Drawable = HTMLVideoElement | HTMLCanvasElement | HTMLImageElement;

function sizeOf(el: Drawable): [number, number] {
  if (el instanceof HTMLVideoElement) return el.readyState >= 2 ? [el.videoWidth, el.videoHeight] : [0, 0];
  if (el instanceof HTMLImageElement) return el.complete ? [el.naturalWidth, el.naturalHeight] : [0, 0];
  return [el.width, el.height];
}

function seen(el: Element): boolean {
  if (typeof el.checkVisibility === 'function') return el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
  const css = getComputedStyle(el);
  return css.display !== 'none' && css.visibility !== 'hidden' && Number(css.opacity) > 0;
}

export async function frameOf(root: HTMLElement, width = 1920, height = 1080): Promise<Blob | null> {
  const frame = root.getBoundingClientRect();
  if (frame.width < 1 || frame.height < 1) return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingQuality = 'high';
  const sx = width / frame.width;
  const sy = height / frame.height;
  let drew = 0;
  for (const el of root.querySelectorAll<Drawable>('video, canvas, img')) {
    const r = el.getBoundingClientRect();
    const [nw, nh] = sizeOf(el);
    if (r.width < 2 || r.height < 2 || !nw || !nh || !seen(el)) continue;
    const x = (r.left - frame.left) * sx;
    const y = (r.top - frame.top) * sy;
    const w = r.width * sx;
    const h = r.height * sy;
    const fit = getComputedStyle(el).objectFit;
    const scale = fit === 'cover' ? Math.max(w / nw, h / nh) : fit === 'contain' ? Math.min(w / nw, h / nh) : 0;
    const dw = scale ? nw * scale : w;
    const dh = scale ? nh * scale : h;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    try {
      ctx.drawImage(el, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
      drew++;
    } catch {}
    ctx.restore();
  }
  if (!drew) return null;
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.92);
    } catch {
      resolve(null);
    }
  });
}
